#!/usr/bin/env node

/**
 * OpenClaw Task Router v2 — Quality Refinement Queue
 * 
 * CONCEPT: When tasks are executed on cheaper/faster models (Haiku, GPT-4.1-mini, local Ollama),
 * they get added to a "refinement queue." When expensive subscription backends (Claude Code, Codex)
 * are idle, they automatically pick up queued items and re-execute them at higher quality.
 * 
 * Think: junior devs push code fast, senior devs review and improve it when they have bandwidth.
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

class RefinementQueue {
  constructor(config = {}) {
    this.config = {
      enabled: config.enabled ?? true,
      maxQueueSize: config.maxQueueSize ?? 50,
      minComplexityToQueue: config.minComplexityToQueue ?? 3,
      idleCheckIntervalMs: config.idleCheckIntervalMs ?? 30000,
      preferredBackend: config.preferredBackend ?? 'claudeCode',
      fallbackBackend: config.fallbackBackend ?? 'codex',
      maxRefinementsPerHour: config.maxRefinementsPerHour ?? 5,
      skipIfOriginalScoreAbove: config.skipIfOriginalScoreAbove ?? 90,
      ...config
    };

    // Use test-specific data path in test mode
    if (process.env.ROUTER_TEST_MODE === 'true' && process.env.ROUTER_TEST_DATA_DIR) {
      this.dataPath = path.join(process.env.ROUTER_TEST_DATA_DIR, 'refinement-queue.json');
    } else {
      this.dataPath = path.join(__dirname, 'data', 'refinement-queue.json');
    }
    this.data = this.loadData();
    this.refinementsThisHour = 0;
    this.hourlyResetTimer = null;
    
    // Initialize hourly rate limiting
    this.resetHourlyCounter();
  }

  /**
   * Load refinement queue data from disk
   */
  loadData() {
    try {
      if (fs.existsSync(this.dataPath)) {
        const raw = fs.readFileSync(this.dataPath, 'utf8');
        const parsed = JSON.parse(raw);
        
        // Ensure proper structure
        return {
          queue: parsed.queue || [],
          completed: parsed.completed || [],
          stats: {
            totalRefined: parsed.stats?.totalRefined || 0,
            avgImprovementScore: parsed.stats?.avgImprovementScore || 0,
            tokensSaved: parsed.stats?.tokensSaved || 0,
            ...parsed.stats
          }
        };
      }
    } catch (error) {
      console.error('[REFINEMENT-QUEUE] Error loading data:', error.message);
    }

    // Return default structure
    return {
      queue: [],
      completed: [],
      stats: {
        totalRefined: 0,
        avgImprovementScore: 0,
        tokensSaved: 0
      }
    };
  }

  /**
   * Save refinement queue data to disk
   */
  saveData() {
    try {
      fs.mkdirSync(path.dirname(this.dataPath), { recursive: true });
      fs.writeFileSync(this.dataPath, JSON.stringify(this.data, null, 2));
    } catch (error) {
      console.error('[REFINEMENT-QUEUE] Error saving data:', error.message);
    }
  }

  /**
   * Reset hourly refinement counter
   */
  resetHourlyCounter() {
    this.refinementsThisHour = 0;
    
    // Don't set up timers in test mode
    if (process.env.ROUTER_TEST_MODE === 'true') {
      return;
    }
    
    // Set up next reset
    if (this.hourlyResetTimer) {
      clearTimeout(this.hourlyResetTimer);
    }
    
    // Reset at the top of next hour
    const now = new Date();
    const nextHour = new Date(now);
    nextHour.setHours(now.getHours() + 1, 0, 0, 0);
    const msToNextHour = nextHour.getTime() - now.getTime();
    
    this.hourlyResetTimer = setTimeout(() => {
      this.resetHourlyCounter();
    }, msToNextHour);
  }

  /**
   * Calculate priority for a task based on complexity and type
   */
  calculatePriority(taskResult) {
    const { complexity = 3, type = 'unknown' } = taskResult;
    
    let priority = Math.min(10, Math.max(1, complexity));
    
    // Boost priority for code-generating tasks
    if (type === 'code' || type === 'implementation') {
      priority += 1;
    }
    
    // Boost for tasks with files output (likely code)
    if (taskResult.result?.files?.length > 0) {
      priority += 1;
    }
    
    // Boost for complex analysis tasks
    if (type === 'analysis' && complexity >= 6) {
      priority += 1;
    }
    
    return Math.min(10, priority);
  }

  /**
   * Determine if a task result should be queued for refinement
   */
  shouldQueue(taskResult) {
    if (!this.config.enabled) {
      return false;
    }

    const { complexity = 0, backend, type } = taskResult;
    
    // Skip simple tasks
    if (complexity <= this.config.minComplexityToQueue) {
      return false;
    }
    
    // Only queue cheap backends
    const cheapBackends = ['local', 'api'];
    if (!cheapBackends.includes(backend)) {
      return false;
    }
    
    // Skip pure query tasks (no code/files output)
    if (type === 'query' || type === 'search') {
      return false;
    }
    
    // Skip if original result already scored very highly
    if (taskResult.qualityScore && taskResult.qualityScore >= this.config.skipIfOriginalScoreAbove) {
      return false;
    }
    
    return true;
  }

  /**
   * Add a completed task result to the refinement queue
   */
  enqueue(taskResult) {
    if (!this.shouldQueue(taskResult)) {
      return { queued: false, reason: 'Task not eligible for refinement' };
    }
    
    // Check queue size limit
    if (this.data.queue.length >= this.config.maxQueueSize) {
      // Remove lowest priority item to make room
      this.data.queue.sort((a, b) => a.priority - b.priority);
      const removed = this.data.queue.shift();
      console.log(`[REFINEMENT-QUEUE] Queue full, removed low-priority item: ${removed.id}`);
    }
    
    const priority = this.calculatePriority(taskResult);
    const queueItem = {
      id: `ref_${uuidv4().replace(/-/g, '').substring(0, 8)}`,
      originalTaskId: taskResult.taskId || 'unknown',
      description: taskResult.description || 'No description',
      originalBackend: taskResult.backend,
      originalModel: taskResult.model || 'unknown',
      originalResult: {
        files: taskResult.result?.files || [],
        summary: taskResult.result?.summary || 'No summary available',
        output: taskResult.result?.output || null
      },
      originalComplexity: taskResult.complexity || 3,
      originalTokens: taskResult.tokens || 0,
      originalDuration: taskResult.duration || 0,
      queuedAt: new Date().toISOString(),
      status: 'pending',
      priority,
      refinementBackend: null,
      refinementResult: null,
      refinedAt: null,
      improvementScore: null
    };
    
    this.data.queue.push(queueItem);
    
    // Sort by priority descending
    this.data.queue.sort((a, b) => b.priority - a.priority);
    
    this.saveData();
    
    console.log(`[REFINEMENT-QUEUE] Queued task ${queueItem.id} (priority ${priority}) for refinement`);
    
    return { queued: true, queueItem };
  }

  /**
   * Get the next highest priority refinement item
   */
  getNextRefinement() {
    const pending = this.data.queue.filter(item => item.status === 'pending');
    
    if (pending.length === 0) {
      return null;
    }
    
    // Return highest priority (already sorted)
    return pending[0];
  }

  /**
   * Mark a refinement item as in-progress
   */
  startRefinement(id, backend) {
    const item = this.data.queue.find(item => item.id === id);
    
    if (!item) {
      return { success: false, error: 'Item not found' };
    }
    
    if (item.status !== 'pending') {
      return { success: false, error: `Item is ${item.status}, not pending` };
    }
    
    item.status = 'in-progress';
    item.refinementBackend = backend;
    item.startedAt = new Date().toISOString();
    
    this.saveData();
    
    console.log(`[REFINEMENT-QUEUE] Started refinement ${id} on ${backend}`);
    
    return { success: true };
  }

  /**
   * Complete a refinement with results and improvement score
   */
  completeRefinement(id, result, improvementScore = null) {
    const item = this.data.queue.find(item => item.id === id);
    
    if (!item) {
      return { success: false, error: 'Item not found' };
    }
    
    item.status = 'completed';
    item.refinementResult = result;
    item.refinedAt = new Date().toISOString();
    item.improvementScore = improvementScore;
    
    // Move to completed array
    this.data.completed.push(item);
    this.data.queue = this.data.queue.filter(i => i.id !== id);
    
    // Update stats
    this.data.stats.totalRefined += 1;
    
    if (improvementScore !== null) {
      const prevAvg = this.data.stats.avgImprovementScore || 0;
      const count = this.data.stats.totalRefined;
      this.data.stats.avgImprovementScore = (prevAvg * (count - 1) + improvementScore) / count;
    }
    
    // Calculate tokens saved (rough estimate)
    const tokensSaved = Math.max(0, item.originalTokens * 0.3); // Assume 30% savings from fast-first approach
    this.data.stats.tokensSaved += tokensSaved;
    
    this.saveData();
    
    console.log(`[REFINEMENT-QUEUE] Completed refinement ${id} with score ${improvementScore}/100`);
    
    return { success: true };
  }

  /**
   * Skip a refinement item (mark as not needing refinement)
   */
  skipRefinement(id, reason = 'Manual skip') {
    const item = this.data.queue.find(item => item.id === id);
    
    if (!item) {
      return { success: false, error: 'Item not found' };
    }
    
    item.status = 'skipped';
    item.skipReason = reason;
    item.skippedAt = new Date().toISOString();
    
    // Move to completed array for record keeping
    this.data.completed.push(item);
    this.data.queue = this.data.queue.filter(i => i.id !== id);
    
    this.saveData();
    
    console.log(`[REFINEMENT-QUEUE] Skipped refinement ${id}: ${reason}`);
    
    return { success: true };
  }

  /**
   * Build refinement prompt for a task
   */
  buildRefinementPrompt(queueItem) {
    const { originalModel, description, originalResult } = queueItem;
    
    return `Review and improve this code that was generated by ${originalModel}.

Original task: ${description}

Original output summary: ${originalResult.summary}

${originalResult.files?.length > 0 ? 
  `Files generated: ${originalResult.files.join(', ')}` : ''}

Please make it production-quality:
- Better error handling and edge cases
- Cleaner, more maintainable code
- More robust validation
- Better naming and documentation
- Improved performance where applicable

Only change what genuinely improves quality — don't refactor for the sake of it. Focus on making the code more reliable and maintainable.

${originalResult.output ? `\n--- Original Output ---\n${originalResult.output}\n--- End Original Output ---` : ''}`;
  }

  /**
   * Check if backends are idle and process refinement queue
   * This is the core loop that should be called periodically
   */
  async checkIdleAndRefine() {
    if (!this.config.enabled) {
      return { processed: false, reason: 'Refinement queue disabled' };
    }
    
    // Check rate limiting
    if (this.refinementsThisHour >= this.config.maxRefinementsPerHour) {
      return { processed: false, reason: 'Hourly rate limit reached' };
    }
    
    // Get next item
    const nextItem = this.getNextRefinement();
    if (!nextItem) {
      return { processed: false, reason: 'No pending refinements' };
    }
    
    // Note: The actual backend idle checking and task execution would need to
    // be integrated with the main router system. For now, we'll return the item
    // that needs processing and let the caller handle the actual execution.
    
    return { 
      processed: false, 
      reason: 'Backend integration required',
      nextItem,
      prompt: this.buildRefinementPrompt(nextItem)
    };
  }

  /**
   * Get current queue statistics
   */
  getStats() {
    return {
      ...this.data.stats,
      queueLength: this.data.queue.length,
      completedCount: this.data.completed.length,
      refinementsThisHour: this.refinementsThisHour,
      remainingThisHour: Math.max(0, this.config.maxRefinementsPerHour - this.refinementsThisHour)
    };
  }

  /**
   * Get current queue items
   */
  getQueue() {
    return {
      pending: this.data.queue.filter(item => item.status === 'pending'),
      inProgress: this.data.queue.filter(item => item.status === 'in-progress'),
      recent: this.data.completed.slice(-10) // Last 10 completed
    };
  }

  /**
   * Cleanup method
   */
  cleanup() {
    if (this.hourlyResetTimer) {
      clearTimeout(this.hourlyResetTimer);
      this.hourlyResetTimer = null;
    }
  }
}

// Export singleton instance
let instance = null;

function getInstance(config = null) {
  if (!instance) {
    // Load config from router config if available
    let routerConfig = {};
    try {
      const configPath = path.join(__dirname, 'config.json');
      if (fs.existsSync(configPath)) {
        const fullConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        routerConfig = fullConfig.refinementQueue || {};
      }
    } catch (error) {
      console.warn('[REFINEMENT-QUEUE] Could not load router config:', error.message);
    }
    
    instance = new RefinementQueue({ ...routerConfig, ...config });
  }
  return instance;
}

module.exports = {
  RefinementQueue,
  getInstance,
  // Convenience methods for singleton use
  enqueue: (taskResult) => getInstance().enqueue(taskResult),
  getNextRefinement: () => getInstance().getNextRefinement(),
  startRefinement: (id, backend) => getInstance().startRefinement(id, backend),
  completeRefinement: (id, result, score) => getInstance().completeRefinement(id, result, score),
  skipRefinement: (id, reason) => getInstance().skipRefinement(id, reason),
  checkIdleAndRefine: () => getInstance().checkIdleAndRefine(),
  getStats: () => getInstance().getStats(),
  getQueue: () => getInstance().getQueue()
};