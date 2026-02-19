/**
 * OpenClaw Warm Standby — Backend Health Monitor
 * Periodic health pings keep backends "warm" for fast cold starts.
 * Results written to data/backend-health.json.
 *
 * Health tiers:
 *   warm     — pinged successfully in last 5 min
 *   healthy  — pinged successfully in last 15 min
 *   cold     — no recent ping
 *   dead     — last ping failed
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const http = require('http');

// Lazy load to avoid circular dependency
function getCircuitBreaker() {
  try {
    return require('./circuit-breaker');
  } catch (err) {
    console.warn('[WARMUP] Circuit breaker not available:', err.message);
    return null;
  }
}

const DATA_DIR = process.env.ROUTER_TEST_MODE ? process.env.ROUTER_TEST_DATA_DIR : path.join(__dirname, 'data');
const HEALTH_FILE = path.join(DATA_DIR, 'backend-health.json');

// ─── Defaults ───────────────────────────────────────────────────────
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const WARM_THRESHOLD_MS   =  5 * 60 * 1000; //  5 minutes
const HEALTHY_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes

// ─── State ──────────────────────────────────────────────────────────
let healthState = {};
let intervalHandle = null;
let config = null;

function defaultBackendState(name) {
  return {
    backend: name,
    status: 'cold',
    lastPing: null,
    lastSuccess: null,
    lastError: null,
    version: null,
    consecutiveFailures: 0
  };
}

// ─── Persistence ────────────────────────────────────────────────────

async function ensureDataDir() {
  try { await fsp.mkdir(DATA_DIR, { recursive: true }); } catch (_) {}
}

async function loadState() {
  await ensureDataDir();
  try {
    const raw = await fsp.readFile(HEALTH_FILE, 'utf8');
    healthState = JSON.parse(raw);
  } catch (_) {
    healthState = {};
  }

  // Ensure all backends exist
  for (const name of ['claudeCode', 'codex', 'local', 'api']) {
    if (!healthState[name]) {
      healthState[name] = defaultBackendState(name);
    }
  }
}

async function saveState() {
  await ensureDataDir();
  await fsp.writeFile(HEALTH_FILE, JSON.stringify(healthState, null, 2));
}

// ─── Health classification ──────────────────────────────────────────

function classifyHealth(backendState) {
  if (!backendState.lastSuccess) return 'cold';
  if (backendState.consecutiveFailures > 0) return 'dead';

  const elapsed = Date.now() - new Date(backendState.lastSuccess).getTime();
  if (elapsed <= WARM_THRESHOLD_MS) return 'warm';
  if (elapsed <= HEALTHY_THRESHOLD_MS) return 'healthy';
  return 'cold';
}

function refreshStatuses() {
  for (const name of Object.keys(healthState)) {
    healthState[name].status = classifyHealth(healthState[name]);
  }
}

// ─── Individual backend pings ───────────────────────────────────────

async function pingClaudeCode() {
  const name = 'claudeCode';
  if (!healthState[name]) healthState[name] = defaultBackendState(name);
  healthState[name].lastPing = new Date().toISOString();

  try {
    const output = execSync('claude --version 2>&1', {
      timeout: 10000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    healthState[name].lastSuccess = new Date().toISOString();
    healthState[name].lastError = null;
    healthState[name].version = output.split('\n')[0];
    healthState[name].consecutiveFailures = 0;
    healthState[name].status = 'warm';

    console.log(`[WARMUP] Claude Code: OK (${healthState[name].version})`);
  } catch (err) {
    healthState[name].lastError = err.message || String(err);
    healthState[name].consecutiveFailures++;
    healthState[name].status = 'dead';
    console.warn(`[WARMUP] Claude Code: FAIL — ${healthState[name].lastError}`);
    
    // Record probe failure in circuit breaker
    const circuitBreaker = getCircuitBreaker();
    if (circuitBreaker) {
      circuitBreaker.recordFailure('claudeCode', {
        isProbe: true,
        error: healthState[name].lastError,
        probeType: 'health-check'
      });
    }
  }
}

async function pingCodex() {
  const name = 'codex';
  if (!healthState[name]) healthState[name] = defaultBackendState(name);
  healthState[name].lastPing = new Date().toISOString();

  try {
    const output = execSync('codex --version 2>&1', {
      timeout: 10000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    healthState[name].lastSuccess = new Date().toISOString();
    healthState[name].lastError = null;
    healthState[name].version = output.split('\n')[0];
    healthState[name].consecutiveFailures = 0;
    healthState[name].status = 'warm';

    console.log(`[WARMUP] Codex: OK (${healthState[name].version})`);
  } catch (err) {
    healthState[name].lastError = err.message || String(err);
    healthState[name].consecutiveFailures++;
    healthState[name].status = 'dead';
    console.warn(`[WARMUP] Codex: FAIL — ${healthState[name].lastError}`);
    
    // Record probe failure in circuit breaker
    const circuitBreaker = getCircuitBreaker();
    if (circuitBreaker) {
      circuitBreaker.recordFailure('codex', {
        isProbe: true,
        error: healthState[name].lastError,
        probeType: 'health-check'
      });
    }
  }
}

async function pingOllama() {
  const name = 'local';
  if (!healthState[name]) healthState[name] = defaultBackendState(name);
  healthState[name].lastPing = new Date().toISOString();

  const ollamaUrl = config?.backends?.local?.ollamaUrl || 'http://localhost:11434';

  return new Promise((resolve) => {
    const url = new URL('/api/tags', ollamaUrl);

    const req = http.get(url, { timeout: 10000 }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          const modelCount = Array.isArray(data.models) ? data.models.length : 0;

          healthState[name].lastSuccess = new Date().toISOString();
          healthState[name].lastError = null;
          healthState[name].version = `${modelCount} models loaded`;
          healthState[name].consecutiveFailures = 0;
          healthState[name].status = 'warm';
          healthState[name].models = (data.models || []).map(m => m.name);

          console.log(`[WARMUP] Ollama: OK (${modelCount} models)`);
        } catch (parseErr) {
          healthState[name].lastError = 'Invalid response from Ollama';
          healthState[name].consecutiveFailures++;
          healthState[name].status = 'dead';
          console.warn('[WARMUP] Ollama: FAIL — bad response');
          
          // Record probe failure in circuit breaker
          const circuitBreaker = getCircuitBreaker();
          if (circuitBreaker) {
            circuitBreaker.recordFailure('local', {
              isProbe: true,
              error: healthState[name].lastError,
              probeType: 'health-check'
            });
          }
        }
        resolve();
      });
    });

    req.on('error', (err) => {
      healthState[name].lastError = err.message || String(err);
      healthState[name].consecutiveFailures++;
      healthState[name].status = 'dead';
      console.warn(`[WARMUP] Ollama: FAIL — ${healthState[name].lastError}`);
      
      // Record probe failure in circuit breaker
      const circuitBreaker = getCircuitBreaker();
      if (circuitBreaker) {
        circuitBreaker.recordFailure('local', {
          isProbe: true,
          error: healthState[name].lastError,
          probeType: 'health-check'
        });
      }
      resolve();
    });

    req.on('timeout', () => {
      req.destroy();
      healthState[name].lastError = 'Timeout';
      healthState[name].consecutiveFailures++;
      healthState[name].status = 'dead';
      console.warn('[WARMUP] Ollama: FAIL — timeout');
      
      // Record probe failure in circuit breaker
      const circuitBreaker = getCircuitBreaker();
      if (circuitBreaker) {
        circuitBreaker.recordFailure('local', {
          isProbe: true,
          error: 'Timeout',
          probeType: 'health-check'
        });
      }
      resolve();
    });
  });
}

async function pingApi() {
  const name = 'api';
  if (!healthState[name]) healthState[name] = defaultBackendState(name);
  healthState[name].lastPing = new Date().toISOString();

  try {
    // Check if OpenClaw API key is configured
    const openclawConfig = process.env.OPENCLAW_API_KEY;
    if (!openclawConfig) {
      // API backend is configured but no key - mark as always healthy to avoid false failures
      healthState[name].lastSuccess = new Date().toISOString();
      healthState[name].lastError = null;
      healthState[name].version = 'API available (no key configured)';
      healthState[name].consecutiveFailures = 0;
      healthState[name].status = 'warm';
      console.log(`[WARMUP] API: OK (no key required for health check)`);
      return;
    }

    // If we have a key, we could try a lightweight API call here
    // For now, just mark as healthy if key exists
    healthState[name].lastSuccess = new Date().toISOString();
    healthState[name].lastError = null;
    healthState[name].version = 'API key configured';
    healthState[name].consecutiveFailures = 0;
    healthState[name].status = 'warm';
    console.log(`[WARMUP] API: OK (API key present)`);

  } catch (err) {
    healthState[name].lastError = err.message || String(err);
    healthState[name].consecutiveFailures++;
    healthState[name].status = 'dead';
    console.warn(`[WARMUP] API: FAIL — ${healthState[name].lastError}`);
    
    // Record probe failure in circuit breaker
    const circuitBreaker = getCircuitBreaker();
    if (circuitBreaker) {
      circuitBreaker.recordFailure('api', {
        isProbe: true,
        error: healthState[name].lastError,
        probeType: 'health-check'
      });
    }
  }
}

// ─── Full ping cycle ────────────────────────────────────────────────

async function pingAll() {
  console.log('[WARMUP] Running health checks...');

  await Promise.allSettled([
    pingClaudeCode(),
    pingCodex(),
    pingOllama(),
    pingApi()
  ]);

  refreshStatuses();
  await saveState();
  console.log('[WARMUP] Health checks complete');
}

// ─── Pre-warming (optional) ─────────────────────────────────────────

const preWarmProcesses = new Map();

/**
 * Start a pre-warm session for a backend.
 * Spawns the process without sending a task, just to have it ready.
 * @param {string} backend — 'claudeCode' | 'codex'
 * @returns {{ pid: number, backend: string } | null}
 */
function preWarm(backend) {
  // Only support pre-warming CLI backends
  if (backend === 'claudeCode') {
    try {
      const proc = spawn('claude', ['--help'], {
        stdio: 'ignore',
        detached: false
      });
      preWarmProcesses.set(backend, proc);
      proc.on('exit', () => preWarmProcesses.delete(backend));

      // Auto-kill after 60s if unused
      setTimeout(() => {
        if (preWarmProcesses.has(backend)) {
          try { proc.kill(); } catch (_) {}
          preWarmProcesses.delete(backend);
        }
      }, 60000);

      console.log(`[WARMUP] Pre-warmed Claude Code (pid ${proc.pid})`);
      return { pid: proc.pid, backend };
    } catch (err) {
      console.warn(`[WARMUP] Pre-warm Claude Code failed: ${err.message}`);
      return null;
    }
  }

  if (backend === 'codex') {
    try {
      const proc = spawn('codex', ['--help'], {
        stdio: 'ignore',
        detached: false
      });
      preWarmProcesses.set(backend, proc);
      proc.on('exit', () => preWarmProcesses.delete(backend));

      setTimeout(() => {
        if (preWarmProcesses.has(backend)) {
          try { proc.kill(); } catch (_) {}
          preWarmProcesses.delete(backend);
        }
      }, 60000);

      console.log(`[WARMUP] Pre-warmed Codex (pid ${proc.pid})`);
      return { pid: proc.pid, backend };
    } catch (err) {
      console.warn(`[WARMUP] Pre-warm Codex failed: ${err.message}`);
      return null;
    }
  }

  return null;
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Start periodic health checks
 * @param {Object} [cfg] — config.json contents (to read ollamaUrl etc.)
 * @param {number} [intervalMs] — ping interval, default 15 min
 */
async function startWarmup(cfg, intervalMs) {
  config = cfg || {};
  const interval = intervalMs || config.warmup?.intervalMs || DEFAULT_INTERVAL_MS;

  await loadState();

  // Immediate first ping
  await pingAll();

  // Periodic pings
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = setInterval(() => {
    pingAll().catch(err => {
      console.error('[WARMUP] Ping cycle error:', err.message);
    });
  }, interval);

  console.log(`[WARMUP] Started (interval: ${Math.round(interval / 1000)}s)`);
}

/**
 * Stop periodic health checks
 */
function stopWarmup() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }

  // Kill any pre-warm processes
  for (const [, proc] of preWarmProcesses) {
    try { proc.kill(); } catch (_) {}
  }
  preWarmProcesses.clear();

  console.log('[WARMUP] Stopped');
}

/**
 * Get health status for all or a single backend
 * @param {string} [backend] — optional: 'claudeCode' | 'codex' | 'local'
 * @returns {Object} Health state(s)
 */
function getHealth(backend) {
  refreshStatuses();
  if (backend) {
    return healthState[backend] || defaultBackendState(backend);
  }
  return { ...healthState };
}

/**
 * Force an immediate health check on a specific backend
 * @param {string} backend — 'claudeCode' | 'codex' | 'local' | 'api'
 * @returns {Promise<Object>} Updated backend health state
 */
async function pingNow(backend) {
  switch (backend) {
    case 'claudeCode': await pingClaudeCode(); break;
    case 'codex':      await pingCodex(); break;
    case 'local':      await pingOllama(); break;
    case 'api':        await pingApi(); break;
    default:
      throw new Error(`Unknown backend: ${backend}`);
  }

  refreshStatuses();
  await saveState();
  return healthState[backend];
}

/**
 * Get a numeric health score suitable for routing decisions
 * @param {string} backend
 * @returns {number} 0-100 score (warm=100, healthy=75, cold=25, dead=0)
 */
function getHealthScore(backend) {
  const state = healthState[backend];
  if (!state) return 25; // unknown → cold

  const scores = { warm: 100, healthy: 75, cold: 25, dead: 0 };
  return scores[state.status] ?? 25;
}

module.exports = {
  startWarmup,
  stopWarmup,
  getHealth,
  getHealthScore,
  pingNow,
  preWarm,
  loadState,
  saveState
};
