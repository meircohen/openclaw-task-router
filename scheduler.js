const EventEmitter = require('events');
const fs = require('fs').promises;
const path = require('path');

// Lazy-loaded to avoid circular dependencies
let circuitBreaker = null;
function getCircuitBreaker() {
  if (!circuitBreaker) {
    circuitBreaker = require('./circuit-breaker');
  }
  return circuitBreaker;
}

/**
 * OpenClaw Subscription Queue Manager
 * Manages a persistent queue of tasks for subscription backends (Claude Code, Codex).
 * Free but rate-limited — schedules intelligently with concurrency, retries, and progress events.
 */
class SubscriptionScheduler extends EventEmitter {
  constructor() {
    super();
    this.statePath = path.join(__dirname, 'data', 'queue-state.json');
    this.queue = [];         // pending items
    this.active = new Map(); // taskId → { item, startedAt }
    this.completed = [];     // last 100 completed
    this.paused = false;
    this.loaded = false;
    this.processingTimer = null;

    // Concurrency limits
    this.concurrency = {
      'claude-code': 1,
      'codex': 3
    };

    // Rate-limit cooldowns (ms)
    this.cooldowns = {
      'claude-code': 20 * 60 * 1000,  // 20 min default
      'codex': 5 * 60 * 1000
    };

    // Last completion timestamps per backend
    this.lastCompletion = {};

    // Health tracking
    this.health = {
      'claude-code': { throttled: false, backoffUntil: null, consecutiveFailures: 0 },
      'codex':       { throttled: false, backoffUntil: null, consecutiveFailures: 0 }
    };

    this.maxRetries = 2;
    this.maxConsecutiveCircuitBreakerFailures = 3; // Default config
  }

  // ─── Lifecycle ────────────────────────────────────────────────

  /**
   * Load persisted state from disk
   */
  async load() {
    try {
      const raw = await fs.readFile(this.statePath, 'utf8');
      const state = JSON.parse(raw);
      this.queue = state.queue || [];
      this.completed = state.completed || [];
      this.lastCompletion = state.lastCompletion || {};
      this.health = { ...this.health, ...(state.health || {}) };
      this.paused = state.paused || false;
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error('[SCHEDULER] Error loading state:', err.message);
      }
      // start fresh
    }
    this.loaded = true;
    console.log(`[SCHEDULER] Loaded ${this.queue.length} queued tasks, ${this.completed.length} completed`);
  }

  /**
   * Persist state to disk
   */
  async save() {
    try {
      await fs.mkdir(path.dirname(this.statePath), { recursive: true });
      const state = {
        queue: this.queue,
        completed: this.completed.slice(-100),
        lastCompletion: this.lastCompletion,
        health: this.health,
        paused: this.paused,
        savedAt: new Date().toISOString()
      };
      await fs.writeFile(this.statePath, JSON.stringify(state, null, 2));
    } catch (err) {
      console.error('[SCHEDULER] Error saving state:', err.message);
    }
  }

  /**
   * Start the processing loop
   */
  start() {
    if (this.processingTimer) return;
    console.log('[SCHEDULER] Starting processing loop');
    this.processingTimer = setInterval(() => this._tick(), 15_000); // every 15s
    this._tick(); // immediate first tick
  }

  /**
   * Stop the processing loop
   */
  stop() {
    if (this.processingTimer) {
      clearInterval(this.processingTimer);
      this.processingTimer = null;
      console.log('[SCHEDULER] Stopped processing loop');
    }
  }

  // ─── Public API ───────────────────────────────────────────────

  /**
   * Add a task to the subscription queue
   * @param {Object} task - Task object with description, type, etc.
   * @param {string} backend - 'claude-code' or 'codex'
   * @param {string} priority - 'urgent', 'normal', or 'background'
   * @returns {string} taskId
   */
  async enqueue(task, backend = 'claude-code', priority = 'normal') {
    if (!this.loaded) await this.load();

    const taskId = `sched_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const priorityValue = { urgent: 100, normal: 50, background: 10 }[priority] || 50;

    const item = {
      id: taskId,
      task: { ...task },
      backend,
      priority: priorityValue,
      priorityName: priority,
      enqueuedAt: new Date().toISOString(),
      retries: 0,
      lastError: null,
      result: null
    };

    this.queue.push(item);
    this._sortQueue();

    console.log(`[SCHEDULER] Enqueued ${taskId} → ${backend} [${priority}] (queue: ${this.queue.length})`);
    this.emit('enqueue', taskId, backend, priority);

    await this.save();
    return taskId;
  }

  /**
   * Get overall scheduler status
   * @returns {Object}
   */
  getStatus() {
    const byBackend = {};
    for (const b of ['claude-code', 'codex']) {
      const queued = this.queue.filter(i => i.backend === b).length;
      const active = [...this.active.values()].filter(a => a.item.backend === b).length;
      byBackend[b] = {
        queued,
        active,
        concurrencyLimit: this.concurrency[b],
        availableSlots: this.concurrency[b] - active,
        health: this.health[b],
        cooldownMs: this.cooldowns[b],
        lastCompletion: this.lastCompletion[b] || null
      };
    }

    return {
      totalQueued: this.queue.length,
      totalActive: this.active.size,
      totalCompleted: this.completed.length,
      paused: this.paused,
      running: this.processingTimer !== null,
      backends: byBackend,
      lastUpdated: new Date().toISOString()
    };
  }

  /**
   * Get estimated time until a queued task starts + completes
   * @param {string} taskId
   * @returns {Object|null} { estimatedStartMinutes, estimatedTotalMinutes } or null
   */
  getETA(taskId) {
    // Check active
    const activeEntry = this.active.get(taskId);
    if (activeEntry) {
      const elapsed = (Date.now() - new Date(activeEntry.startedAt).getTime()) / 60000;
      const avgMinutes = 8;
      return {
        status: 'active',
        elapsedMinutes: Math.round(elapsed),
        estimatedRemainingMinutes: Math.max(0, Math.round(avgMinutes - elapsed))
      };
    }

    // Check queue position
    const idx = this.queue.findIndex(i => i.id === taskId);
    if (idx === -1) {
      // Check completed
      const done = this.completed.find(c => c.id === taskId);
      if (done) {
        return { status: 'completed', completedAt: done.completedAt };
      }
      return null;
    }

    const item = this.queue[idx];
    const backend = item.backend;
    const limit = this.concurrency[backend];

    // Count items ahead of this one for the same backend
    const ahead = this.queue.slice(0, idx).filter(i => i.backend === backend).length;
    const activeCount = [...this.active.values()].filter(a => a.item.backend === backend).length;
    const slotsNow = Math.max(0, limit - activeCount);

    const avgMinutes = 8; // avg per task
    const batchesAhead = slotsNow > 0 ? Math.ceil(ahead / limit) : Math.ceil((ahead + 1) / limit);
    const cooldownMinutes = this.cooldowns[backend] / 60000;
    const waitMinutes = batchesAhead * (avgMinutes + cooldownMinutes);

    return {
      status: 'queued',
      position: idx + 1,
      tasksAhead: ahead,
      estimatedStartMinutes: Math.round(waitMinutes),
      estimatedTotalMinutes: Math.round(waitMinutes + avgMinutes)
    };
  }

  /**
   * Cancel a queued or active task
   * @param {string} taskId
   * @returns {boolean} true if found and cancelled
   */
  async cancel(taskId) {
    // Remove from queue
    const idx = this.queue.findIndex(i => i.id === taskId);
    if (idx !== -1) {
      this.queue.splice(idx, 1);
      console.log(`[SCHEDULER] Cancelled queued task ${taskId}`);
      this.emit('cancelled', taskId);
      await this.save();
      return true;
    }

    // Cancel active (mark for skip — real abort depends on backend)
    if (this.active.has(taskId)) {
      const entry = this.active.get(taskId);
      entry.cancelled = true;
      console.log(`[SCHEDULER] Marked active task ${taskId} for cancellation`);
      this.emit('cancelled', taskId);
      return true;
    }

    return false;
  }

  /**
   * Pause the scheduler (stop dispatching new tasks)
   */
  pause() {
    this.paused = true;
    console.log('[SCHEDULER] Paused');
    this.emit('paused');
  }

  /**
   * Resume the scheduler
   */
  resume() {
    this.paused = false;
    console.log('[SCHEDULER] Resumed');
    this.emit('resumed');
    this._tick();
  }

  // ─── Internal Processing ──────────────────────────────────────

  /**
   * @private Scheduler tick — dispatch tasks to available slots
   */
  async _tick() {
    if (this.paused) return;
    if (!this.loaded) await this.load();

    for (const backend of ['claude-code', 'codex']) {
      const limit = this.concurrency[backend];
      const activeCount = [...this.active.values()].filter(a => a.item.backend === backend).length;
      const slots = limit - activeCount;
      if (slots <= 0) continue;

      // Check health / backoff
      const h = this.health[backend];
      if (h.throttled && h.backoffUntil && Date.now() < new Date(h.backoffUntil).getTime()) {
        continue; // still in backoff
      }
      if (h.throttled && (!h.backoffUntil || Date.now() >= new Date(h.backoffUntil).getTime())) {
        h.throttled = false; // backoff expired
      }

      // Check cooldown
      const lastDone = this.lastCompletion[backend];
      if (lastDone) {
        const elapsed = Date.now() - new Date(lastDone).getTime();
        if (elapsed < this.cooldowns[backend]) {
          continue; // still cooling down
        }
      }

      // Find eligible tasks
      const eligible = this.queue.filter(i => i.backend === backend);
      const toDispatch = eligible.slice(0, slots);

      for (const item of toDispatch) {
        this._dispatch(item);
      }
    }
  }

  /**
   * @private Dispatch a single task to its backend
   */
  async _dispatch(item) {
    // Check circuit breaker before execution
    const cb = getCircuitBreaker();
    const backendName = item.backend === 'claude-code' ? 'claudeCode' : item.backend;
    
    if (!cb.canExecute(backendName)) {
      // Circuit breaker is open - handle as CB failure
      console.warn(`[SCHEDULER] Task ${item.id}: Circuit breaker OPEN for ${backendName}`);
      this.active.delete(item.id); // Remove from active if it was added
      await this._handleCircuitBreakerFailure(item);
      return;
    }

    // Remove from queue
    this.queue = this.queue.filter(i => i.id !== item.id);

    // Add to active
    const entry = { item, startedAt: new Date().toISOString(), cancelled: false };
    this.active.set(item.id, entry);

    const stepIdx = this.active.size;
    const totalQueued = this.queue.filter(i => i.backend === item.backend).length + this.active.size;

    console.log(`[SCHEDULER] Dispatching ${item.id} → ${item.backend}`);
    this.emit('progress', item.id, stepIdx, totalQueued, `Starting task on ${item.backend}`);

    try {
      const result = await this._execute(item);

      if (entry.cancelled) {
        console.log(`[SCHEDULER] Task ${item.id} was cancelled during execution`);
        this.active.delete(item.id);
        return;
      }

      // Success
      this.active.delete(item.id);
      this.lastCompletion[item.backend] = new Date().toISOString();
      this.health[item.backend].consecutiveFailures = 0;

      const completedItem = {
        ...item,
        result,
        completedAt: new Date().toISOString(),
        duration: Date.now() - new Date(entry.startedAt).getTime()
      };
      this.completed.push(completedItem);
      if (this.completed.length > 100) this.completed = this.completed.slice(-100);

      console.log(`[SCHEDULER] Completed ${item.id} on ${item.backend}`);
      this.emit('complete', item.id, result);

      await this.save();
    } catch (err) {
      this.active.delete(item.id);
      await this._handleFailure(item, err);
    }
  }

  /**
   * @private Execute a task on its backend (simulated — real execution via router)
   */
  async _execute(item) {
    // In production, this would call the actual backend.
    // For now we simulate or delegate to the router's executeWithBackend.
    try {
      const router = require('./index');
      const result = await router.forceRoute(item.task, item.backend === 'claude-code' ? 'claudeCode' : item.backend);
      return result;
    } catch (err) {
      throw err;
    }
  }

  /**
   * @private Handle circuit breaker failure (all backends OPEN)
   */
  async _handleCircuitBreakerFailure(item) {
    // Initialize circuit breaker failure tracking if not present
    if (!item.circuitBreakerFailures) {
      item.circuitBreakerFailures = 0;
    }
    
    item.circuitBreakerFailures++;
    
    console.warn(`[SCHEDULER] Task ${item.id}: Circuit breaker failure ${item.circuitBreakerFailures}/${this.maxConsecutiveCircuitBreakerFailures}`);
    
    if (item.circuitBreakerFailures >= this.maxConsecutiveCircuitBreakerFailures) {
      // Move to dead letter queue after too many CB failures
      console.error(`[SCHEDULER] Task ${item.id} moved to dead letter queue after ${item.circuitBreakerFailures} circuit breaker failures`);
      this.emit('error', item.id, new Error(`Moved to dead letter queue after ${item.circuitBreakerFailures} consecutive circuit breaker failures`));
      
      const deadLetterItem = {
        ...item,
        failedAt: new Date().toISOString(),
        finalError: `Circuit breaker failures: ${item.circuitBreakerFailures}`
      };
      this.completed.push(deadLetterItem);
      if (this.completed.length > 100) this.completed = this.completed.slice(-100);
    } else {
      // Check if ALL backends are OPEN
      const cb = getCircuitBreaker();
      const allBackendsOpen = Object.keys(this.concurrency).every(backend => {
        const backendName = backend === 'claude-code' ? 'claudeCode' : backend;
        return !cb.canExecute(backendName);
      });
      
      if (allBackendsOpen) {
        // Put in waiting state instead of consuming retries
        item.status = 'waiting';
        this.queue.push(item);
        this._sortQueue();
        console.log(`[SCHEDULER] Task ${item.id} put in waiting state - all circuit breakers OPEN`);
        this.emit('progress', item.id, 0, 0, `Waiting: all backends circuit breaker OPEN (CB failure ${item.circuitBreakerFailures})`);
      } else {
        // Some backends available, re-queue normally
        this.queue.push(item);
        this._sortQueue();
        console.log(`[SCHEDULER] Re-queued ${item.id} after circuit breaker failure`);
        this.emit('progress', item.id, 0, 0, `Re-queued after circuit breaker failure ${item.circuitBreakerFailures}`);
      }
    }
    
    await this.save();
  }

  /**
   * @private Handle task failure with retry logic
   */
  async _handleFailure(item, err) {
    const backend = item.backend;
    const h = this.health[backend];

    // Check if this is a circuit breaker related failure
    const circuitBreakerError = err.message.includes('circuit breaker') || 
                               err.message.includes('Circuit breaker') ||
                               err.message.includes('Backend unavailable');

    if (circuitBreakerError) {
      // Don't consume regular retries for circuit breaker failures
      console.warn(`[SCHEDULER] Task ${item.id} failed due to circuit breaker: ${err.message}`);
      await this._handleCircuitBreakerFailure(item);
      return;
    }

    // Regular failure - consume retries
    item.retries++;
    item.lastError = err.message;

    console.error(`[SCHEDULER] Task ${item.id} failed (attempt ${item.retries}/${this.maxRetries}): ${err.message}`);

    // Check for rate limiting
    if (err.message.includes('rate limit') || err.message.includes('throttl') || err.message.includes('quota')) {
      h.throttled = true;
      const backoffMs = Math.pow(2, h.consecutiveFailures + 1) * 60_000; // exponential backoff
      h.backoffUntil = new Date(Date.now() + backoffMs).toISOString();
      console.warn(`[SCHEDULER] ${backend} throttled — backing off ${backoffMs / 60000} min`);
    }

    h.consecutiveFailures++;

    if (item.retries < this.maxRetries) {
      // Re-queue for retry
      this.queue.push(item);
      this._sortQueue();
      console.log(`[SCHEDULER] Re-queued ${item.id} for retry ${item.retries}/${this.maxRetries}`);
      this.emit('progress', item.id, 0, 0, `Retry ${item.retries}/${this.maxRetries}: ${err.message}`);
    } else {
      // Max retries exceeded — alert
      console.error(`[SCHEDULER] Task ${item.id} failed after ${this.maxRetries} retries`);
      this.emit('error', item.id, new Error(`Failed after ${this.maxRetries} retries: ${err.message}`));

      const failedItem = {
        ...item,
        failedAt: new Date().toISOString(),
        finalError: err.message
      };
      this.completed.push(failedItem);
      if (this.completed.length > 100) this.completed = this.completed.slice(-100);
    }

    await this.save();
  }

  /**
   * @private Sort queue by priority (high first) then FIFO
   */
  _sortQueue() {
    this.queue.sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      return new Date(a.enqueuedAt) - new Date(b.enqueuedAt);
    });
  }
}

module.exports = new SubscriptionScheduler();
