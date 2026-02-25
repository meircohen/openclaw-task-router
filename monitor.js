const fs = require('fs').promises;
const path = require('path');

/**
 * Health & Performance Monitoring System for OpenClaw Task Router
 * Tracks success rates, completion times, and provides adaptive scoring
 */
class Monitor {
  constructor() {
    const dataDir = process.env.ROUTER_TEST_MODE ? process.env.ROUTER_TEST_DATA_DIR : path.join(__dirname, 'data');
    this.dataPath = path.join(dataDir, 'monitor.json');
    this.data = {
      backends: {
        claudeCode: { results: [], totalTasks: 0, successRate: 0, avgDuration: 0, avgTokens: 0 },
        codex: { results: [], totalTasks: 0, successRate: 0, avgDuration: 0, avgTokens: 0 },
        api: { results: [], totalTasks: 0, successRate: 0, avgDuration: 0, avgTokens: 0 },
        local: { results: [], totalTasks: 0, successRate: 0, avgDuration: 0, avgTokens: 0 }
      },
      taskTypes: {
        code: { results: [], totalTasks: 0, successRate: 0, avgDuration: 0 },
        review: { results: [], totalTasks: 0, successRate: 0, avgDuration: 0 },
        docs: { results: [], totalTasks: 0, successRate: 0, avgDuration: 0 },
        research: { results: [], totalTasks: 0, successRate: 0, avgDuration: 0 },
        analysis: { results: [], totalTasks: 0, successRate: 0, avgDuration: 0 },
        other: { results: [], totalTasks: 0, successRate: 0, avgDuration: 0 }
      },
      alerts: [],
      lastUpdated: new Date().toISOString()
    };
    this.loaded = false;
    this.maxResults = 1000; // Keep last 1000 results per category
  }

  /**
   * Load monitor data from persistent storage
   * @returns {Promise<void>}
   */
  async load() {
    try {
      const dataStr = await fs.readFile(this.dataPath, 'utf8');
      this.data = { ...this.data, ...JSON.parse(dataStr) };
      this.loaded = true;
      console.log('[MONITOR] Performance data loaded successfully');
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.log('[MONITOR] No existing performance data, starting fresh');
        await this.save();
        this.loaded = true;
      } else {
        console.error('[MONITOR] Error loading performance data:', error.message);
        this.loaded = true; // Continue with defaults
      }
    }
  }

  /**
   * Save monitor data to persistent storage
   * @returns {Promise<void>}
   */
  async save() {
    try {
      this.data.lastUpdated = new Date().toISOString();
      await fs.mkdir(path.dirname(this.dataPath), { recursive: true });
      await fs.writeFile(this.dataPath, JSON.stringify(this.data, null, 2));
    } catch (error) {
      console.error('[MONITOR] Error saving performance data:', error.message);
    }
  }

  /**
   * Record a task result for performance tracking
   * @param {string} backend - Backend name (claudeCode, codex, api, local)
   * @param {Object} task - Task object with type information
   * @param {boolean} success - Whether the task succeeded
   * @param {number} duration - Duration in milliseconds
   * @param {number} tokens - Token count used
   * @returns {Promise<void>}
   */
  async recordResult(backend, task, success, duration, tokens = 0) {
    if (!this.loaded) await this.load();

    const timestamp = new Date().toISOString();
    const result = {
      timestamp,
      success,
      duration,
      tokens,
      taskType: task.type || 'other',
      urgency: task.urgency || 'normal',
      complexity: task.complexity || 5
    };

    // Record backend performance
    if (this.data.backends[backend]) {
      this.data.backends[backend].results.push(result);
      this.data.backends[backend].totalTasks++;
      
      // Keep only recent results
      if (this.data.backends[backend].results.length > this.maxResults) {
        this.data.backends[backend].results = this.data.backends[backend].results.slice(-this.maxResults);
      }
      
      this.updateBackendStats(backend);
    }

    // Record task type performance
    const taskType = task.type || 'other';
    if (this.data.taskTypes[taskType]) {
      this.data.taskTypes[taskType].results.push(result);
      this.data.taskTypes[taskType].totalTasks++;
      
      if (this.data.taskTypes[taskType].results.length > this.maxResults) {
        this.data.taskTypes[taskType].results = this.data.taskTypes[taskType].results.slice(-this.maxResults);
      }
      
      this.updateTaskTypeStats(taskType);
    }

    // Generate alerts for concerning patterns
    await this.checkAlerts(backend, task, success, duration);

    console.log(`[MONITOR] Recorded ${success ? 'SUCCESS' : 'FAILURE'} for ${backend}/${taskType} (${duration}ms, ${tokens} tokens)`);
    await this.save();
  }

  /**
   * Update backend performance statistics
   * @param {string} backend - Backend name
   */
  updateBackendStats(backend) {
    const results = this.data.backends[backend].results;
    const recentResults = this.getRecentResults(results, 7); // Last 7 days

    if (recentResults.length > 0) {
      const successes = recentResults.filter(r => r.success).length;
      this.data.backends[backend].successRate = (successes / recentResults.length) * 100;
      this.data.backends[backend].avgDuration = recentResults.reduce((sum, r) => sum + r.duration, 0) / recentResults.length;
      this.data.backends[backend].avgTokens = recentResults.reduce((sum, r) => sum + r.tokens, 0) / recentResults.length;
    }
  }

  /**
   * Update task type performance statistics
   * @param {string} taskType - Task type
   */
  updateTaskTypeStats(taskType) {
    const results = this.data.taskTypes[taskType].results;
    const recentResults = this.getRecentResults(results, 7);

    if (recentResults.length > 0) {
      const successes = recentResults.filter(r => r.success).length;
      this.data.taskTypes[taskType].successRate = (successes / recentResults.length) * 100;
      this.data.taskTypes[taskType].avgDuration = recentResults.reduce((sum, r) => sum + r.duration, 0) / recentResults.length;
    }
  }

  /**
   * Get results from the last N days
   * @param {Array} results - Array of result objects
   * @param {number} days - Number of days to look back
   * @returns {Array} Filtered results
   */
  getRecentResults(results, days) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    return results.filter(r => new Date(r.timestamp) > cutoff);
  }

  /**
   * Check for performance issues and generate alerts
   * @param {string} backend - Backend name
   * @param {Object} task - Task object
   * @param {boolean} success - Task success status
   * @param {number} duration - Task duration
   * @returns {Promise<void>}
   */
  async checkAlerts(backend, task, success, duration) {
    const config = require('./config.json');
    
    // Alert on failure
    if (!success) {
      this.addAlert('error', `Task failed on ${backend}`, {
        backend,
        taskType: task.type,
        urgency: task.urgency,
        timestamp: new Date().toISOString()
      });
    }

    // Alert on timeout
    const timeoutMs = config.backends[backend]?.timeoutSeconds * 1000 || 900000;
    if (duration > timeoutMs * 0.8) {
      this.addAlert('warning', `Task approaching timeout on ${backend}`, {
        backend,
        duration: Math.round(duration / 1000) + 's',
        timeout: Math.round(timeoutMs / 1000) + 's',
        timestamp: new Date().toISOString()
      });
    }

    // Alert on low success rate
    const backendStats = this.data.backends[backend];
    if (backendStats && backendStats.totalTasks >= 10 && backendStats.successRate < 50) {
      this.addAlert('error', `Low success rate for ${backend}`, {
        backend,
        successRate: backendStats.successRate.toFixed(1) + '%',
        totalTasks: backendStats.totalTasks,
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * Add an alert to the system
   * @param {string} level - Alert level (info, warning, error)
   * @param {string} message - Alert message
   * @param {Object} details - Additional alert details
   */
  addAlert(level, message, details = {}) {
    const alert = {
      id: Date.now() + Math.random(),
      level,
      message,
      details,
      timestamp: new Date().toISOString(),
      acknowledged: false
    };

    this.data.alerts.push(alert);
    
    // Keep only last 100 alerts
    if (this.data.alerts.length > 100) {
      this.data.alerts = this.data.alerts.slice(-100);
    }

    console.log(`[MONITOR] ALERT [${level.toUpperCase()}]: ${message}`);
  }

  /**
   * Get adaptive scoring for backend selection
   * @param {string} backend - Backend name
   * @param {Object} task - Task object
   * @returns {number} Score from 0-100 (higher is better)
   */
  getAdaptiveScore(backend, task) {
    const config = require('./config.json');
    
    if (!config.routing.adaptiveScoringEnabled) {
      return 50; // Neutral score when adaptive scoring disabled
    }

    const backendStats = this.data.backends[backend];
    if (!backendStats || backendStats.totalTasks < 3) {
      return 50; // Not enough data, neutral score
    }

    let score = 50; // Base score

    // Success rate component (40% weight)
    score += (backendStats.successRate - 50) * 0.4;

    // Speed component (30% weight) - faster is better
    const avgDurationMinutes = backendStats.avgDuration / (1000 * 60);
    if (avgDurationMinutes < 2) score += 15;
    else if (avgDurationMinutes < 5) score += 10;
    else if (avgDurationMinutes < 10) score += 5;
    else if (avgDurationMinutes > 15) score -= 10;

    // Task type affinity (20% weight)
    const taskType = task.type || 'other';
    const taskStats = this.data.taskTypes[taskType];
    if (taskStats && taskStats.totalTasks >= 3) {
      const typeResults = taskStats.results.filter(r => r.success);
      const backendTypeResults = typeResults.filter(r => {
        // This is approximate - we don't store backend per task type result
        return true;
      });
      
      if (backendTypeResults.length > 0) {
        score += 5; // Bonus for having experience with this task type
      }
    }

    // Urgency component (10% weight)
    if (task.urgency === 'immediate' && backendStats.avgDuration < 5 * 60 * 1000) {
      score += 5; // Bonus for fast backends on urgent tasks
    }

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Get comprehensive performance report
   * @returns {Promise<Object>} Performance report
   */
  async getPerformanceReport() {
    if (!this.loaded) await this.load();

    const report = {
      summary: {
        totalTasks: 0,
        overallSuccessRate: 0,
        avgDurationMinutes: 0
      },
      backends: {},
      taskTypes: {},
      recentAlerts: this.data.alerts.filter(a => !a.acknowledged).slice(-10),
      lastUpdated: this.data.lastUpdated
    };

    // Backend performance
    for (const [backend, stats] of Object.entries(this.data.backends)) {
      report.backends[backend] = {
        totalTasks: stats.totalTasks,
        successRate: stats.successRate.toFixed(1) + '%',
        avgDurationMinutes: (stats.avgDuration / (1000 * 60)).toFixed(1),
        avgTokens: Math.round(stats.avgTokens),
        score: this.getAdaptiveScore(backend, { type: 'code', urgency: 'normal' }),
        recentResults: stats.results.slice(-5).map(r => ({
          timestamp: r.timestamp,
          success: r.success,
          duration: Math.round(r.duration / 1000) + 's'
        }))
      };
      
      report.summary.totalTasks += stats.totalTasks;
    }

    // Task type performance
    for (const [taskType, stats] of Object.entries(this.data.taskTypes)) {
      if (stats.totalTasks > 0) {
        report.taskTypes[taskType] = {
          totalTasks: stats.totalTasks,
          successRate: stats.successRate.toFixed(1) + '%',
          avgDurationMinutes: (stats.avgDuration / (1000 * 60)).toFixed(1)
        };
      }
    }

    // Overall metrics
    if (report.summary.totalTasks > 0) {
      const allResults = Object.values(this.data.backends)
        .flatMap(b => b.results)
        .filter(r => r.timestamp > new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
      
      if (allResults.length > 0) {
        const successes = allResults.filter(r => r.success).length;
        report.summary.overallSuccessRate = ((successes / allResults.length) * 100).toFixed(1) + '%';
        report.summary.avgDurationMinutes = (allResults.reduce((sum, r) => sum + r.duration, 0) / allResults.length / (1000 * 60)).toFixed(1);
      }
    }

    return report;
  }

  /**
   * Get current alerts
   * @param {boolean} unacknowledgedOnly - Whether to return only unacknowledged alerts
   * @returns {Array} Array of alert objects
   */
  getAlerts(unacknowledgedOnly = true) {
    if (unacknowledgedOnly) {
      return this.data.alerts.filter(a => !a.acknowledged);
    }
    return [...this.data.alerts];
  }

  /**
   * Acknowledge an alert
   * @param {number|string} alertId - Alert ID to acknowledge
   * @returns {Promise<boolean>} Whether the alert was found and acknowledged
   */
  async acknowledgeAlert(alertId) {
    const alert = this.data.alerts.find(a => a.id === alertId);
    if (alert) {
      alert.acknowledged = true;
      alert.acknowledgedAt = new Date().toISOString();
      await this.save();
      console.log(`[MONITOR] Alert ${alertId} acknowledged`);
      return true;
    }
    return false;
  }

  /**
   * Clear old alerts and results to prevent data bloat
   * @returns {Promise<void>}
   */
  async cleanup() {
    if (!this.loaded) await this.load();

    const oldCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days

    // Clean old alerts
    this.data.alerts = this.data.alerts.filter(a => 
      new Date(a.timestamp) > oldCutoff || !a.acknowledged
    );

    // Clean old results for each backend
    for (const backend of Object.keys(this.data.backends)) {
      this.data.backends[backend].results = this.data.backends[backend].results.filter(r =>
        new Date(r.timestamp) > oldCutoff
      );
    }

    // Clean old results for each task type
    for (const taskType of Object.keys(this.data.taskTypes)) {
      this.data.taskTypes[taskType].results = this.data.taskTypes[taskType].results.filter(r =>
        new Date(r.timestamp) > oldCutoff
      );
    }

    console.log('[MONITOR] Cleaned up old performance data');
    await this.save();
  }
}

module.exports = new Monitor();