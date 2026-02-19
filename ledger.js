const fs = require('fs').promises;
const path = require('path');

/**
 * Token & Budget Tracking System for OpenClaw Task Router
 * Tracks usage across all backends with persistent storage and budget enforcement
 */
class Ledger {
  constructor() {
    const dataDir = process.env.ROUTER_TEST_MODE ? process.env.ROUTER_TEST_DATA_DIR : path.join(__dirname, 'data');
    this.dataPath = path.join(dataDir, 'ledger.json');
    this.data = {
      claudeCode: {
        sessionUsagePercent: 0,
        weeklyUsagePercent: 0,
        sessionResetTime: null,
        weeklyResetTime: null,
        tasksCompleted: 0
      },
      codex: {
        sessionUsagePercent: 0,
        weeklyUsagePercent: 0,
        sessionResetTime: null,
        weeklyResetTime: null,
        tasksCompleted: 0
      },
      api: {
        dailySpendUsd: 0,
        monthlySpendUsd: 0,
        dailyTokens: 0,
        monthlyTokens: 0,
        dailyResetTime: null,
        monthlyResetTime: null,
        tasksCompleted: 0
      },
      local: {
        taskCount: 0,
        totalTasks: 0
      },
      users: {
        // userId -> { dailySpendUsd, monthlySpendUsd, dailyTokens, monthlyTokens, tasksCompleted }
      },
      lastUpdated: new Date().toISOString()
    };
    this.loaded = false;
  }

  /**
   * Load ledger data from persistent storage
   * @returns {Promise<void>}
   */
  async load() {
    try {
      const dataStr = await fs.readFile(this.dataPath, 'utf8');
      this.data = { ...this.data, ...JSON.parse(dataStr) };
      await this.checkResets();
      this.loaded = true;
      console.log('[LEDGER] Data loaded successfully');
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.log('[LEDGER] No existing data found, starting fresh');
        await this.save();
        this.loaded = true;
      } else {
        console.error('[LEDGER] Error loading data:', error.message);
        this.loaded = true; // Continue with defaults
      }
    }
  }

  /**
   * Save ledger data to persistent storage
   * @returns {Promise<void>}
   */
  async save() {
    try {
      this.data.lastUpdated = new Date().toISOString();
      await fs.mkdir(path.dirname(this.dataPath), { recursive: true });
      await fs.writeFile(this.dataPath, JSON.stringify(this.data, null, 2));
    } catch (error) {
      console.error('[LEDGER] Error saving data:', error.message);
    }
  }

  /**
   * Check for and handle automatic resets (session, daily, weekly, monthly)
   * @returns {Promise<void>}
   */
  async checkResets() {
    const now = new Date();

    // Claude Code session reset (5 hours)
    if (this.shouldReset(this.data.claudeCode.sessionResetTime, 5 * 60 * 60 * 1000)) {
      this.data.claudeCode.sessionUsagePercent = 0;
      this.data.claudeCode.sessionResetTime = now.toISOString();
      console.log('[LEDGER] Claude Code session reset');
    }

    // Claude Code weekly reset
    if (this.shouldReset(this.data.claudeCode.weeklyResetTime, 7 * 24 * 60 * 60 * 1000)) {
      this.data.claudeCode.weeklyUsagePercent = 0;
      this.data.claudeCode.weeklyResetTime = now.toISOString();
      console.log('[LEDGER] Claude Code weekly reset');
    }

    // Codex session reset (5 hours)
    if (this.shouldReset(this.data.codex.sessionResetTime, 5 * 60 * 60 * 1000)) {
      this.data.codex.sessionUsagePercent = 0;
      this.data.codex.sessionResetTime = now.toISOString();
      console.log('[LEDGER] Codex session reset');
    }

    // Codex weekly reset
    if (this.shouldReset(this.data.codex.weeklyResetTime, 7 * 24 * 60 * 60 * 1000)) {
      this.data.codex.weeklyUsagePercent = 0;
      this.data.codex.weeklyResetTime = now.toISOString();
      console.log('[LEDGER] Codex weekly reset');
    }

    // API daily reset
    if (this.shouldReset(this.data.api.dailyResetTime, 24 * 60 * 60 * 1000)) {
      this.data.api.dailySpendUsd = 0;
      this.data.api.dailyTokens = 0;
      this.data.api.dailyResetTime = now.toISOString();
      console.log('[LEDGER] API daily budget reset');
    }

    // API monthly reset
    if (this.shouldReset(this.data.api.monthlyResetTime, 30 * 24 * 60 * 60 * 1000)) {
      this.data.api.monthlySpendUsd = 0;
      this.data.api.monthlyTokens = 0;
      this.data.api.monthlyResetTime = now.toISOString();
      console.log('[LEDGER] API monthly budget reset');
    }

    // Per-user resets
    for (const [userId, userData] of Object.entries(this.data.users || {})) {
      // Daily reset
      if (this.shouldReset(userData.dailyResetTime, 24 * 60 * 60 * 1000)) {
        userData.dailySpendUsd = 0;
        userData.dailyTokens = 0;
        userData.dailyResetTime = now.toISOString();
        console.log(`[LEDGER] User ${userId} daily reset`);
      }
      
      // Monthly reset  
      if (this.shouldReset(userData.monthlyResetTime, 30 * 24 * 60 * 60 * 1000)) {
        userData.monthlySpendUsd = 0;
        userData.monthlyTokens = 0;
        userData.monthlyResetTime = now.toISOString();
        console.log(`[LEDGER] User ${userId} monthly reset`);
      }
    }

    await this.save();
  }

  /**
   * Check if a reset time has passed
   * @param {string|null} resetTime - ISO timestamp of last reset
   * @param {number} intervalMs - Reset interval in milliseconds
   * @returns {boolean}
   */
  shouldReset(resetTime, intervalMs) {
    if (!resetTime) return true;
    return Date.now() - new Date(resetTime).getTime() > intervalMs;
  }

  /**
   * Check if a backend has budget available for estimated tokens
   * @param {string} backend - Backend name (claudeCode, codex, api, local)
   * @param {number} estimatedTokens - Estimated token usage
   * @returns {Promise<{allowed: boolean, reason?: string}>}
   */
  async checkBudget(backend, estimatedTokens = 0) {
    if (!this.loaded) await this.load();
    await this.checkResets();

    const config = require('./config.json');

    switch (backend) {
      case 'claudeCode':
        if (!config.backends.claudeCode.enabled) {
          return { allowed: false, reason: 'Claude Code disabled' };
        }
        const sessionUsage = this.data.claudeCode.sessionUsagePercent;
        const weeklyUsage = this.data.claudeCode.weeklyUsagePercent;
        const maxUsage = config.backends.claudeCode.maxAutoUsagePercent;
        
        if (sessionUsage >= maxUsage) {
          return { allowed: false, reason: `Session usage at ${sessionUsage}%, limit ${maxUsage}%` };
        }
        if (weeklyUsage >= maxUsage) {
          return { allowed: false, reason: `Weekly usage at ${weeklyUsage}%, limit ${maxUsage}%` };
        }
        return { allowed: true };

      case 'codex':
        if (!config.backends.codex.enabled) {
          return { allowed: false, reason: 'Codex disabled' };
        }
        const codexSession = this.data.codex.sessionUsagePercent;
        const codexWeekly = this.data.codex.weeklyUsagePercent;
        
        if (codexSession >= 70) {
          return { allowed: false, reason: `Codex session usage at ${codexSession}%` };
        }
        if (codexWeekly >= 70) {
          return { allowed: false, reason: `Codex weekly usage at ${codexWeekly}%` };
        }
        return { allowed: true };

      case 'api':
        if (!config.backends.api.enabled) {
          return { allowed: false, reason: 'API backend disabled' };
        }
        
        const estimatedCost = this.estimateApiCost(estimatedTokens);
        const dailyRemaining = config.backends.api.dailyBudgetUsd - this.data.api.dailySpendUsd;
        const monthlyRemaining = config.backends.api.monthlyBudgetUsd - this.data.api.monthlySpendUsd;
        
        if (estimatedCost > dailyRemaining) {
          return { allowed: false, reason: `Estimated cost $${estimatedCost.toFixed(2)} exceeds daily remaining $${dailyRemaining.toFixed(2)}` };
        }
        if (estimatedCost > monthlyRemaining) {
          return { allowed: false, reason: `Estimated cost $${estimatedCost.toFixed(2)} exceeds monthly remaining $${monthlyRemaining.toFixed(2)}` };
        }
        return { allowed: true };

      case 'local':
        if (!config.backends.local.enabled) {
          return { allowed: false, reason: 'Local backend disabled' };
        }
        return { allowed: true }; // Local is always allowed (free)

      default:
        return { allowed: false, reason: `Unknown backend: ${backend}` };
    }
  }

  /**
   * Record actual usage after task completion
   * @param {string} backend - Backend name
   * @param {Object} task - Task object
   * @param {number|null} actualTokens - Actual tokens used (if available)
   * @param {string|null} output - Task output for fallback estimation
   * @param {string} userId - User ID for cost tracking (defaults to "meir")
   * @returns {Promise<void>}
   */
  async recordUsage(backend, task, actualTokens = null, output = null, userId = 'meir') {
    if (!this.loaded) await this.load();

    const tokens = actualTokens || this.estimateTokens(output);

    switch (backend) {
      case 'claudeCode': {
        const sessionIncrease = Math.min(tokens / 50000 * 10, 15);
        this.data.claudeCode.sessionUsagePercent += sessionIncrease;
        this.data.claudeCode.weeklyUsagePercent += sessionIncrease;
        this.data.claudeCode.tasksCompleted++;
        // Track savings — what this would have cost on API
        const ccSaved = this.estimateApiCost(tokens);
        this._recordSavings(ccSaved);
        break;
      }

      case 'codex': {
        const codexIncrease = Math.min(tokens / 50000 * 10, 15);
        this.data.codex.sessionUsagePercent += codexIncrease;
        this.data.codex.weeklyUsagePercent += codexIncrease;
        this.data.codex.tasksCompleted++;
        const cxSaved = this.estimateApiCost(tokens);
        this._recordSavings(cxSaved);
        break;
      }

      case 'api': {
        const cost = this.estimateApiCost(tokens);
        this.data.api.dailySpendUsd += cost;
        this.data.api.monthlySpendUsd += cost;
        this.data.api.dailyTokens += tokens;
        this.data.api.monthlyTokens += tokens;
        this.data.api.tasksCompleted++;
        
        // Track per-user costs
        if (!this.data.users[userId]) {
          this.data.users[userId] = {
            dailySpendUsd: 0,
            monthlySpendUsd: 0,
            dailyTokens: 0,
            monthlyTokens: 0,
            tasksCompleted: 0,
            dailyResetTime: null,
            monthlyResetTime: null
          };
        }
        this.data.users[userId].dailySpendUsd += cost;
        this.data.users[userId].monthlySpendUsd += cost;
        this.data.users[userId].dailyTokens += tokens;
        this.data.users[userId].monthlyTokens += tokens;
        this.data.users[userId].tasksCompleted++;
        break;
      }

      case 'local': {
        this.data.local.taskCount++;
        this.data.local.totalTasks++;
        const localSaved = this.estimateApiCost(tokens);
        this._recordSavings(localSaved);
        break;
      }
    }

    console.log(`[LEDGER] Recorded usage for ${backend}: ${tokens} tokens`);
    await this.save();
  }

  /**
   * Estimate token count from output text (fallback method)
   * @param {string|null} output - Output text
   * @returns {number} Estimated token count
   */
  estimateTokens(output) {
    if (!output) return 1000; // Default estimate
    return Math.ceil(output.length / 4); // Rough GPT tokenization estimate
  }

  /**
   * Estimate API cost from token count
   * @param {number} tokens - Token count
   * @returns {number} Estimated cost in USD
   */
  estimateApiCost(tokens) {
    // Claude Sonnet 4 pricing: ~$3/1M input tokens, ~$15/1M output tokens
    // Assume 70/30 split input/output
    const inputTokens = tokens * 0.7;
    const outputTokens = tokens * 0.3;
    return (inputTokens * 3 / 1000000) + (outputTokens * 15 / 1000000);
  }

  /**
   * Reset session counters for a specific backend
   * @param {string} backend - Backend name
   * @returns {Promise<void>}
   */
  async resetSession(backend) {
    if (!this.loaded) await this.load();

    switch (backend) {
      case 'claudeCode':
        this.data.claudeCode.sessionUsagePercent = 0;
        this.data.claudeCode.sessionResetTime = new Date().toISOString();
        break;
      case 'codex':
        this.data.codex.sessionUsagePercent = 0;
        this.data.codex.sessionResetTime = new Date().toISOString();
        break;
      case 'api':
        this.data.api.dailySpendUsd = 0;
        this.data.api.dailyTokens = 0;
        this.data.api.dailyResetTime = new Date().toISOString();
        break;
      case 'local':
        this.data.local.taskCount = 0;
        break;
    }

    console.log(`[LEDGER] Session reset for ${backend}`);
    await this.save();
  }

  /**
   * Get comprehensive usage report
   * @returns {Promise<Object>} Usage report
   */
  async getReport() {
    if (!this.loaded) await this.load();
    await this.checkResets();

    const config = require('./config.json');

    return {
      claudeCode: {
        sessionUsage: `${this.data.claudeCode.sessionUsagePercent.toFixed(1)}%`,
        weeklyUsage: `${this.data.claudeCode.weeklyUsagePercent.toFixed(1)}%`,
        tasksCompleted: this.data.claudeCode.tasksCompleted,
        available: this.data.claudeCode.sessionUsagePercent < config.backends.claudeCode.maxAutoUsagePercent
      },
      codex: {
        sessionUsage: `${this.data.codex.sessionUsagePercent.toFixed(1)}%`,
        weeklyUsage: `${this.data.codex.weeklyUsagePercent.toFixed(1)}%`,
        tasksCompleted: this.data.codex.tasksCompleted,
        available: this.data.codex.sessionUsagePercent < 70
      },
      api: {
        dailySpend: `$${this.data.api.dailySpendUsd.toFixed(2)}`,
        monthlySpend: `$${this.data.api.monthlySpendUsd.toFixed(2)}`,
        dailyBudgetRemaining: `$${(config.backends.api.dailyBudgetUsd - this.data.api.dailySpendUsd).toFixed(2)}`,
        monthlyBudgetRemaining: `$${(config.backends.api.monthlyBudgetUsd - this.data.api.monthlySpendUsd).toFixed(2)}`,
        dailyTokens: this.data.api.dailyTokens.toLocaleString(),
        monthlyTokens: this.data.api.monthlyTokens.toLocaleString(),
        tasksCompleted: this.data.api.tasksCompleted
      },
      local: {
        taskCount: this.data.local.taskCount,
        totalTasks: this.data.local.totalTasks,
        available: true
      },
      lastUpdated: this.data.lastUpdated
    };
  }

  /**
   * Record a savings entry (what a subscription/local task would have cost on API)
   */
  _recordSavings(amountUsd) {
    if (!this.data.savings) {
      this.data.savings = { entries: [], totalSaved: 0 };
    }
    this.data.savings.entries.push({
      amount: amountUsd,
      timestamp: new Date().toISOString()
    });
    this.data.savings.totalSaved += amountUsd;
    // Keep only last 90 days of entries
    const cutoff = Date.now() - (90 * 24 * 60 * 60 * 1000);
    this.data.savings.entries = this.data.savings.entries.filter(
      e => new Date(e.timestamp).getTime() > cutoff
    );
  }

  /**
   * Get savings breakdown
   */
  getSavings() {
    const entries = this.data.savings?.entries || [];
    const now = Date.now();
    const dayAgo = now - 24 * 60 * 60 * 1000;
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
    const monthAgo = now - 30 * 24 * 60 * 60 * 1000;

    return {
      totalSaved: this.data.savings?.totalSaved || 0,
      todaySaved: entries.filter(e => new Date(e.timestamp).getTime() > dayAgo).reduce((s, e) => s + e.amount, 0),
      weekSaved: entries.filter(e => new Date(e.timestamp).getTime() > weekAgo).reduce((s, e) => s + e.amount, 0),
      monthSaved: entries.filter(e => new Date(e.timestamp).getTime() > monthAgo).reduce((s, e) => s + e.amount, 0),
      taskCount: entries.length
    };
  }

  /**
   * Get per-user cost breakdown
   * @returns {Object} User costs indexed by userId
   */
  getUserCosts() {
    const users = {};
    for (const [userId, userData] of Object.entries(this.data.users || {})) {
      users[userId] = {
        dailySpend: Math.round(userData.dailySpendUsd * 100) / 100,
        monthlySpend: Math.round(userData.monthlySpendUsd * 100) / 100,
        dailyTokens: userData.dailyTokens || 0,
        monthlyTokens: userData.monthlyTokens || 0,
        tasksCompleted: userData.tasksCompleted || 0
      };
    }
    return users;
  }
}

module.exports = new Ledger();