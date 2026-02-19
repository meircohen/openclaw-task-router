const fs = require('fs').promises;
const path = require('path');
const cron = require('node-cron');

/**
 * Priority Task Queue with Drip Scheduling for OpenClaw Task Router
 * Self-contained scheduling system with persistence and overflow protection
 */
class TaskQueue {
  constructor() {
    this.queuePath = path.join(__dirname, 'data', 'task-queue.json');
    this.deadLetterPath = path.join(__dirname, 'data', 'task-dead-letters.json');
    this.queue = [];
    this.deadLetters = [];
    this.loaded = false;
    this.scheduler = null;
    this.isProcessing = false;
    this.maxQueueSize = 10;
    this.maxRetries = 3;
    
    // Priority levels (higher number = higher priority)
    this.priorities = {
      critical: 100,
      high: 75,
      normal: 50,
      low: 25,
      background: 10
    };
  }

  /**
   * Load queue data from persistent storage
   * @returns {Promise<void>}
   */
  async load() {
    try {
      // Load main queue
      try {
        const queueStr = await fs.readFile(this.queuePath, 'utf8');
        this.queue = JSON.parse(queueStr);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          console.error('[QUEUE] Error loading queue:', error.message);
        }
        this.queue = [];
      }

      // Load dead letter queue
      try {
        const deadStr = await fs.readFile(this.deadLetterPath, 'utf8');
        this.deadLetters = JSON.parse(deadStr);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          console.error('[QUEUE] Error loading dead letters:', error.message);
        }
        this.deadLetters = [];
      }

      this.loaded = true;
      console.log(`[QUEUE] Loaded ${this.queue.length} tasks, ${this.deadLetters.length} dead letters`);
      
      // Sort queue by priority
      this.sortQueue();
    } catch (error) {
      console.error('[QUEUE] Error during load:', error.message);
      this.queue = [];
      this.deadLetters = [];
      this.loaded = true;
    }
  }

  /**
   * Save queue data to persistent storage
   * @returns {Promise<void>}
   */
  async save() {
    try {
      await fs.mkdir(path.dirname(this.queuePath), { recursive: true });
      
      // Save main queue
      await fs.writeFile(this.queuePath, JSON.stringify(this.queue, null, 2));
      
      // Save dead letter queue
      await fs.writeFile(this.deadLetterPath, JSON.stringify(this.deadLetters, null, 2));
    } catch (error) {
      console.error('[QUEUE] Error saving queue data:', error.message);
    }
  }

  /**
   * Sort queue by priority (high to low) then by timestamp (FIFO within priority)
   */
  sortQueue() {
    this.queue.sort((a, b) => {
      if (a.priority !== b.priority) {
        return b.priority - a.priority; // Higher priority first
      }
      return new Date(a.enqueuedAt) - new Date(b.enqueuedAt); // FIFO within priority
    });
  }

  /**
   * Add a task to the queue
   * @param {Object} task - Task object
   * @param {string} priority - Priority level (critical, high, normal, low, background)
   * @returns {Promise<string>} Task ID
   */
  async enqueue(task, priority = 'normal') {
    if (!this.loaded) await this.load();

    const priorityValue = this.priorities[priority] || this.priorities.normal;
    const taskId = `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const queueItem = {
      id: taskId,
      task: { ...task },
      priority: priorityValue,
      priorityName: priority,
      enqueuedAt: new Date().toISOString(),
      retries: 0,
      lastError: null,
      scheduledFor: priority === 'critical' ? new Date().toISOString() : null
    };

    // Overflow protection
    if (this.queue.length >= this.maxQueueSize && priority !== 'critical') {
      console.log(`[QUEUE] Queue overflow (${this.queue.length}), shunting low-priority to local`);
      
      // Find lowest priority items and mark them for local execution
      const lowPriorityItems = this.queue
        .filter(item => item.priority < priorityValue)
        .slice(0, 3);

      for (const item of lowPriorityItems) {
        item.task.forceBackend = 'local';
        console.log(`[QUEUE] Marked task ${item.id} for local execution due to overflow`);
      }
    }

    this.queue.push(queueItem);
    this.sortQueue();

    console.log(`[QUEUE] Enqueued task ${taskId} with ${priority} priority (queue size: ${this.queue.length})`);
    
    await this.save();
    return taskId;
  }

  /**
   * Get the next task from the queue
   * @returns {Promise<Object|null>} Next task or null if queue is empty
   */
  async processNext() {
    if (!this.loaded) await this.load();
    
    if (this.queue.length === 0) {
      return null;
    }

    // Check for critical tasks first
    let taskItem = this.queue.find(item => item.priorityName === 'critical');
    
    if (!taskItem) {
      // Check for scheduled tasks that are ready
      const now = new Date();
      taskItem = this.queue.find(item => {
        if (item.scheduledFor) {
          return new Date(item.scheduledFor) <= now;
        }
        return true; // Not scheduled, ready to process
      });
    }

    if (!taskItem) {
      return null; // No tasks ready for processing
    }

    // Remove from queue
    this.queue = this.queue.filter(item => item.id !== taskItem.id);
    
    console.log(`[QUEUE] Processing task ${taskItem.id} (${taskItem.priorityName} priority)`);
    
    await this.save();
    return taskItem;
  }

  /**
   * Mark a task as failed and handle retry logic
   * @param {string} taskId - Task ID
   * @param {string} error - Error message
   * @param {Object} taskItem - Original task item
   * @returns {Promise<boolean>} Whether task should be retried
   */
  async markFailed(taskId, error, taskItem) {
    if (!this.loaded) await this.load();

    taskItem.retries++;
    taskItem.lastError = error;
    taskItem.lastFailedAt = new Date().toISOString();

    if (taskItem.retries >= this.maxRetries) {
      // Move to dead letter queue
      const deadLetter = {
        ...taskItem,
        movedToDeadLetterAt: new Date().toISOString(),
        totalRetries: taskItem.retries,
        finalError: error
      };

      this.deadLetters.push(deadLetter);
      
      // Keep only last 100 dead letters
      if (this.deadLetters.length > 100) {
        this.deadLetters = this.deadLetters.slice(-100);
      }

      console.log(`[QUEUE] Task ${taskId} moved to dead letter queue after ${taskItem.retries} retries: ${error}`);
      
      const config = require('./config.json');
      if (config.alerts.alertOnQueueOverflow) {
        const monitor = require('./monitor');
        monitor.addAlert('error', `Task moved to dead letter queue`, {
          taskId,
          retries: taskItem.retries,
          error,
          timestamp: new Date().toISOString()
        });
      }

      await this.save();
      return false; // No retry
    } else {
      // Re-queue with exponential backoff
      const backoffMinutes = Math.pow(2, taskItem.retries) * 5; // 5, 10, 20 minutes
      taskItem.scheduledFor = new Date(Date.now() + backoffMinutes * 60 * 1000).toISOString();
      
      this.queue.push(taskItem);
      this.sortQueue();

      console.log(`[QUEUE] Task ${taskId} re-queued for retry ${taskItem.retries}/${this.maxRetries} in ${backoffMinutes} minutes`);
      
      await this.save();
      return true; // Will retry
    }
  }

  /**
   * Start the drip scheduler
   * @returns {Promise<void>}
   */
  async startScheduler() {
    if (this.scheduler) {
      console.log('[QUEUE] Scheduler already running');
      return;
    }

    console.log('[QUEUE] Starting drip scheduler');
    
    // Random interval between 20-60 minutes
    const getRandomInterval = () => {
      const config = require('./config.json');
      const min = config.backends.claudeCode.minIntervalMinutes || 20;
      const max = config.backends.claudeCode.maxIntervalMinutes || 60;
      return Math.floor(Math.random() * (max - min + 1)) + min;
    };

    // Schedule next drip
    const scheduleNext = () => {
      if (!this.scheduler) return; // Scheduler was stopped

      const intervalMinutes = getRandomInterval();
      console.log(`[QUEUE] Next drip scheduled in ${intervalMinutes} minutes`);
      
      setTimeout(async () => {
        try {
          await this.dripTask();
        } catch (error) {
          console.error('[QUEUE] Error during drip task:', error.message);
        }
        scheduleNext(); // Schedule the next one
      }, intervalMinutes * 60 * 1000);
    };

    // Start the scheduling
    this.scheduler = { active: true };
    scheduleNext();

    // Also check for critical tasks every minute
    this.criticalTaskChecker = cron.schedule('* * * * *', async () => {
      try {
        if (!this.isProcessing) {
          const criticalTask = this.queue.find(item => item.priorityName === 'critical');
          if (criticalTask) {
            console.log('[QUEUE] Critical task found, processing immediately');
            await this.processCriticalTasks();
          }
        }
      } catch (error) {
        console.error('[QUEUE] Error in critical task checker:', error.message);
      }
    });

    this.criticalTaskChecker.start();
  }

  /**
   * Stop the drip scheduler
   */
  stopScheduler() {
    if (this.scheduler) {
      this.scheduler.active = false;
      this.scheduler = null;
      console.log('[QUEUE] Drip scheduler stopped');
    }

    if (this.criticalTaskChecker) {
      this.criticalTaskChecker.destroy();
      this.criticalTaskChecker = null;
      console.log('[QUEUE] Critical task checker stopped');
    }
  }

  /**
   * Process one task from the queue (called by scheduler)
   * @returns {Promise<void>}
   */
  async dripTask() {
    if (this.isProcessing) {
      console.log('[QUEUE] Already processing a task, skipping drip');
      return;
    }

    this.isProcessing = true;

    try {
      const taskItem = await this.processNext();
      if (!taskItem) {
        console.log('[QUEUE] No tasks ready for processing');
        return;
      }

      // Execute the task using the main router
      const router = require('./index');
      
      try {
        console.log(`[QUEUE] Executing dripped task ${taskItem.id}`);
        const result = await router.route(taskItem.task);
        
        console.log(`[QUEUE] Task ${taskItem.id} completed successfully via ${result.backend}`);
        
        // Record success in monitor
        const monitor = require('./monitor');
        await monitor.recordResult(result.backend, taskItem.task, true, result.duration || 0, result.tokens || 0);
        
      } catch (error) {
        console.error(`[QUEUE] Task ${taskItem.id} failed:`, error.message);
        
        // Handle retry logic
        await this.markFailed(taskItem.id, error.message, taskItem);
      }

    } catch (error) {
      console.error('[QUEUE] Error in drip task processing:', error.message);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Process all critical tasks immediately
   * @returns {Promise<void>}
   */
  async processCriticalTasks() {
    const criticalTasks = this.queue.filter(item => item.priorityName === 'critical');
    
    for (const taskItem of criticalTasks) {
      try {
        // Remove from queue
        this.queue = this.queue.filter(item => item.id !== taskItem.id);
        
        const router = require('./index');
        const result = await router.route(taskItem.task);
        
        console.log(`[QUEUE] Critical task ${taskItem.id} completed via ${result.backend}`);
        
        const monitor = require('./monitor');
        await monitor.recordResult(result.backend, taskItem.task, true, result.duration || 0, result.tokens || 0);
        
      } catch (error) {
        console.error(`[QUEUE] Critical task ${taskItem.id} failed:`, error.message);
        await this.markFailed(taskItem.id, error.message, taskItem);
      }
    }

    if (criticalTasks.length > 0) {
      await this.save();
    }
  }

  /**
   * Get queue status information
   * @returns {Promise<Object>} Queue status
   */
  async getQueueStatus() {
    if (!this.loaded) await this.load();

    const now = new Date();
    const priorityCounts = {};
    const readyTasks = [];
    const scheduledTasks = [];

    for (const item of this.queue) {
      // Count by priority
      priorityCounts[item.priorityName] = (priorityCounts[item.priorityName] || 0) + 1;
      
      // Categorize by readiness
      if (item.priorityName === 'critical' || !item.scheduledFor || new Date(item.scheduledFor) <= now) {
        readyTasks.push(item);
      } else {
        scheduledTasks.push(item);
      }
    }

    const nextScheduledTask = scheduledTasks
      .sort((a, b) => new Date(a.scheduledFor) - new Date(b.scheduledFor))[0];

    return {
      totalTasks: this.queue.length,
      readyTasks: readyTasks.length,
      scheduledTasks: scheduledTasks.length,
      deadLetters: this.deadLetters.length,
      priorityCounts,
      nextScheduledTask: nextScheduledTask ? {
        id: nextScheduledTask.id,
        priority: nextScheduledTask.priorityName,
        scheduledFor: nextScheduledTask.scheduledFor,
        minutesUntilReady: Math.max(0, Math.ceil((new Date(nextScheduledTask.scheduledFor) - now) / (1000 * 60)))
      } : null,
      schedulerActive: this.scheduler !== null,
      isProcessing: this.isProcessing,
      lastUpdated: new Date().toISOString()
    };
  }

  /**
   * Get dead letter queue contents
   * @param {number} limit - Maximum number of dead letters to return
   * @returns {Array} Array of dead letter objects
   */
  getDeadLetters(limit = 50) {
    return this.deadLetters.slice(-limit);
  }

  /**
   * Clear dead letter queue
   * @returns {Promise<void>}
   */
  async clearDeadLetters() {
    this.deadLetters = [];
    await this.save();
    console.log('[QUEUE] Dead letter queue cleared');
  }

  /**
   * Manually retry a dead letter task
   * @param {string} deadLetterId - Dead letter task ID
   * @param {string} priority - New priority for retry
   * @returns {Promise<boolean>} Whether the task was found and re-queued
   */
  async retryDeadLetter(deadLetterId, priority = 'normal') {
    const deadLetterIndex = this.deadLetters.findIndex(dl => dl.id === deadLetterId);
    
    if (deadLetterIndex === -1) {
      return false;
    }

    const deadLetter = this.deadLetters[deadLetterIndex];
    
    // Remove from dead letters
    this.deadLetters.splice(deadLetterIndex, 1);
    
    // Reset retry count and re-queue
    const taskId = await this.enqueue(deadLetter.task, priority);
    
    console.log(`[QUEUE] Dead letter ${deadLetterId} retried as new task ${taskId}`);
    return true;
  }

  /**
   * Cleanup old dead letters and queue history
   * @returns {Promise<void>}
   */
  async cleanup() {
    const oldCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // 7 days
    
    // Clean old dead letters
    const originalCount = this.deadLetters.length;
    this.deadLetters = this.deadLetters.filter(dl => 
      new Date(dl.movedToDeadLetterAt) > oldCutoff
    );
    
    if (this.deadLetters.length !== originalCount) {
      console.log(`[QUEUE] Cleaned up ${originalCount - this.deadLetters.length} old dead letters`);
      await this.save();
    }
  }
}

module.exports = new TaskQueue();