#!/usr/bin/env node

/**
 * OpenClaw Task Router Dashboard Server v3
 * Full production dashboard with SSE, auth, 6-page UI support.
 */

const express = require('express');
const path = require('path');
const fs = require('fs').promises;

const app = express();

// ─── Load modules lazily to avoid circular init issues ───────────────
function getRouter()    { return require('./index'); }
function getQueue()     { return require('./queue'); }
function getScheduler() { return require('./scheduler'); }
function getMonitor()   { return require('./monitor'); }
function getLedger()    { return require('./ledger'); }
function getPlanner()   { return require('./planner'); }
function getConfig()    { return JSON.parse(require('fs').readFileSync(path.join(__dirname, 'config.json'), 'utf8')); }
function getShadowBench() { return require('./shadow-bench'); }
// ── Agent 2: Circuit breaker + Dedup + Rate Governor lazy loaders ──
function getCircuitBreaker() { return require('./circuit-breaker'); }
function getDedup()          { return require('./dedup'); }
function getRateGovernor()   { return require('./rate-governor'); }
// ── Agent 3: Session + Warmup lazy loaders ──
function getSession()   { return require('./session'); }
function getWarmup()    { return require('./warmup'); }
// ── Model Registry lazy loader ──
function getModelRegistry() { return require('./model-registry'); }

// ─── SSE Client Management ──────────────────────────────────────────
const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch (_) { sseClients.delete(res); }
  }
}

// Periodic SSE heartbeat + status push
setInterval(async () => {
  if (sseClients.size === 0) return;
  try {
    const status = await getRouter().getStatus();
    broadcast('status', status);
  } catch (_) { /* ignore */ }
}, 5000);

// ─── Middleware ──────────────────────────────────────────────────────
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Auth middleware — cookie-based with token bootstrap
function authMiddleware(req, res, next) {
  // Skip auth for health check
  if (req.path === '/health') return next();

  const config = getConfig();
  const token = config.dashboard?.authToken;

  // If no token configured, allow all requests
  if (!token) return next();

  // Check cookie first
  const cookies = (req.headers.cookie || '').split(';').reduce((acc, c) => {
    const [k, v] = c.trim().split('=');
    if (k && v) acc[k] = v;
    return acc;
  }, {});
  
  if (cookies['oc_dash_auth'] === token) {
    return next();
  }

  // Check query param — if valid, set cookie and redirect to clean URL
  const queryToken = req.query.token;
  if (queryToken === token) {
    res.cookie('oc_dash_auth', token, {
      httpOnly: true,
      secure: false, // Cloudflare tunnel handles HTTPS
      maxAge: 365 * 24 * 60 * 60 * 1000, // 1 year
      sameSite: 'lax'
    });
    // Redirect to clean URL without token
    const cleanUrl = req.originalUrl.split('?')[0];
    return res.redirect(302, cleanUrl || '/');
  }

  // Check Authorization header
  const headerToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (headerToken === token) {
    return next();
  }

  res.status(401).json({ error: 'Unauthorized', message: 'Visit with ?token=YOUR_TOKEN first to authenticate' });
}

app.use(authMiddleware);

// Rate limiting for write endpoints (simple in-memory)
const rateLimits = new Map();
function rateLimit(key, maxPerMinute = 30) {
  const now = Date.now();
  const window = rateLimits.get(key) || [];
  const recent = window.filter(t => now - t < 60000);
  if (recent.length >= maxPerMinute) return false;
  recent.push(now);
  rateLimits.set(key, recent);
  return true;
}

// ─── Health Check (no auth) ─────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), service: 'OpenClaw Router Dashboard v3' });
});

// ─── SSE Stream ─────────────────────────────────────────────────────
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.write('event: connected\ndata: {"status":"ok"}\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ─── Summary Stats ──────────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  try {
    const monitor = getMonitor();
    const ledger = getLedger();
    const config = getConfig();
    if (!monitor.loaded) await monitor.load();
    if (!ledger.loaded) await ledger.load();

    const allResults = Object.values(monitor.data.backends).flatMap(b => b.results);
    const totalTasks = allResults.length;
    const successes = allResults.filter(r => r.success).length;
    const successRate = totalTasks > 0 ? ((successes / totalTasks) * 100) : 0;
    const totalTokens = allResults.reduce((s, r) => s + (r.tokens || 0), 0);

    // Calculate "money saved by subscription"
    const subResults = [
      ...monitor.data.backends.claudeCode.results,
      ...monitor.data.backends.codex.results
    ];
    const savedTokens = subResults.reduce((s, r) => s + (r.tokens || 0), 0);
    const savedUsd = ledger.estimateApiCost(savedTokens);

    res.json({
      totalTasks,
      successRate: Math.round(successRate * 10) / 10,
      totalSpendUsd: Math.round(ledger.data.api.monthlySpendUsd * 100) / 100,
      dailySpendUsd: Math.round(ledger.data.api.dailySpendUsd * 100) / 100,
      dailyBudgetUsd: config.backends.api.dailyBudgetUsd,
      totalTokens,
      savedBySubscriptionUsd: Math.round(savedUsd * 100) / 100,
      activeAlerts: monitor.data.alerts.filter(a => !a.acknowledged).length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Shadow Bench Endpoints ───────────────────────────────────────
app.get('/api/shadow/results', (req, res) => {
  try {
    const shadowBench = getShadowBench();
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : undefined;
    const results = shadowBench.getResults({ limit });
    res.json({ results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/shadow/trust', (req, res) => {
  try {
    const shadowBench = getShadowBench();
    res.json({ trust: shadowBench.getTrust() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/shadow/:id/feedback', (req, res) => {
  if (!rateLimit(req.ip + ':shadow-feedback', 30)) return res.status(429).json({ error: 'Rate limited' });
  try {
    const shadowBench = getShadowBench();
    const { score, comment } = req.body;
    if (typeof score !== 'number') {
      return res.status(400).json({ error: 'score must be a number between 0 and 1' });
    }
    shadowBench.recordFeedback(req.params.id, score, comment || null);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/shadow/insights', (req, res) => {
  try {
    const shadowBench = getShadowBench();
    res.json({ insights: shadowBench.getInsights() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Queue Endpoints ────────────────────────────────────────────────
app.get('/api/queue', async (req, res) => {
  try {
    const queue = getQueue();
    const scheduler = getScheduler();
    if (!queue.loaded) await queue.load();
    if (!scheduler.loaded) await scheduler.load();

    // Combine both queue systems
    const legacyQueue = queue.queue.map(item => ({
      ...item,
      source: 'legacy',
      status: item.scheduledFor && new Date(item.scheduledFor) > new Date() ? 'scheduled' : 'queued'
    }));

    const schedQueue = scheduler.queue.map(item => ({
      ...item,
      source: 'scheduler',
      status: 'queued'
    }));

    const activeItems = [...scheduler.active.values()].map(a => ({
      ...a.item,
      source: 'scheduler',
      status: 'running',
      startedAt: a.startedAt
    }));

    res.json({
      items: [...activeItems, ...legacyQueue, ...schedQueue],
      summary: {
        running: activeItems.length,
        queued: legacyQueue.length + schedQueue.length,
        deadLetters: queue.deadLetters.length,
        schedulerPaused: scheduler.paused,
        schedulerRunning: scheduler.processingTimer !== null
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/queue/:taskId/cancel', async (req, res) => {
  if (!rateLimit(req.ip + ':cancel', 20)) return res.status(429).json({ error: 'Rate limited' });
  try {
    const { taskId } = req.params;
    const scheduler = getScheduler();
    const cancelled = await scheduler.cancel(taskId);
    if (cancelled) {
      broadcast('queue-update', { action: 'cancelled', taskId });
    }
    res.json({ success: cancelled, message: cancelled ? 'Cancelled' : 'Not found' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/queue/:taskId/priority', async (req, res) => {
  if (!rateLimit(req.ip + ':priority', 20)) return res.status(429).json({ error: 'Rate limited' });
  try {
    const { taskId } = req.params;
    const { priority } = req.body; // 'urgent' | 'normal' | 'background'
    const scheduler = getScheduler();
    if (!scheduler.loaded) await scheduler.load();

    const item = scheduler.queue.find(i => i.id === taskId);
    if (!item) return res.status(404).json({ error: 'Task not found in queue' });

    const priorityValues = { urgent: 100, normal: 50, background: 10 };
    item.priority = priorityValues[priority] || 50;
    item.priorityName = priority || 'normal';
    scheduler._sortQueue();
    await scheduler.save();

    broadcast('queue-update', { action: 'reprioritized', taskId, priority });
    res.json({ success: true, taskId, priority: item.priorityName });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Task History ───────────────────────────────────────────────────
app.get('/api/history', async (req, res) => {
  try {
    const monitor = getMonitor();
    const scheduler = getScheduler();
    if (!monitor.loaded) await monitor.load();
    if (!scheduler.loaded) await scheduler.load();

    const { from, to, backend, limit: limitStr } = req.query;
    const limit = parseInt(limitStr) || 100;

    // Combine monitor results with scheduler completed
    let history = [];

    // From monitor (all backends)
    for (const [backendName, stats] of Object.entries(monitor.data.backends)) {
      for (const result of stats.results) {
        history.push({
          timestamp: result.timestamp,
          backend: backendName,
          taskType: result.taskType,
          success: result.success,
          duration: result.duration,
          tokens: result.tokens,
          urgency: result.urgency,
          complexity: result.complexity,
          source: 'monitor'
        });
      }
    }

    // From scheduler completed
    for (const item of scheduler.completed) {
      history.push({
        timestamp: item.completedAt || item.failedAt,
        backend: item.backend,
        taskType: item.task?.type || 'other',
        description: item.task?.description,
        success: !item.finalError,
        duration: item.duration || 0,
        tokens: item.result?.tokens || 0,
        priority: item.priorityName,
        error: item.finalError || null,
        source: 'scheduler'
      });
    }

    // Sort by timestamp descending
    history.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    // Apply filters
    if (from) history = history.filter(h => new Date(h.timestamp) >= new Date(from));
    if (to) history = history.filter(h => new Date(h.timestamp) <= new Date(to));
    if (backend) history = history.filter(h => h.backend === backend);

    // Apply limit
    history = history.slice(0, limit);

    res.json({ items: history, total: history.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Cost Aggregations ──────────────────────────────────────────────
app.get('/api/savings', async (req, res) => {
  try {
    const ledger = getLedger();
    const savings = ledger.getSavings();
    res.json(savings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── User Costs ─────────────────────────────────────────────────────
app.get('/api/users/costs', async (req, res) => {
  try {
    const ledger = getLedger();
    if (!ledger.loaded) await ledger.load();
    const userCosts = ledger.getUserCosts();
    res.json(userCosts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/costs', async (req, res) => {
  try {
    const monitor = getMonitor();
    const ledger = getLedger();
    const config = getConfig();
    if (!monitor.loaded) await monitor.load();
    if (!ledger.loaded) await ledger.load();

    const period = req.query.period || 'day'; // day | week | month
    const now = new Date();
    let cutoff;

    switch (period) {
      case 'day':   cutoff = new Date(now - 24 * 60 * 60 * 1000); break;
      case 'week':  cutoff = new Date(now - 7 * 24 * 60 * 60 * 1000); break;
      case 'month': cutoff = new Date(now - 30 * 24 * 60 * 60 * 1000); break;
      default:      cutoff = new Date(now - 24 * 60 * 60 * 1000);
    }

    // Build daily cost buckets from monitor results
    const dailyCosts = {};
    const backendCosts = { claudeCode: 0, codex: 0, api: 0, local: 0 };

    for (const [backendName, stats] of Object.entries(monitor.data.backends)) {
      for (const result of stats.results) {
        if (new Date(result.timestamp) < cutoff) continue;

        const day = result.timestamp.substring(0, 10); // YYYY-MM-DD
        if (!dailyCosts[day]) dailyCosts[day] = { date: day, api: 0, subscription: 0, total: 0 };

        const isSubscription = ['claudeCode', 'codex', 'local'].includes(backendName);
        const cost = isSubscription ? 0 : ledger.estimateApiCost(result.tokens || 0);

        if (isSubscription) {
          dailyCosts[day].subscription += ledger.estimateApiCost(result.tokens || 0); // what it WOULD have cost
        } else {
          dailyCosts[day].api += cost;
        }
        dailyCosts[day].total += cost;
        backendCosts[backendName] += cost;
      }
    }

    // Sort daily costs by date
    const sortedDays = Object.values(dailyCosts).sort((a, b) => a.date.localeCompare(b.date));

    // Running totals
    let runningTotal = 0;
    for (const day of sortedDays) {
      runningTotal += day.api;
      day.runningTotal = Math.round(runningTotal * 100) / 100;
      day.api = Math.round(day.api * 10000) / 10000;
      day.subscription = Math.round(day.subscription * 10000) / 10000;
    }

    // Calculate "money saved" by subscription
    const subResults = [
      ...monitor.data.backends.claudeCode.results,
      ...monitor.data.backends.codex.results,
      ...monitor.data.backends.local.results
    ].filter(r => new Date(r.timestamp) >= cutoff);
    const savedTokens = subResults.reduce((s, r) => s + (r.tokens || 0), 0);

    // Projected monthly spend (based on trailing 7 days)
    const last7 = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const apiResults7 = monitor.data.backends.api.results.filter(r => new Date(r.timestamp) >= last7);
    const spend7days = apiResults7.reduce((s, r) => s + ledger.estimateApiCost(r.tokens || 0), 0);
    const projectedMonthly = (spend7days / 7) * 30;

    res.json({
      period,
      dailyCosts: sortedDays,
      backendCosts: {
        claudeCode: Math.round(backendCosts.claudeCode * 10000) / 10000,
        codex: Math.round(backendCosts.codex * 10000) / 10000,
        api: Math.round(backendCosts.api * 10000) / 10000,
        local: 0
      },
      current: {
        dailySpend: Math.round(ledger.data.api.dailySpendUsd * 100) / 100,
        monthlySpend: Math.round(ledger.data.api.monthlySpendUsd * 100) / 100,
        dailyBudget: config.backends.api.dailyBudgetUsd,
        monthlyBudget: config.backends.api.monthlyBudgetUsd
      },
      savedBySubscriptionUsd: Math.round(ledger.estimateApiCost(savedTokens) * 100) / 100,
      projectedMonthlyUsd: Math.round(projectedMonthly * 100) / 100
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Backend Health ─────────────────────────────────────────────────
app.get('/api/backends', async (req, res) => {
  try {
    const monitor = getMonitor();
    const ledger = getLedger();
    const scheduler = getScheduler();
    const config = getConfig();
    if (!monitor.loaded) await monitor.load();
    if (!ledger.loaded) await ledger.load();
    if (!scheduler.loaded) await scheduler.load();

    const now = new Date();
    const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

    const backends = {};

    for (const [name, stats] of Object.entries(monitor.data.backends)) {
      const recentResults = stats.results.filter(r => new Date(r.timestamp) >= sevenDaysAgo);
      const successes = recentResults.filter(r => r.success).length;
      const successRate = recentResults.length > 0 ? (successes / recentResults.length) * 100 : 0;
      const avgDuration = recentResults.length > 0
        ? recentResults.reduce((s, r) => s + r.duration, 0) / recentResults.length : 0;
      const lastUsed = recentResults.length > 0
        ? recentResults[recentResults.length - 1].timestamp : null;

      // Build sparkline data (daily scores over 7 days)
      const sparkline = [];
      for (let d = 6; d >= 0; d--) {
        const dayStart = new Date(now - d * 24 * 60 * 60 * 1000);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(dayStart);
        dayEnd.setHours(23, 59, 59, 999);
        const dayResults = stats.results.filter(r => {
          const t = new Date(r.timestamp);
          return t >= dayStart && t <= dayEnd;
        });
        const daySuccess = dayResults.filter(r => r.success).length;
        sparkline.push(dayResults.length > 0 ? Math.round((daySuccess / dayResults.length) * 100) : null);
      }

      backends[name] = {
        status: 'online',
        enabled: config.backends[name]?.enabled ?? false,
        successRate: Math.round(successRate * 10) / 10,
        avgDurationMs: Math.round(avgDuration),
        totalTasks: stats.totalTasks,
        recentTasks: recentResults.length,
        lastUsed,
        sparkline,
        adaptiveScore: monitor.getAdaptiveScore(name, { type: 'code', urgency: 'normal' })
      };
    }

    // Claude Code specifics
    backends.claudeCode.sessionUsage = ledger.data.claudeCode.sessionUsagePercent;
    backends.claudeCode.weeklyUsage = ledger.data.claudeCode.weeklyUsagePercent;
    backends.claudeCode.maxUsage = config.backends.claudeCode.maxAutoUsagePercent;
    backends.claudeCode.cooldownMs = config.scheduler?.cooldowns?.['claude-code'] || 1200000;
    backends.claudeCode.lastCompletion = scheduler.lastCompletion['claude-code'] || null;
    backends.claudeCode.health = scheduler.health['claude-code'];

    // Codex specifics
    backends.codex.sessionUsage = ledger.data.codex.sessionUsagePercent;
    backends.codex.weeklyUsage = ledger.data.codex.weeklyUsagePercent;
    backends.codex.concurrencySlots = config.backends.codex.maxConcurrent || 3;
    backends.codex.activeSlots = [...scheduler.active.values()].filter(a => a.item.backend === 'codex').length;
    backends.codex.cooldownMs = config.scheduler?.cooldowns?.codex || 300000;
    backends.codex.lastCompletion = scheduler.lastCompletion.codex || null;
    backends.codex.health = scheduler.health.codex;

    // API specifics
    backends.api.dailySpend = Math.round(ledger.data.api.dailySpendUsd * 100) / 100;
    backends.api.monthlySpend = Math.round(ledger.data.api.monthlySpendUsd * 100) / 100;
    backends.api.dailyBudget = config.backends.api.dailyBudgetUsd;
    backends.api.monthlyBudget = config.backends.api.monthlyBudgetUsd;
    backends.api.model = config.backends.api.defaultModel;

    // Local specifics
    backends.local.taskCount = ledger.data.local.taskCount;
    backends.local.totalTasks = ledger.data.local.totalTasks;

    // Determine status based on health
    for (const [name, b] of Object.entries(backends)) {
      if (!b.enabled) { b.status = 'offline'; continue; }
      if (b.health?.throttled) { b.status = 'throttled'; continue; }
      if (b.successRate < 30 && b.recentTasks >= 5) { b.status = 'degraded'; continue; }
    }

    res.json(backends);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Plan Endpoints ─────────────────────────────────────────────────
// Store plans in memory for approval workflow
const pendingPlans = new Map();

app.get('/api/plan/:taskId', (req, res) => {
  const plan = pendingPlans.get(req.params.taskId);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  res.json(plan);
});

app.post('/api/plan', async (req, res) => {
  if (!rateLimit(req.ip + ':plan', 10)) return res.status(429).json({ error: 'Rate limited' });
  try {
    const task = req.body;
    if (!task?.description) return res.status(400).json({ error: 'Task must have a description' });

    const result = await getRouter().route(task, { plan: true });
    pendingPlans.set(result.plan.id, result);

    // Auto-expire plans after 1 hour
    setTimeout(() => pendingPlans.delete(result.plan.id), 3600000);

    broadcast('plan-created', { planId: result.plan.id });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/plan/:taskId/approve', async (req, res) => {
  if (!rateLimit(req.ip + ':approve', 10)) return res.status(429).json({ error: 'Rate limited' });
  try {
    const planId = req.params.taskId;

    // Try router's persistent approval flow first (notify.js pending plans)
    try {
      const result = await getRouter().approvePlan(planId);
      pendingPlans.delete(planId);
      broadcast('plan-executed', { planId, success: result.success });
      return res.json(result);
    } catch (routerErr) {
      // Fall back to in-memory plans (dashboard-created plans)
      const planData = pendingPlans.get(planId);
      if (!planData) return res.status(404).json({ error: 'Plan not found' });

      const result = await getRouter().executePlan(planData.plan);
      pendingPlans.delete(planId);

      broadcast('plan-executed', { planId, success: result.success });
      return res.json(result);
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/plan/:taskId/cancel', (req, res) => {
  const planId = req.params.taskId;

  // Cancel from both stores
  const routerCancelled = getRouter().cancelPlan(planId);
  const memoryCancelled = pendingPlans.delete(planId);
  const deleted = routerCancelled || memoryCancelled;

  if (deleted) broadcast('plan-cancelled', { planId });
  res.json({ success: deleted, message: deleted ? 'Plan cancelled' : 'Plan not found' });
});

// Pending plans list (from both in-memory and persistent store)
app.get('/api/plans/pending', (req, res) => {
  try {
    const persistent = getRouter().getPendingPlans();
    const memoryPlans = {};
    for (const [id, data] of pendingPlans) {
      memoryPlans[id] = data;
    }
    res.json({ persistent, memory: memoryPlans });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Config Endpoints ───────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  try {
    const config = getConfig();
    // Strip sensitive fields
    const safe = { ...config };
    if (safe.dashboard) {
      safe.dashboard = { ...safe.dashboard, authToken: '***' };
    }
    res.json(safe);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/config', async (req, res) => {
  if (!rateLimit(req.ip + ':config', 5)) return res.status(429).json({ error: 'Rate limited' });
  try {
    const updates = req.body;
    if (!updates || typeof updates !== 'object') {
      return res.status(400).json({ error: 'Body must be a JSON object' });
    }

    const configPath = path.join(__dirname, 'config.json');
    const current = JSON.parse(await fs.readFile(configPath, 'utf8'));

    // Deep merge (one level deep for safety)
    for (const [section, values] of Object.entries(updates)) {
      if (section === 'dashboard' && values.authToken) continue; // Don't allow token changes via API
      if (typeof values === 'object' && !Array.isArray(values) && current[section]) {
        current[section] = { ...current[section], ...values };
      } else {
        current[section] = values;
      }
    }

    await fs.writeFile(configPath, JSON.stringify(current, null, 2));
    broadcast('config-updated', { sections: Object.keys(updates) });
    res.json({ success: true, message: 'Config updated' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Webhook Receiver ──────────────────────────────────────────────
// In-memory storage for webhook results
const webhookResults = new Map();
const webhookQueue = [];

function cleanupOldWebhookResults() {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  for (const [taskId, result] of webhookResults) {
    if (result.timestamp < oneHourAgo) {
      webhookResults.delete(taskId);
    }
  }
}
setInterval(cleanupOldWebhookResults, 5 * 60 * 1000); // Clean every 5 minutes

function generateTaskId() {
  return 'wh_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now().toString(36);
}

async function postCallback(callbackUrl, result) {
  try {
    const response = await fetch(callbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(result)
    });
    return { success: response.ok, status: response.status };
  } catch (error) {
    console.error('[WEBHOOK] Callback failed:', error.message);
    return { success: false, error: error.message };
  }
}

app.post('/api/webhook/route', async (req, res) => {
  // Rate limiting for webhooks
  if (!rateLimit(req.ip + ':webhook', 10)) return res.status(429).json({ error: 'Rate limited' });
  
  try {
    const config = getConfig();
    if (!config.webhook?.enabled) {
      return res.status(503).json({ error: 'Webhook endpoint disabled' });
    }

    // Check queue size limit
    if (webhookQueue.length >= (config.webhook.maxQueueSize || 50)) {
      return res.status(503).json({ error: 'Webhook queue full, try again later' });
    }

    const { task, urgency = 'normal', callback_url } = req.body;
    
    if (!task) {
      return res.status(400).json({ error: 'Missing required field: task' });
    }

    const taskId = generateTaskId();
    
    // Store initial result
    webhookResults.set(taskId, {
      taskId,
      status: 'accepted',
      timestamp: Date.now(),
      task,
      urgency,
      callback_url
    });

    // Add to internal queue for processing
    webhookQueue.push({ taskId, task, urgency, callback_url });

    // Process webhook asynchronously
    setImmediate(async () => {
      try {
        const routerTask = {
          description: task,
          urgency,
          source: 'webhook'
        };

        const result = await getRouter().route(routerTask);
        
        // Update result
        const webhookResult = {
          taskId,
          status: result.success ? 'completed' : 'failed',
          timestamp: Date.now(),
          result,
          task,
          urgency
        };
        
        webhookResults.set(taskId, webhookResult);
        
        // Remove from queue
        const queueIndex = webhookQueue.findIndex(item => item.taskId === taskId);
        if (queueIndex !== -1) {
          webhookQueue.splice(queueIndex, 1);
        }

        // Send callback if provided
        if (callback_url) {
          await postCallback(callback_url, webhookResult);
        }

        broadcast('webhook-completed', { taskId, success: result.success });
      } catch (error) {
        console.error('[WEBHOOK] Processing failed:', error);
        
        const errorResult = {
          taskId,
          status: 'failed',
          timestamp: Date.now(),
          error: error.message,
          task,
          urgency
        };
        
        webhookResults.set(taskId, errorResult);
        
        // Remove from queue
        const queueIndex = webhookQueue.findIndex(item => item.taskId === taskId);
        if (queueIndex !== -1) {
          webhookQueue.splice(queueIndex, 1);
        }

        // Send callback if provided
        if (callback_url) {
          await postCallback(callback_url, errorResult);
        }

        broadcast('webhook-failed', { taskId, error: error.message });
      }
    });

    res.json({ taskId, status: 'accepted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/webhook/result/:taskId', (req, res) => {
  try {
    const result = webhookResults.get(req.params.taskId);
    if (!result) {
      return res.status(404).json({ error: 'Task not found' });
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Watchdog Endpoint ──────────────────────────────────────────────
app.get('/api/watchdog', (req, res) => {
  try {
    const watchdog = require('./watchdog');
    const stats = watchdog.getWatchdogStats();
    res.json(stats);
  } catch (error) {
    console.warn('[DASHBOARD] Watchdog not available:', error.message);
    res.status(503).json({ 
      error: 'Watchdog service not available',
      message: 'The watchdog process may not be running. Start it with: pm2 start watchdog.js --name router-watchdog'
    });
  }
});

// ─── Cost Prediction ───────────────────────────────────────────────
function getCostPredictor() { return require('./cost-predictor'); }

app.get('/api/predict-cost', async (req, res) => {
  try {
    const { task } = req.query;
    
    if (!task) {
      return res.status(400).json({ error: 'Missing required parameter: task' });
    }

    const costPredictor = getCostPredictor();
    const prediction = await costPredictor.predict(task);
    
    res.json(prediction);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── GitHub Webhook ────────────────────────────────────────────────
function getGitHubWebhook() { return require('./github-webhook'); }

app.post('/api/github/webhook', async (req, res) => {
  try {
    const config = getConfig();
    if (!config.github?.enabled) {
      return res.status(503).json({ error: 'GitHub integration disabled' });
    }

    const signature = req.headers['x-hub-signature-256'];
    const githubEvent = req.headers['x-github-event'];
    const payload = req.body;

    // Verify signature if secret is configured
    if (config.github.webhookSecret) {
      const rawBody = JSON.stringify(req.body);
      const githubWebhook = getGitHubWebhook();
      
      if (!githubWebhook.verifySignature(rawBody, signature, config.github.webhookSecret)) {
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    // Only handle pull request events
    if (githubEvent !== 'pull_request') {
      return res.json({ 
        message: `Event type ${githubEvent} ignored`,
        processed: false
      });
    }

    const githubWebhook = getGitHubWebhook();
    const result = await githubWebhook.handleWebhook(payload, async (task) => {
      return await getRouter().route(task);
    });

    broadcast('github-webhook', { 
      event: githubEvent, 
      repo: payload.repository?.full_name,
      pr: payload.pull_request?.number,
      success: result.success
    });

    res.json(result);
  } catch (error) {
    console.error('[GITHUB-WEBHOOK] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/github/status', (req, res) => {
  try {
    const githubWebhook = getGitHubWebhook();
    const status = githubWebhook.getStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Existing convenience endpoints (kept from v2) ──────────────────
app.get('/api/status', async (req, res) => {
  try {
    const status = await getRouter().getStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message, initialized: false });
  }
});

app.get('/api/performance', async (req, res) => {
  try {
    const report = await getMonitor().getPerformanceReport();
    res.json(report);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/usage', async (req, res) => {
  try {
    const report = await getLedger().getReport();
    res.json(report);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/history/search', async (req, res) => {
  try {
    const { q: keyword, backend, from, to, limit } = req.query;
    
    if (!keyword) {
      return res.status(400).json({ error: 'Query parameter "q" is required' });
    }

    const monitor = getMonitor();
    if (!monitor.loaded) await monitor.load();

    const allResults = [];

    // Extract all results from all backends
    if (monitor.data.backends) {
      Object.keys(monitor.data.backends).forEach(backendName => {
        const backendData = monitor.data.backends[backendName];
        if (backendData && backendData.results) {
          backendData.results.forEach(result => {
            allResults.push({ ...result, backend: backendName });
          });
        }
      });
    }

    // Filter results
    let filteredResults = allResults.filter(result => {
      // Keyword search in available text fields
      const searchableText = [
        result.description,
        result.taskType,
        result.task,
        result.command,
        result.id
      ].filter(Boolean).join(' ').toLowerCase();
      
      if (!searchableText.includes(keyword.toLowerCase())) {
        return false;
      }

      // Backend filter
      if (backend && result.backend !== backend) {
        return false;
      }

      // Date filters
      if (from || to) {
        const resultDate = new Date(result.timestamp);
        if (from && resultDate < new Date(from + 'T00:00:00.000Z')) {
          return false;
        }
        if (to && resultDate > new Date(to + 'T23:59:59.999Z')) {
          return false;
        }
      }

      return true;
    });

    // Sort by timestamp (newest first)
    filteredResults.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    // Apply limit
    const resultLimit = limit ? parseInt(limit, 10) : 50;
    filteredResults = filteredResults.slice(0, resultLimit);

    res.json({
      results: filteredResults.map(result => ({
        id: result.id || result.taskId,
        timestamp: result.timestamp,
        description: result.description || result.task || result.taskType || 'No description',
        backend: result.backend,
        duration: result.duration || result.durationMs,
        cost: result.costUsd,
        success: result.success,
        tokens: result.tokens,
        taskType: result.taskType
      })),
      total: filteredResults.length,
      query: { keyword, backend, from, to, limit: resultLimit }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/scheduler', (req, res) => {
  try {
    res.json(getScheduler().getStatus());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/scheduler/enqueue', async (req, res) => {
  if (!rateLimit(req.ip + ':enqueue', 20)) return res.status(429).json({ error: 'Rate limited' });
  try {
    const { task, backend, priority } = req.body;
    if (!task?.description) return res.status(400).json({ error: 'Task must have a description' });
    const taskId = await getScheduler().enqueue(task, backend || 'claude-code', priority || 'normal');
    broadcast('queue-update', { action: 'enqueued', taskId });
    res.json({ success: true, taskId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/scheduler/pause', (req, res) => {
  getScheduler().pause();
  broadcast('scheduler-update', { paused: true });
  res.json({ success: true, paused: true });
});

app.post('/api/scheduler/resume', (req, res) => {
  getScheduler().resume();
  broadcast('scheduler-update', { paused: false });
  res.json({ success: true, paused: false });
});

app.post('/api/route', async (req, res) => {
  if (!rateLimit(req.ip + ':route', 10)) return res.status(429).json({ error: 'Rate limited' });
  try {
    const task = req.body;
    if (!task?.description) return res.status(400).json({ error: 'Task must have a description' });
    const result = await getRouter().route(task);
    broadcast('task-completed', { backend: result.backend, success: result.success });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Alerts ─────────────────────────────────────────────────────────
app.get('/api/alerts', async (req, res) => {
  try {
    const monitor = getMonitor();
    if (!monitor.loaded) await monitor.load();
    const unacknowledged = req.query.all !== 'true';
    res.json(monitor.getAlerts(unacknowledged));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/alerts/:alertId/acknowledge', async (req, res) => {
  try {
    const monitor = getMonitor();
    const acked = await monitor.acknowledgeAlert(parseFloat(req.params.alertId));
    res.json({ success: acked });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Agent 2: Circuit Breaker + Dedup Endpoints ─────────────────────
app.get('/api/breakers', (req, res) => {
  try {
    const cb = getCircuitBreaker();
    const backend = req.query.backend;
    if (backend) {
      res.json(cb.getState(backend));
    } else {
      res.json(cb.getAll());
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/breakers/:backend/reset', (req, res) => {
  if (!rateLimit(req.ip + ':breaker-reset', 10)) return res.status(429).json({ error: 'Rate limited' });
  try {
    const cb = getCircuitBreaker();
    cb.reset(req.params.backend);
    broadcast('breaker-update', { backend: req.params.backend, action: 'reset' });
    res.json({ success: true, state: cb.getState(req.params.backend) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/dedup', (req, res) => {
  try {
    const dd = getDedup();
    res.json({ recentTasks: dd.getRecent() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/dedup/check', (req, res) => {
  if (!rateLimit(req.ip + ':dedup-check', 20)) return res.status(429).json({ error: 'Rate limited' });
  try {
    const task = req.body;
    if (!task?.description) return res.status(400).json({ error: 'Task must have a description' });
    const dd = getDedup();
    res.json(dd.check(task));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/confidence', (req, res) => {
  try {
    const task = { description: req.query.description || '' };
    if (!task.description) return res.status(400).json({ error: 'Provide ?description=...' });
    const planner = getPlanner();
    res.json(planner.assessConfidence(task));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Rate Governor Endpoints ─────────────────────────────────────────
app.get('/api/rate-limits', async (req, res) => {
  try {
    const rg = getRateGovernor();
    if (!rg.loaded) await rg.load();
    
    const backend = req.query.backend;
    if (backend) {
      res.json({ 
        backend,
        canUse: rg.canUse(backend),
        status: rg.getStatus().backends[backend] || null
      });
    } else {
      res.json(rg.getStatus());
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/rate-limits/learnings', async (req, res) => {
  try {
    const rg = getRateGovernor();
    if (!rg.loaded) await rg.load();
    res.json(rg.getLearnings());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/rate-limits/:backend/reset', (req, res) => {
  if (!rateLimit(req.ip + ':rate-reset', 10)) return res.status(429).json({ error: 'Rate limited' });
  try {
    const rg = getRateGovernor();
    const { newLimit } = req.body;
    rg.resetBackend(req.params.backend, newLimit);
    broadcast('rate-limit-update', { backend: req.params.backend, action: 'reset', newLimit });
    res.json({ success: true, status: rg.getStatus().backends[req.params.backend] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/rate-limits/:backend/adjust', (req, res) => {
  if (!rateLimit(req.ip + ':rate-adjust', 10)) return res.status(429).json({ error: 'Rate limited' });
  try {
    const rg = getRateGovernor();
    const { limit } = req.body;
    if (typeof limit !== 'number' || limit < 1) {
      return res.status(400).json({ error: 'limit must be a number >= 1' });
    }
    rg.adjustLimit(req.params.backend, limit);
    broadcast('rate-limit-update', { backend: req.params.backend, action: 'adjust', newLimit: limit });
    res.json({ success: true, status: rg.getStatus().backends[req.params.backend] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/rate-limits/:backend/throttle', (req, res) => {
  if (!rateLimit(req.ip + ':rate-throttle', 10)) return res.status(429).json({ error: 'Rate limited' });
  try {
    const rg = getRateGovernor();
    const { details } = req.body;
    rg.recordThrottle(req.params.backend, details || {});
    broadcast('rate-limit-update', { backend: req.params.backend, action: 'throttle' });
    res.json({ success: true, message: 'Throttle recorded' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Agent 3: Active Context + Backend Health ──────────────────────
app.get('/api/context', async (req, res) => {
  try {
    const session = getSession();
    const ctx = session.getContext();
    res.json(ctx);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/context/summary', (req, res) => {
  try {
    const session = getSession();
    res.json(session.getSummary());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/context/task/:taskId', (req, res) => {
  try {
    const session = getSession();
    const task = session.getActiveTask(req.params.taskId);
    if (!task) return res.status(404).json({ error: 'Task not found in active context' });
    res.json(task);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/context/channel/:channel', (req, res) => {
  try {
    const session = getSession();
    res.json(session.getChannelState(req.params.channel));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/health/backends', (req, res) => {
  try {
    const warmup = getWarmup();
    const backend = req.query.backend;
    res.json(warmup.getHealth(backend || undefined));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/health/ping/:backend', async (req, res) => {
  if (!rateLimit(req.ip + ':ping', 10)) return res.status(429).json({ error: 'Rate limited' });
  try {
    const warmup = getWarmup();
    const result = await warmup.pingNow(req.params.backend);
    broadcast('health-update', { backend: req.params.backend, health: result });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/health/prewarm/:backend', (req, res) => {
  if (!rateLimit(req.ip + ':prewarm', 5)) return res.status(429).json({ error: 'Rate limited' });
  try {
    const warmup = getWarmup();
    const result = warmup.preWarm(req.params.backend);
    res.json({ success: !!result, result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Dashboard HTML ─────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// ─── Error / 404 ────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[DASHBOARD] Express error:', err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

// ─── Model Registry API Endpoints ────────────────────────────────
app.get('/api/models', async (req, res) => {
  try {
    const modelRegistry = getModelRegistry();
    await modelRegistry.load();
    
    const registry = modelRegistry.getRegistry();
    const modelsWithHealth = {};
    
    // Add health and cost information for each model
    for (const [modelId, config] of Object.entries(registry.models)) {
      modelsWithHealth[modelId] = {
        ...config,
        providers: config.providers.map(providerId => ({
          id: providerId,
          ...registry.providers[providerId],
          available: registry.providers[providerId]?.healthy || false
        })),
        estimatedCostPer10k: {
          input: config.costPer1kIn * 10,
          output: config.costPer1kOut * 10,
          mixed: (config.costPer1kIn * 7 + config.costPer1kOut * 3) // 70/30 split
        }
      };
    }
    
    res.json({
      models: modelsWithHealth,
      providers: registry.providers,
      trustData: registry.trustData || {},
      totalModels: Object.keys(modelsWithHealth).length,
      healthyProviders: Object.values(registry.providers).filter(p => p.healthy).length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/models/:modelId', async (req, res) => {
  try {
    const modelRegistry = getModelRegistry();
    await modelRegistry.load();
    
    const modelInfo = modelRegistry.getModelInfo(req.params.modelId);
    if (!modelInfo) {
      return res.status(404).json({ error: 'Model not found' });
    }
    
    res.json(modelInfo);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/models/provider/:providerId/health', (req, res) => {
  if (!rateLimit(req.ip + ':provider-health', 20)) return res.status(429).json({ error: 'Rate limited' });
  try {
    const modelRegistry = getModelRegistry();
    const { healthy } = req.body;
    
    if (typeof healthy !== 'boolean') {
      return res.status(400).json({ error: 'healthy must be boolean' });
    }
    
    modelRegistry.setProviderHealth(req.params.providerId, healthy);
    broadcast('provider-health-update', { 
      provider: req.params.providerId, 
      healthy,
      timestamp: new Date().toISOString()
    });
    
    res.json({ success: true, provider: req.params.providerId, healthy });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

// ─── Start ──────────────────────────────────────────────────────────
async function startServer() {
  try {
    const config = getConfig();
    const PORT = config.dashboard?.port || 3457;

    console.log('[DASHBOARD] Initializing router...');
    await getRouter().initialize();

    const server = app.listen(PORT, () => {
      console.log(`[DASHBOARD] OpenClaw Dashboard v3 running on port ${PORT}`);
      console.log(`[DASHBOARD] http://localhost:${PORT}`);
    });

    const shutdown = () => {
      console.log('[DASHBOARD] Shutting down...');
      server.close(() => {
        getRouter().shutdown()
          .then(() => process.exit(0))
          .catch(() => process.exit(1));
      });
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch (error) {
    console.error('[DASHBOARD] Failed to start:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  startServer();
}

module.exports = app;
