const fs = require('fs').promises;
const path = require('path');

/**
 * Smart Deduplication for OpenClaw Task Router
 * Prevents duplicate agent spawns by tracking recent tasks and computing similarity.
 *
 * - Rolling window of recent tasks (last 30 min)
 * - Normalized text similarity via word overlap (Jaccard-like)
 * - Handles: same task from different channels, retries of failed tasks,
 *   and similar-but-different-scope tasks
 */

const DEFAULTS = {
  windowMs: 30 * 60 * 1000,           // 30 minutes
  similarityThreshold: 0.70,           // 70% word overlap → flag as duplicate
  warnThreshold: 0.50,                 // 50-70% → warn
};

class Dedup {
  constructor() {
    const dataDir = process.env.ROUTER_TEST_MODE ? process.env.ROUTER_TEST_DATA_DIR : path.join(__dirname, 'data');
    this.persistPath = path.join(dataDir, 'recent-tasks.json');
    this.tasks = new Map();  // taskId → { id, description, normalized, words, status, channel, registeredAt }
    this.config = DEFAULTS;
    this.loaded = false;
    this._cleanupTimer = null;
  }

  // ─── Persistence ─────────────────────────────────────────────

  async load() {
    try {
      const raw = await fs.readFile(this.persistPath, 'utf8');
      const saved = JSON.parse(raw);
      if (saved.tasks && Array.isArray(saved.tasks)) {
        const now = Date.now();
        for (const t of saved.tasks) {
          // Only restore non-expired entries
          if (now - new Date(t.registeredAt).getTime() < this.config.windowMs) {
            this.tasks.set(t.id, {
              ...t,
              words: new Set(t.wordsArray || this._normalize(t.description).split(/\s+/))
            });
          }
        }
      }
      if (saved.config) {
        this.config = { ...DEFAULTS, ...saved.config };
      }
      this.loaded = true;
      console.log(`[DEDUP] State loaded (${this.tasks.size} recent tasks)`);
    } catch (err) {
      if (err.code === 'ENOENT') {
        console.log('[DEDUP] No saved state, starting fresh');
      } else {
        console.error('[DEDUP] Error loading state:', err.message);
      }
      this.loaded = true;
    }

    // Start periodic cleanup
    this._startCleanup();
  }

  async save() {
    try {
      const tasksArr = [];
      for (const [id, t] of this.tasks) {
        tasksArr.push({
          id: t.id,
          description: t.description,
          normalized: t.normalized,
          wordsArray: [...t.words],
          status: t.status,
          channel: t.channel,
          registeredAt: t.registeredAt,
          completedAt: t.completedAt || null,
          failed: t.failed || false
        });
      }
      await fs.mkdir(path.dirname(this.persistPath), { recursive: true });
      await fs.writeFile(this.persistPath, JSON.stringify({
        tasks: tasksArr,
        config: this.config,
        lastSaved: new Date().toISOString()
      }, null, 2));
    } catch (err) {
      console.error('[DEDUP] Error saving state:', err.message);
    }
  }

  _startCleanup() {
    if (this._cleanupTimer) return;
    // Expire old entries every 5 minutes
    this._cleanupTimer = setInterval(() => this._expire(), 5 * 60 * 1000);
    if (this._cleanupTimer.unref) this._cleanupTimer.unref();
  }

  _expire() {
    const cutoff = Date.now() - this.config.windowMs;
    let removed = 0;
    for (const [id, t] of this.tasks) {
      if (new Date(t.registeredAt).getTime() < cutoff) {
        this.tasks.delete(id);
        removed++;
      }
    }
    if (removed > 0) {
      console.log(`[DEDUP] Expired ${removed} old task(s)`);
      this.save();
    }
  }

  // ─── Text normalization & similarity ─────────────────────────

  /**
   * Normalize description: lowercase, strip punctuation, collapse whitespace
   */
  _normalize(text) {
    return (text || '')
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')   // strip punctuation
      .replace(/\s+/g, ' ')       // collapse whitespace
      .trim();
  }

  /**
   * Extract meaningful words (skip stop words)
   */
  _extractWords(normalized) {
    const stopWords = new Set([
      'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
      'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
      'before', 'after', 'and', 'but', 'or', 'nor', 'not', 'so', 'yet',
      'it', 'its', 'this', 'that', 'these', 'those', 'i', 'me', 'my',
      'we', 'our', 'you', 'your', 'he', 'she', 'they', 'them', 'their'
    ]);
    return new Set(
      normalized.split(/\s+/).filter(w => w.length > 1 && !stopWords.has(w))
    );
  }

  /**
   * Compute word overlap similarity (Jaccard index)
   * @param {Set} wordsA
   * @param {Set} wordsB
   * @returns {number} 0-1
   */
  _similarity(wordsA, wordsB) {
    if (wordsA.size === 0 && wordsB.size === 0) return 1;
    if (wordsA.size === 0 || wordsB.size === 0) return 0;

    let intersection = 0;
    for (const w of wordsA) {
      if (wordsB.has(w)) intersection++;
    }

    const union = new Set([...wordsA, ...wordsB]).size;
    return union > 0 ? intersection / union : 0;
  }

  /**
   * Check for numeric scope differences ("page 1-10" vs "page 11-20")
   */
  _hasDifferentScope(descA, descB) {
    const numPatternA = descA.match(/\d+[\s-]+\d+/g) || [];
    const numPatternB = descB.match(/\d+[\s-]+\d+/g) || [];
    if (numPatternA.length > 0 && numPatternB.length > 0) {
      return numPatternA.join(',') !== numPatternB.join(',');
    }
    return false;
  }

  // ─── Public API ──────────────────────────────────────────────

  /**
   * Check if a task is a duplicate of a recent task
   * @param {Object} task - { description, channel? }
   * @returns {{ isDuplicate: boolean, existingTaskId: string|null, similarity: number, recommendation: 'skip'|'warn'|'proceed' }}
   */
  check(task) {
    this._expire(); // Clean up first

    const normalized = this._normalize(task.description);
    const words = this._extractWords(normalized);

    let bestMatch = { similarity: 0, taskId: null, existingTask: null };

    for (const [id, existing] of this.tasks) {
      // Skip completed-and-failed tasks (retries should be allowed)
      if (existing.failed) continue;

      const sim = this._similarity(words, existing.words);
      if (sim > bestMatch.similarity) {
        bestMatch = { similarity: sim, taskId: id, existingTask: existing };
      }
    }

    const sim = bestMatch.similarity;

    // Even if high similarity, allow if scope is different
    if (sim >= this.config.similarityThreshold && bestMatch.existingTask) {
      if (this._hasDifferentScope(normalized, bestMatch.existingTask.normalized)) {
        console.log(`[DEDUP] High similarity (${(sim * 100).toFixed(0)}%) but different scope — allowing`);
        return { isDuplicate: false, existingTaskId: bestMatch.taskId, similarity: sim, recommendation: 'proceed' };
      }
    }

    if (sim >= this.config.similarityThreshold) {
      console.log(`[DEDUP] Duplicate detected (${(sim * 100).toFixed(0)}% match with ${bestMatch.taskId})`);
      return { isDuplicate: true, existingTaskId: bestMatch.taskId, similarity: sim, recommendation: 'skip' };
    }

    if (sim >= this.config.warnThreshold) {
      console.log(`[DEDUP] Similar task warning (${(sim * 100).toFixed(0)}% match with ${bestMatch.taskId})`);
      return { isDuplicate: false, existingTaskId: bestMatch.taskId, similarity: sim, recommendation: 'warn' };
    }

    return { isDuplicate: false, existingTaskId: null, similarity: sim, recommendation: 'proceed' };
  }

  /**
   * Register a task for dedup tracking
   * @param {string} taskId
   * @param {Object} task - { description, channel? }
   */
  register(taskId, task) {
    const normalized = this._normalize(task.description);
    const words = this._extractWords(normalized);

    this.tasks.set(taskId, {
      id: taskId,
      description: task.description,
      normalized,
      words,
      status: 'running',
      channel: task.channel || task.metadata?.channel || 'unknown',
      registeredAt: new Date().toISOString(),
      failed: false
    });

    console.log(`[DEDUP] Registered task ${taskId}`);
    this.save();
  }

  /**
   * Mark a task as completed
   * @param {string} taskId
   * @param {{ failed?: boolean }} options
   */
  complete(taskId, options = {}) {
    const task = this.tasks.get(taskId);
    if (task) {
      task.status = options.failed ? 'failed' : 'completed';
      task.completedAt = new Date().toISOString();
      task.failed = !!options.failed;
      console.log(`[DEDUP] Task ${taskId} marked as ${task.status}`);
      this.save();
    }
  }

  /**
   * List all recent (non-expired) tasks
   * @returns {Array}
   */
  getRecent() {
    this._expire();
    const result = [];
    for (const [id, t] of this.tasks) {
      result.push({
        id: t.id,
        description: t.description,
        status: t.status,
        channel: t.channel,
        registeredAt: t.registeredAt,
        completedAt: t.completedAt || null,
        failed: t.failed
      });
    }
    return result;
  }

  /**
   * Update config
   * @param {Object} cfg - { windowMinutes?, similarityThreshold?, warnThreshold? }
   */
  configure(cfg) {
    if (cfg.windowMinutes) this.config.windowMs = cfg.windowMinutes * 60 * 1000;
    if (cfg.similarityThreshold != null) this.config.similarityThreshold = cfg.similarityThreshold;
    if (cfg.warnThreshold != null) this.config.warnThreshold = cfg.warnThreshold;
    this.save();
  }
}

module.exports = new Dedup();
