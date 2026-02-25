const fs = require('fs').promises;
const path = require('path');
const EventEmitter = require('events');

// Lazy load to avoid circular dependency
function getRateGovernor() {
  return require('./rate-governor');
}

/**
 * Circuit Breaker Pattern for OpenClaw Task Router
 * Protects backends from cascading failures with CLOSED/OPEN/HALF-OPEN states.
 *
 * - CLOSED (normal): requests flow through
 * - OPEN (broken): all requests rejected, returns fallback immediately
 * - HALF-OPEN (testing): allows 1 probe request to test recovery
 *
 * Triggers:
 * - 5 failures in 15 min → OPEN for 10 min
 * - After 10 min cooldown → HALF-OPEN
 * - 1 success in HALF-OPEN → CLOSED
 * - 1 failure in HALF-OPEN → OPEN again (reset cooldown)
 */

const STATES = { CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF-OPEN' };

const DEFAULTS = {
  failureThreshold: 5,       // failures before tripping
  failureWindowMs: 15 * 60 * 1000,  // 15 minutes
  cooldownMs: 10 * 60 * 1000,       // 10 minutes in OPEN before HALF-OPEN
};

class CircuitBreaker extends EventEmitter {
  constructor() {
    super();
    const dataDir = process.env.ROUTER_TEST_MODE ? process.env.ROUTER_TEST_DATA_DIR : path.join(__dirname, 'data');
    this.statePath = path.join(dataDir, 'circuit-breaker-state.json');
    this.breakers = {}; // backend → { state, failures: [{ts}], lastFailure, cooldownEnds, halfOpenProbeActive }
    this.config = DEFAULTS;
    this.loaded = false;
  }

  // ─── Persistence ─────────────────────────────────────────────

  async load() {
    try {
      const raw = await fs.readFile(this.statePath, 'utf8');
      const saved = JSON.parse(raw);
      this.breakers = saved.breakers || {};
      // Merge config overrides if present
      if (saved.config) {
        this.config = { ...DEFAULTS, ...saved.config };
      }
      this.loaded = true;
      console.log('[CIRCUIT-BREAKER] State loaded');
    } catch (err) {
      if (err.code === 'ENOENT') {
        console.log('[CIRCUIT-BREAKER] No saved state, starting fresh');
      } else {
        console.error('[CIRCUIT-BREAKER] Error loading state:', err.message);
      }
      this.loaded = true;
      await this.save();
    }
  }

  async save() {
    try {
      await fs.mkdir(path.dirname(this.statePath), { recursive: true });
      await fs.writeFile(this.statePath, JSON.stringify({
        breakers: this.breakers,
        config: this.config,
        lastSaved: new Date().toISOString()
      }, null, 2));
    } catch (err) {
      console.error('[CIRCUIT-BREAKER] Error saving state:', err.message);
    }
  }

  // ─── Internal helpers ────────────────────────────────────────

  _ensureBreaker(backend) {
    if (!this.breakers[backend]) {
      this.breakers[backend] = {
        state: STATES.CLOSED,
        failures: [],
        lastFailure: null,
        cooldownEnds: null,
        halfOpenProbeActive: false
      };
    }
    return this.breakers[backend];
  }

  /**
   * Prune failures outside the rolling window
   */
  _pruneFailures(breaker) {
    const cutoff = Date.now() - this.config.failureWindowMs;
    breaker.failures = breaker.failures.filter(f => f.ts > cutoff);
  }

  /**
   * Check if an OPEN breaker should transition to HALF-OPEN
   */
  _checkCooldownExpiry(backend, breaker) {
    if (breaker.state === STATES.OPEN && breaker.cooldownEnds && Date.now() >= breaker.cooldownEnds) {
      breaker.state = STATES.HALF_OPEN;
      breaker.halfOpenProbeActive = false;
      console.log(`[CIRCUIT-BREAKER] ${backend}: OPEN → HALF-OPEN (cooldown expired)`);
      this.emit('breaker-half-open', { backend, breaker: this._sanitize(breaker) });
      this.save();
    }
  }

  _sanitize(breaker) {
    return {
      state: breaker.state,
      failures: breaker.failures.length,
      lastFailure: breaker.lastFailure,
      cooldownEnds: breaker.cooldownEnds
    };
  }

  // ─── Public API ──────────────────────────────────────────────

  /**
   * Can we send a request to this backend?
   * @param {string} backend
   * @returns {boolean}
   */
  canExecute(backend) {
    const breaker = this._ensureBreaker(backend);
    this._checkCooldownExpiry(backend, breaker);

    switch (breaker.state) {
      case STATES.CLOSED:
        return true;

      case STATES.OPEN:
        return false;

      case STATES.HALF_OPEN:
        // Allow exactly one probe request
        if (!breaker.halfOpenProbeActive) {
          breaker.halfOpenProbeActive = true;
          console.log(`[CIRCUIT-BREAKER] ${backend}: HALF-OPEN probe allowed`);
          return true;
        }
        return false; // Already probing, reject others

      default:
        return true;
    }
  }

  /**
   * Record a successful request
   * @param {string} backend
   */
  recordSuccess(backend) {
    const breaker = this._ensureBreaker(backend);

    if (breaker.state === STATES.HALF_OPEN) {
      // Recovery confirmed — close the breaker
      breaker.state = STATES.CLOSED;
      breaker.failures = [];
      breaker.cooldownEnds = null;
      breaker.halfOpenProbeActive = false;
      console.log(`[CIRCUIT-BREAKER] ${backend}: HALF-OPEN → CLOSED (recovery confirmed)`);
      this.emit('breaker-closed', { backend, breaker: this._sanitize(breaker) });
      this.save();
    }
    // In CLOSED state, success is a no-op for the breaker
  }

  /**
   * Record a failed request
   * @param {string} backend
   * @param {Object} details - Additional failure details (e.g., { rateLimited: true, isProbe: true })
   */
  recordFailure(backend, details = {}) {
    const breaker = this._ensureBreaker(backend);
    const now = Date.now();

    breaker.lastFailure = new Date(now).toISOString();

    if (breaker.state === STATES.HALF_OPEN) {
      // Probe failed — back to OPEN
      breaker.state = STATES.OPEN;
      breaker.cooldownEnds = new Date(now + this.config.cooldownMs).toISOString();
      breaker.halfOpenProbeActive = false;
      console.log(`[CIRCUIT-BREAKER] ${backend}: HALF-OPEN → OPEN (probe failed, cooldown reset)`);
      this.emit('breaker-open', { backend, reason: 'half-open probe failed', breaker: this._sanitize(breaker) });
      this.save();
      return;
    }

    // Check if this is a rate limiting failure and notify rate governor
    const isRateLimit = details.rateLimited || details.throttled || 
      (details.error && (
        details.error.toLowerCase().includes('rate limit') ||
        details.error.toLowerCase().includes('throttle') ||
        details.error.toLowerCase().includes('quota') ||
        details.error.includes('429') ||
        details.error.toLowerCase().includes('usage limit') ||
        details.error.toLowerCase().includes('too many requests')
      ));

    if (isRateLimit) {
      try {
        const rateGovernor = getRateGovernor();
        rateGovernor.recordThrottle(backend, {
          ...details,
          detectedBy: 'circuit-breaker',
          timestamp: now
        });
        console.log(`[CIRCUIT-BREAKER] ${backend}: Rate limit throttle recorded in rate governor (${details.error || 'rate limit detected'})`);
      } catch (err) {
        console.error(`[CIRCUIT-BREAKER] Error recording throttle: ${err.message}`);
      }
    }

    // CLOSED state: accumulate failures (but skip probe failures)
    if (!details.isProbe) {
      breaker.failures.push({ ts: now });
      this._pruneFailures(breaker);

      if (breaker.failures.length >= this.config.failureThreshold) {
        breaker.state = STATES.OPEN;
        breaker.cooldownEnds = new Date(now + this.config.cooldownMs).toISOString();
        console.log(`[CIRCUIT-BREAKER] ${backend}: CLOSED → OPEN (${breaker.failures.length} failures in window)`);
        this.emit('breaker-open', { backend, reason: `${breaker.failures.length} failures in ${this.config.failureWindowMs / 60000} min`, breaker: this._sanitize(breaker) });
        this.save();
      } else {
        this.save();
      }
    } else {
      console.log(`[CIRCUIT-BREAKER] ${backend}: Probe failure ignored (not counted toward threshold)`);
      this.save();
    }
  }

  /**
   * Get state for a single backend
   * @param {string} backend
   * @returns {{ state: string, failures: number, lastFailure: string|null, cooldownEnds: string|null }}
   */
  getState(backend) {
    const breaker = this._ensureBreaker(backend);
    this._checkCooldownExpiry(backend, breaker);
    return this._sanitize(breaker);
  }

  /**
   * Get all breaker states
   * @returns {Object} backend → sanitized state
   */
  getAll() {
    const result = {};
    const backends = ['claudeCode', 'codex', 'api', 'local'];
    for (const b of backends) {
      result[b] = this.getState(b);
    }
    return result;
  }

  /**
   * Manually reset a breaker (admin function)
   * @param {string} backend
   */
  reset(backend) {
    this.breakers[backend] = {
      state: STATES.CLOSED,
      failures: [],
      lastFailure: null,
      cooldownEnds: null,
      halfOpenProbeActive: false
    };
    console.log(`[CIRCUIT-BREAKER] ${backend}: Manually reset to CLOSED`);
    this.emit('breaker-closed', { backend, breaker: this._sanitize(this.breakers[backend]) });
    this.save();
  }

  /**
   * Remove a backend from the circuit breaker state (for test cleanup)
   * @param {string} backend - Backend name to remove
   */
  removeBackend(backend) {
    if (this.breakers[backend]) {
      delete this.breakers[backend];
      console.log(`[CIRCUIT-BREAKER] Removed backend: ${backend}`);
      this.save();
    }
  }

  /**
   * Update config thresholds from config.json
   * @param {Object} cfg - { failureThreshold, failureWindowMinutes, cooldownMinutes }
   */
  configure(cfg) {
    if (cfg.failureThreshold) this.config.failureThreshold = cfg.failureThreshold;
    if (cfg.failureWindowMinutes) this.config.failureWindowMs = cfg.failureWindowMinutes * 60 * 1000;
    if (cfg.cooldownMinutes) this.config.cooldownMs = cfg.cooldownMinutes * 60 * 1000;
    this.save();
  }
}

module.exports = new CircuitBreaker();
