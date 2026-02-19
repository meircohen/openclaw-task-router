const fs = require('fs').promises;
const path = require('path');
const EventEmitter = require('events');

/**
 * Rate Governor for OpenClaw Task Router
 * Subscription-aware rate limiter with adaptive learning and throttle recovery
 * 
 * Features:
 * - 60-minute sliding window request tracking
 * - Adaptive limits that tighten on throttle events
 * - Soft limits (delays) and hard limits (fallback suggestions)
 * - 15-minute cooldown periods after throttling
 * - Persistent state with learning from throttle patterns
 */

const DEFAULT_LIMITS = {
  claudeCode: 20,    // requests per hour
  codex: 30,         // requests per hour  
  local: Infinity,   // unlimited
  api: Infinity      // unlimited
};

const THROTTLE_MULTIPLIER = 0.8; // Reduce limit to 80% of pre-throttle count
const SOFT_LIMIT_THRESHOLD = 0.8; // Soft limit at 80% of max
const SOFT_LIMIT_DELAY_MS = 5000; // 5 second delay for soft limits
const COOLDOWN_PERIOD_MS = 15 * 60 * 1000; // 15 minutes
const WINDOW_SIZE_MS = 60 * 60 * 1000; // 60 minutes

class RateGovernor extends EventEmitter {
  constructor() {
    super();
    const dataDir = process.env.ROUTER_TEST_MODE ? process.env.ROUTER_TEST_DATA_DIR : path.join(__dirname, 'data');
    this.statePath = path.join(dataDir, 'rate-governor-state.json');
    this.data = {
      backends: {
        claudeCode: {
          requests: [], // { timestamp, success }
          currentLimit: DEFAULT_LIMITS.claudeCode,
          throttleEvents: [], // { timestamp, preThrottleCount, newLimit, cooldownUntil }
          lastThrottle: null,
          cooldownUntil: null,
          throttleInProgress: false
        },
        codex: {
          requests: [],
          currentLimit: DEFAULT_LIMITS.codex,
          throttleEvents: [],
          lastThrottle: null,
          cooldownUntil: null,
          throttleInProgress: false
        },
        local: {
          requests: [],
          currentLimit: DEFAULT_LIMITS.local,
          throttleEvents: [],
          lastThrottle: null,
          cooldownUntil: null,
          throttleInProgress: false
        },
        api: {
          requests: [],
          currentLimit: DEFAULT_LIMITS.api,
          throttleEvents: [],
          lastThrottle: null,
          cooldownUntil: null,
          throttleInProgress: false
        }
      },
      learnings: {
        totalThrottleEvents: 0,
        averageRecoveryTimeMs: 0,
        mostProblematicBackend: null,
        adaptiveTightening: {},
        lastAnalysisDate: new Date().toISOString()
      },
      lastUpdated: new Date().toISOString()
    };
    this.loaded = false;
  }

  // ─── Persistence ─────────────────────────────────────────────

  async load() {
    try {
      const raw = await fs.readFile(this.statePath, 'utf8');
      const saved = JSON.parse(raw);
      
      // Merge saved data with defaults (preserves new backends if added later)
      this.data = {
        ...this.data,
        ...saved,
        backends: {
          ...this.data.backends,
          ...saved.backends
        }
      };
      
      // Clean expired cooldowns and old requests
      this._cleanExpiredData();
      
      this.loaded = true;
      console.log('[RATE-GOVERNOR] State loaded');
    } catch (err) {
      if (err.code === 'ENOENT') {
        console.log('[RATE-GOVERNOR] No saved state, starting with conservative defaults');
      } else {
        console.error('[RATE-GOVERNOR] Error loading state:', err.message);
      }
      this.loaded = true;
      await this.save();
    }
  }

  async save() {
    try {
      this.data.lastUpdated = new Date().toISOString();
      await fs.mkdir(path.dirname(this.statePath), { recursive: true });
      await fs.writeFile(this.statePath, JSON.stringify(this.data, null, 2));
    } catch (err) {
      console.error('[RATE-GOVERNOR] Error saving state:', err.message);
    }
  }

  // ─── Internal helpers ────────────────────────────────────────

  _ensureBackend(backend) {
    if (!this.data.backends[backend]) {
      this.data.backends[backend] = {
        requests: [],
        currentLimit: DEFAULT_LIMITS[backend] || 30,
        throttleEvents: [],
        lastThrottle: null,
        cooldownUntil: null,
        throttleInProgress: false
      };
    }
    return this.data.backends[backend];
  }

  /**
   * Configure rate limits from backend config
   * @param {Object} config - Backend configuration from config.json
   */
  configureRateLimits(config) {
    if (!config || !config.backends) return;

    for (const [backend, backendConfig] of Object.entries(config.backends)) {
      if (backendConfig.rateLimit !== undefined) {
        const backendData = this._ensureBackend(backend);
        // If rateLimit is null, undefined, 0, treat as unlimited (Infinity)
        if (backendConfig.rateLimit === null || 
            backendConfig.rateLimit === undefined || 
            backendConfig.rateLimit === 0) {
          backendData.currentLimit = Infinity;
        } else {
          backendData.currentLimit = backendConfig.rateLimit;
        }
        console.log(`[RATE-GOVERNOR] Configured ${backend} rate limit: ${backendData.currentLimit === Infinity ? 'unlimited' : backendData.currentLimit}/hour`);
      }
    }
  }

  _cleanExpiredData() {
    const now = Date.now();
    const windowStart = now - WINDOW_SIZE_MS;

    for (const [backend, data] of Object.entries(this.data.backends)) {
      // Remove old requests outside the sliding window
      data.requests = data.requests.filter(r => r.timestamp > windowStart);
      
      // Clear expired cooldowns
      if (data.cooldownUntil && now > new Date(data.cooldownUntil).getTime()) {
        data.cooldownUntil = null;
        data.throttleInProgress = false;
        console.log(`[RATE-GOVERNOR] ${backend}: Cooldown period expired`);
        this.emit('cooldown-expired', { backend });
      }
    }
  }

  _getCurrentHourRequests(backend) {
    const backendData = this._ensureBackend(backend);
    const now = Date.now();
    const windowStart = now - WINDOW_SIZE_MS;
    
    return backendData.requests.filter(r => r.timestamp > windowStart);
  }

  _getFallbackBackend(currentBackend) {
    const fallbackChain = ['claudeCode', 'codex', 'api', 'local'];
    const currentIndex = fallbackChain.indexOf(currentBackend);
    
    if (currentIndex !== -1 && currentIndex < fallbackChain.length - 1) {
      return fallbackChain[currentIndex + 1];
    }
    
    // Try to find any backend that's not rate limited
    for (const backend of fallbackChain) {
      if (backend !== currentBackend) {
        const check = this.canUse(backend);
        if (check.allowed) return backend;
      }
    }
    
    return 'local'; // Last resort
  }

  // ─── Public API ──────────────────────────────────────────────

  /**
   * Check if a backend can be used (main rate limiting logic)
   * @param {string} backend - Backend name
   * @returns {{ allowed: boolean, delayMs?: number, suggestedBackend?: string, reason?: string }}
   */
  canUse(backend) {
    if (!this.loaded) return { allowed: true }; // Allow if not loaded yet
    
    this._cleanExpiredData();
    const backendData = this._ensureBackend(backend);
    
    // Unlimited backends always allowed (null, undefined, 0, or Infinity = unlimited)
    if (backendData.currentLimit === Infinity || 
        backendData.currentLimit === null || 
        backendData.currentLimit === undefined || 
        backendData.currentLimit === 0) {
      return { allowed: true };
    }
    
    // Check if in cooldown period
    if (backendData.cooldownUntil && Date.now() < new Date(backendData.cooldownUntil).getTime()) {
      const suggestedBackend = this._getFallbackBackend(backend);
      return {
        allowed: false,
        suggestedBackend,
        reason: `Backend in throttle cooldown until ${backendData.cooldownUntil}`
      };
    }
    
    const currentRequests = this._getCurrentHourRequests(backend);
    const requestCount = currentRequests.length;
    const currentLimit = backendData.currentLimit;
    const softLimit = Math.floor(currentLimit * SOFT_LIMIT_THRESHOLD);
    
    console.log(`[RATE-GOVERNOR] ${backend}: ${requestCount}/${currentLimit} requests in last hour`);
    
    // Hard limit check
    if (requestCount >= currentLimit) {
      const suggestedBackend = this._getFallbackBackend(backend);
      return {
        allowed: false,
        suggestedBackend,
        reason: `Hard limit reached: ${requestCount}/${currentLimit} requests/hour`
      };
    }
    
    // Soft limit check  
    if (requestCount >= softLimit) {
      return {
        allowed: true,
        delayMs: SOFT_LIMIT_DELAY_MS,
        reason: `Soft limit: ${requestCount}/${softLimit} requests/hour, adding delay`
      };
    }
    
    return { allowed: true };
  }

  /**
   * Record a request to a backend
   * @param {string} backend - Backend name
   * @param {boolean} success - Whether the request succeeded
   */
  recordRequest(backend, success = true) {
    if (!this.loaded) return;
    
    const backendData = this._ensureBackend(backend);
    backendData.requests.push({
      timestamp: Date.now(),
      success
    });
    
    console.log(`[RATE-GOVERNOR] Recorded ${success ? 'successful' : 'failed'} request for ${backend}`);
    this.save();
  }

  /**
   * Record a throttle event (when backend hits rate limits)
   * @param {string} backend - Backend name
   * @param {Object} details - Additional throttle details
   */
  recordThrottle(backend, details = {}) {
    if (!this.loaded) return;
    
    const backendData = this._ensureBackend(backend);
    const currentRequests = this._getCurrentHourRequests(backend);
    const preThrottleCount = currentRequests.length;
    
    // Calculate new adaptive limit
    const newLimit = Math.max(1, Math.floor(preThrottleCount * THROTTLE_MULTIPLIER));
    
    const now = Date.now();
    const cooldownUntil = new Date(now + COOLDOWN_PERIOD_MS).toISOString();
    
    const throttleEvent = {
      timestamp: now,
      preThrottleCount,
      previousLimit: backendData.currentLimit,
      newLimit,
      cooldownUntil,
      details,
      ...details
    };
    
    // Update backend state
    backendData.throttleEvents.push(throttleEvent);
    backendData.currentLimit = newLimit;
    backendData.lastThrottle = new Date(now).toISOString();
    backendData.cooldownUntil = cooldownUntil;
    backendData.throttleInProgress = true;
    
    // Update global learnings
    this.data.learnings.totalThrottleEvents++;
    this._updateLearnings();
    
    console.log(`[RATE-GOVERNOR] ${backend}: THROTTLED! Limit ${throttleEvent.previousLimit} → ${newLimit} (${preThrottleCount} requests preceded throttle). Cooldown until ${cooldownUntil}`);
    
    this.emit('throttle-event', {
      backend,
      event: throttleEvent,
      newLimit,
      cooldownUntil
    });
    
    this.save();
  }

  /**
   * Update learning patterns from throttle history
   * @private
   */
  _updateLearnings() {
    const learnings = this.data.learnings;
    let totalRecoveryTime = 0;
    let recoveryCount = 0;
    const backendThrottleCounts = {};
    
    for (const [backend, data] of Object.entries(this.data.backends)) {
      backendThrottleCounts[backend] = data.throttleEvents.length;
      
      // Calculate recovery times
      for (let i = 0; i < data.throttleEvents.length - 1; i++) {
        const currentThrottle = data.throttleEvents[i];
        const nextThrottle = data.throttleEvents[i + 1];
        const recoveryTime = nextThrottle.timestamp - currentThrottle.timestamp;
        totalRecoveryTime += recoveryTime;
        recoveryCount++;
      }
    }
    
    // Average recovery time
    if (recoveryCount > 0) {
      learnings.averageRecoveryTimeMs = Math.round(totalRecoveryTime / recoveryCount);
    }
    
    // Most problematic backend
    const sortedBackends = Object.entries(backendThrottleCounts)
      .sort(([,a], [,b]) => b - a)
      .filter(([,count]) => count > 0);
    
    if (sortedBackends.length > 0) {
      learnings.mostProblematicBackend = sortedBackends[0][0];
    }
    
    // Adaptive tightening patterns
    for (const [backend, data] of Object.entries(this.data.backends)) {
      if (data.throttleEvents.length > 0) {
        const recentThrottles = data.throttleEvents.slice(-5); // Last 5 throttles
        const avgPreThrottleCount = recentThrottles.reduce((sum, e) => sum + e.preThrottleCount, 0) / recentThrottles.length;
        learnings.adaptiveTightening[backend] = {
          frequency: data.throttleEvents.length,
          avgPreThrottleCount: Math.round(avgPreThrottleCount),
          currentLimit: data.currentLimit,
          effectiveness: this._calculateEffectiveness(data)
        };
      }
    }
    
    learnings.lastAnalysisDate = new Date().toISOString();
  }

  /**
   * Calculate effectiveness of current limits for a backend
   * @private
   */
  _calculateEffectiveness(backendData) {
    const recent = backendData.requests.filter(r => Date.now() - r.timestamp < WINDOW_SIZE_MS);
    const throttlesSince = backendData.throttleEvents.filter(e => Date.now() - e.timestamp < WINDOW_SIZE_MS * 24); // Last 24 hours
    
    if (recent.length === 0) return 100; // No recent activity = perfect
    
    const successRate = recent.filter(r => r.success).length / recent.length;
    const throttleFrequency = throttlesSince.length;
    
    return Math.max(0, Math.round((successRate * 100) - (throttleFrequency * 20)));
  }

  /**
   * Get comprehensive status of all backends
   * @returns {Object} Status object with backend details
   */
  getStatus() {
    if (!this.loaded) return { loaded: false, message: 'Rate governor not loaded' };
    
    this._cleanExpiredData();
    const status = {
      loaded: true,
      backends: {},
      summary: {
        totalRequests: 0,
        totalThrottles: this.data.learnings.totalThrottleEvents,
        averageRecoveryTimeMinutes: Math.round(this.data.learnings.averageRecoveryTimeMs / 60000),
        mostProblematicBackend: this.data.learnings.mostProblematicBackend
      },
      lastUpdated: this.data.lastUpdated
    };
    
    // Ensure all default backends exist
    const allBackends = ['claudeCode', 'codex', 'local', 'api'];
    for (const backend of allBackends) {
      this._ensureBackend(backend);
    }
    
    for (const [backend, data] of Object.entries(this.data.backends)) {
      const currentRequests = this._getCurrentHourRequests(backend);
      const requestCount = currentRequests.length;
      const utilization = (data.currentLimit === Infinity || data.currentLimit === null) 
        ? 0 : (requestCount / data.currentLimit) * 100;
      
      status.backends[backend] = {
        requestsLastHour: requestCount,
        currentLimit: data.currentLimit,
        defaultLimit: DEFAULT_LIMITS[backend],
        utilization: Math.round(utilization * 10) / 10,
        throttleEvents: data.throttleEvents.length,
        lastThrottle: data.lastThrottle,
        inCooldown: !!(data.cooldownUntil && Date.now() < new Date(data.cooldownUntil).getTime()),
        cooldownUntil: data.cooldownUntil,
        canUse: this.canUse(backend),
        successRate: this._calculateSuccessRate(currentRequests)
      };
      
      status.summary.totalRequests += requestCount;
    }
    
    return status;
  }

  /**
   * Calculate success rate for a set of requests
   * @private
   */
  _calculateSuccessRate(requests) {
    if (requests.length === 0) return 100;
    const successes = requests.filter(r => r.success).length;
    return Math.round((successes / requests.length) * 100 * 10) / 10;
  }

  /**
   * Get learning insights and recommendations
   * @returns {Object} Learning insights
   */
  getLearnings() {
    if (!this.loaded) return { loaded: false };
    
    const insights = {
      ...this.data.learnings,
      recommendations: [],
      patterns: {}
    };
    
    // Generate recommendations
    for (const [backend, data] of Object.entries(this.data.backends)) {
      if (data.throttleEvents.length > 3) {
        insights.recommendations.push(`Consider increasing capacity or reducing usage for ${backend} (${data.throttleEvents.length} throttle events)`);
      }
      
      const currentRequests = this._getCurrentHourRequests(backend);
      const utilization = data.currentLimit === Infinity ? 0 : (currentRequests.length / data.currentLimit);
      
      if (utilization > 0.9) {
        insights.recommendations.push(`${backend} is at ${Math.round(utilization * 100)}% capacity - consider load balancing`);
      }
      
      // Pattern detection
      if (data.throttleEvents.length >= 2) {
        const intervals = [];
        for (let i = 1; i < data.throttleEvents.length; i++) {
          intervals.push(data.throttleEvents[i].timestamp - data.throttleEvents[i-1].timestamp);
        }
        const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        insights.patterns[backend] = {
          throttleFrequency: `Every ${Math.round(avgInterval / 60000)} minutes average`,
          trend: data.throttleEvents.length > 5 ? 'increasing' : 'stable'
        };
      }
    }
    
    // Global insights
    if (insights.totalThrottleEvents === 0) {
      insights.recommendations.push('No throttle events recorded - current limits appear appropriate');
    } else if (insights.totalThrottleEvents > 10) {
      insights.recommendations.push('High throttle frequency detected - consider reviewing usage patterns');
    }
    
    return insights;
  }

  /**
   * Reset limits for a backend (admin function)
   * @param {string} backend - Backend name
   * @param {number} newLimit - New limit (optional, defaults to original)
   */
  resetBackend(backend, newLimit = null) {
    const backendData = this._ensureBackend(backend);
    
    backendData.currentLimit = newLimit || DEFAULT_LIMITS[backend] || 30;
    backendData.cooldownUntil = null;
    backendData.throttleInProgress = false;
    backendData.requests = []; // Clear history
    
    console.log(`[RATE-GOVERNOR] ${backend}: Reset to limit ${backendData.currentLimit}`);
    this.emit('backend-reset', { backend, newLimit: backendData.currentLimit });
    this.save();
  }

  /**
   * Manually adjust a backend's limit
   * @param {string} backend - Backend name  
   * @param {number} limit - New limit
   */
  adjustLimit(backend, limit) {
    const backendData = this._ensureBackend(backend);
    const oldLimit = backendData.currentLimit;
    backendData.currentLimit = Math.max(1, limit);
    
    console.log(`[RATE-GOVERNOR] ${backend}: Limit adjusted ${oldLimit} → ${limit}`);
    this.emit('limit-adjusted', { backend, oldLimit, newLimit: limit });
    this.save();
  }
}

module.exports = new RateGovernor();