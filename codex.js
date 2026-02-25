const pty = require('node-pty');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

/**
 * Codex Parallel Bridge for OpenClaw Task Router
 * Manages parallel execution of tasks via Codex CLI
 */
class CodexBridge {
  constructor() {
    this.config = null;
    this.activeSessions = new Map();
    this.sessionUsage = {
      percentage: 0,
      resetTime: null,
      tasksCompleted: 0
    };
    this.parallelLimit = 3; // Default parallel limit
  }

  /**
   * Initialize the Codex bridge
   * @returns {Promise<void>}
   */
  async initialize() {
    this.config = require('./config.json');
    this.parallelLimit = this.config.backends.codex.maxConcurrent || 3;
    console.log(`[CODEX] Initialized with parallel limit: ${this.parallelLimit}`);
  }

  /**
   * Check if Codex CLI is available
   * @returns {Promise<boolean>} Whether Codex is available
   */
  async isAvailable() {
    if (!this.config) {
      this.config = require('./config.json');
    }

    if (!this.config.backends.codex.enabled) {
      return false;
    }

    try {
      // Check if Codex CLI exists using execSync (pty not needed for simple check)
      const { execSync } = require('child_process');
      const output = execSync('which codex 2>/dev/null || true', { encoding: 'utf8', timeout: 5000 });
      const hasCodexCli = output.trim().length > 0 && !output.includes('not found');
      return hasCodexCli;

    } catch (error) {
      console.error('[CODEX] Error checking availability:', error.message);
      return false;
    }
  }

  /**
   * Get current session status
   * @returns {Promise<Object>} Session status
   */
  async getSessionStatus() {
    if (!this.config) {
      this.config = require('./config.json');
    }

    // Check if we need to reset session usage (5 hours like Claude Code)
    const now = new Date();
    const resetInterval = 5 * 60 * 60 * 1000; // 5 hours
    
    if (!this.sessionUsage.resetTime || (now - new Date(this.sessionUsage.resetTime)) > resetInterval) {
      this.sessionUsage.percentage = 0;
      this.sessionUsage.resetTime = now.toISOString();
      this.sessionUsage.tasksCompleted = 0;
      console.log('[CODEX] Session usage reset');
    }

    return {
      available: await this.isAvailable(),
      usagePercentage: this.sessionUsage.percentage,
      maxUsagePercentage: 70, // Similar to Claude Code
      resetTime: this.sessionUsage.resetTime,
      tasksCompleted: this.sessionUsage.tasksCompleted,
      activeSessions: this.activeSessions.size,
      parallelLimit: this.parallelLimit,
      availableSlots: this.parallelLimit - this.activeSessions.size
    };
  }

  /**
   * Execute a single task using Codex
   * @param {Object} task - Task object
   * @returns {Promise<Object>} Execution result
   */
  async executeTask(task) {
    const startTime = Date.now();
    
    if (!await this.isAvailable()) {
      throw new Error('Codex CLI not available - check installation and authentication');
    }

    const status = await this.getSessionStatus();
    if (status.usagePercentage >= 70) {
      throw new Error(`Codex session limit reached: ${status.usagePercentage}%`);
    }

    if (status.availableSlots <= 0) {
      throw new Error(`Codex parallel limit reached: ${this.activeSessions.size}/${this.parallelLimit} sessions active`);
    }

    const taskId = `codex_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    console.log(`[CODEX] Starting task ${taskId}`);

    try {
      // Create task file
      const taskFile = await this.createTaskFile(task, taskId);
      
      // Execute Codex CLI
      const result = await this.runCodexSession(taskFile, task, taskId);
      
      // Update session usage
      await this.updateSessionUsage(result.estimatedUsage || 10);
      
      // Cleanup
      await this.cleanup(taskFile);
      
      const duration = Date.now() - startTime;
      console.log(`[CODEX] Task ${taskId} completed in ${(duration / 1000).toFixed(1)}s`);

      return {
        success: true,
        backend: 'codex',
        model: 'codex',
        response: result.output,
        duration,
        tokens: result.tokens,
        outputPath: task.outputPath,
        sessionUsage: this.sessionUsage.percentage
      };

    } catch (error) {
      const duration = Date.now() - startTime;
      console.error(`[CODEX] Task ${taskId} failed after ${(duration / 1000).toFixed(1)}s:`, error.message);
      
      // Still update usage even on failure
      await this.updateSessionUsage(5);
      
      throw error;
    }
  }

  /**
   * Execute multiple tasks in parallel
   * @param {Array} tasks - Array of task objects
   * @returns {Promise<Array>} Array of execution results
   */
  async executeParallel(tasks) {
    if (!Array.isArray(tasks) || tasks.length === 0) {
      throw new Error('Tasks must be a non-empty array');
    }

    const status = await this.getSessionStatus();
    
    // Limit to available slots and parallel limit
    const maxTasks = Math.min(tasks.length, status.availableSlots, this.parallelLimit);
    const tasksToExecute = tasks.slice(0, maxTasks);
    const remainingTasks = tasks.slice(maxTasks);

    console.log(`[CODEX] Executing ${tasksToExecute.length} tasks in parallel (${remainingTasks.length} remaining)`);

    try {
      // Execute tasks in parallel
      const promises = tasksToExecute.map(task => this.executeTask(task));
      const results = await Promise.allSettled(promises);

      // Process results
      const successfulResults = [];
      const errors = [];

      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          successfulResults.push(result.value);
        } else {
          errors.push({
            task: tasksToExecute[index],
            error: result.reason.message
          });
        }
      });

      // Handle remaining tasks if any succeeded
      if (remainingTasks.length > 0 && successfulResults.length > 0) {
        console.log(`[CODEX] Processing ${remainingTasks.length} remaining tasks`);
        
        try {
          const remainingResults = await this.executeParallel(remainingTasks);
          successfulResults.push(...remainingResults);
        } catch (error) {
          console.warn(`[CODEX] Error processing remaining tasks:`, error.message);
        }
      }

      if (errors.length > 0) {
        console.warn(`[CODEX] ${errors.length} tasks failed in parallel execution`);
      }

      return {
        success: successfulResults.length > 0,
        results: successfulResults,
        errors: errors,
        totalTasks: tasks.length,
        completedTasks: successfulResults.length,
        failedTasks: errors.length
      };

    } catch (error) {
      console.error('[CODEX] Parallel execution failed:', error.message);
      throw error;
    }
  }

  /**
   * Split a large task into smaller subtasks for parallel execution
   * @param {Object} task - Large task to split
   * @returns {Array} Array of smaller tasks
   */
  splitTask(task) {
    const subtasks = [];
    
    // Analyze task description for natural split points
    const description = task.description.toLowerCase();
    
    if (description.includes('analyze') || description.includes('research')) {
      // Research tasks: split by aspects or sections
      subtasks.push({
        ...task,
        description: `${task.description} - Part 1: Background and context analysis`,
        outputPath: task.outputPath ? task.outputPath.replace(/(\.[^.]+)$/, '-part1$1') : undefined
      });
      
      subtasks.push({
        ...task,
        description: `${task.description} - Part 2: Detailed analysis and findings`,
        outputPath: task.outputPath ? task.outputPath.replace(/(\.[^.]+)$/, '-part2$1') : undefined
      });
      
      subtasks.push({
        ...task,
        description: `${task.description} - Part 3: Conclusions and recommendations`,
        outputPath: task.outputPath ? task.outputPath.replace(/(\.[^.]+)$/, '-part3$1') : undefined
      });
      
    } else if (description.includes('code') || description.includes('implement')) {
      // Code tasks: split by components
      subtasks.push({
        ...task,
        description: `${task.description} - Core implementation`,
        type: 'code',
        outputPath: task.outputPath ? task.outputPath.replace(/(\.[^.]+)$/, '-core$1') : undefined
      });
      
      subtasks.push({
        ...task,
        description: `${task.description} - Error handling and validation`,
        type: 'code',
        outputPath: task.outputPath ? task.outputPath.replace(/(\.[^.]+)$/, '-validation$1') : undefined
      });
      
      subtasks.push({
        ...task,
        description: `${task.description} - Documentation and tests`,
        type: 'docs',
        outputPath: task.outputPath ? task.outputPath.replace(/(\.[^.]+)$/, '-docs$1') : undefined
      });
      
    } else {
      // Generic split: just divide the task
      const parts = Math.min(3, this.parallelLimit);
      for (let i = 0; i < parts; i++) {
        subtasks.push({
          ...task,
          description: `${task.description} - Section ${i + 1} of ${parts}`,
          outputPath: task.outputPath ? task.outputPath.replace(/(\.[^.]+)$/, `-section${i + 1}$1`) : undefined
        });
      }
    }
    
    console.log(`[CODEX] Split task into ${subtasks.length} subtasks`);
    return subtasks;
  }

  /**
   * Create task specification file for Codex
   * @param {Object} task - Task object
   * @param {string} taskId - Task identifier
   * @returns {Promise<string>} Path to created task file
   */
  async createTaskFile(task, taskId) {
    const tempDir = path.join(os.tmpdir(), 'openclaw-codex');
    await fs.mkdir(tempDir, { recursive: true });
    
    const taskFile = path.join(tempDir, `codex-task-${taskId}.md`);
    
    let content = `# Codex Task: ${taskId}\n\n`;
    content += `## Objective\n${task.description}\n\n`;
    
    if (task.type) {
      content += `## Task Type\n${task.type}\n\n`;
    }
    
    if (task.complexity) {
      content += `## Complexity\n${task.complexity}/10\n\n`;
    }
    
    if (task.urgency && task.urgency !== 'normal') {
      content += `## Urgency\n${task.urgency}\n\n`;
    }
    
    if (task.files && task.files.length > 0) {
      content += `## Context Files\n`;
      for (const file of task.files) {
        content += `- ${file}\n`;
      }
      content += '\n';
    }
    
    if (task.outputPath) {
      content += `## Output\n`;
      content += `Save results to: \`${task.outputPath}\`\n\n`;
      
      const ext = path.extname(task.outputPath);
      if (ext) {
        content += `Expected format: ${ext.substring(1).toUpperCase()}\n\n`;
      }
    }
    
    // Add Codex-specific instructions
    content += `## Instructions\n`;
    content += `- Provide comprehensive and accurate results\n`;
    content += `- Include proper error handling where applicable\n`;
    content += `- Add comments for complex logic\n`;
    content += `- Optimize for performance and readability\n\n`;
    
    content += `## Execution Context\n`;
    content += `Working directory: ${task.outputPath ? path.dirname(path.resolve(task.outputPath)) : process.cwd()}\n\n`;
    
    content += `---\n\nExecute this task efficiently and thoroughly.`;
    
    await fs.writeFile(taskFile, content, 'utf8');
    console.log(`[CODEX] Created task file: ${taskFile}`);
    
    return taskFile;
  }

  /**
   * Run Codex CLI session with PTY
   * @param {string} taskFile - Path to task specification
   * @param {Object} task - Original task object
   * @param {string} taskId - Task identifier
   * @returns {Promise<Object>} Execution result
   */
  async runCodexSession(taskFile, task, taskId) {
    return new Promise((resolve, reject) => {
      const timeoutMs = this.config.backends.codex.timeoutSeconds * 1000;
      let output = '';
      let completed = false;
      let rateLimited = false;
      let tokens = 0;

      // Sanitize task file path
      const sanitizedTaskFile = taskFile.replace(/[;&|`$()]/g, '');
      
      // Spawn Codex process using child_process.spawn (works in all contexts)
      const { spawn } = require('child_process');
      const codexProcess = spawn('codex', ['exec', '--model', 'gpt-5.2-codex', '--full-auto', '--skip-git-repo-check', task.description], {
        cwd: task.outputPath ? path.dirname(path.resolve(task.outputPath))
           : task.workdir ? path.resolve(task.workdir)
           : (() => {
               const taskDir = path.join(os.tmpdir(), 'openclaw-codex', `task-${taskId}`);
               require('fs').mkdirSync(taskDir, { recursive: true });
               return taskDir;
             })(),
        env: {
          ...process.env,
          TERM: 'xterm-256color'
        },
        stdio: ['pipe', 'pipe', 'pipe']
      });

      this.activeSessions.set(taskId, codexProcess);

      // Close stdin so Codex doesn't wait for input
      codexProcess.stdin.end();

      // Set timeout
      const timeout = setTimeout(() => {
        if (!completed) {
          console.error(`[CODEX] Task ${taskId} timed out after ${timeoutMs/1000}s`);
          codexProcess.kill('SIGTERM');
          this.activeSessions.delete(taskId);
          const timeoutError = new Error(`Codex backend timeout - task exceeded ${timeoutMs/1000} seconds`);
          timeoutError.code = 'CODEX_TIMEOUT';
          timeoutError.backend = 'codex';
          timeoutError.shouldFallback = true;
          reject(timeoutError);
        }
      }, timeoutMs);

      // Handle output
      codexProcess.stdout.on('data', (data) => {
        const chunk = data.toString();
        output += chunk;
        
        // Check for rate limiting
        if (chunk.includes('rate limit') || 
            chunk.includes('quota exceeded') || 
            chunk.includes('too many requests') ||
            chunk.includes('usage limit')) {
          rateLimited = true;
          console.warn(`[CODEX] Rate limit detected for task ${taskId}`);
        }
        
        // Check for completion
        if (chunk.includes('Task completed') || 
            chunk.includes('Done') || 
            chunk.includes('✓') ||
            chunk.includes('finished') ||
            chunk.includes('execution complete')) {
          console.log(`[CODEX] Completion signal detected for task ${taskId}`);
        }
        
        // Extract token count
        const tokenMatch = chunk.match(/(\d+)\s+tokens?/i);
        if (tokenMatch) {
          tokens = Math.max(tokens, parseInt(tokenMatch[1]));
        }
      });

      codexProcess.stderr.on('data', (data) => {
        output += data.toString();
      });

      // Handle exit
      codexProcess.on('exit', (code) => {
        completed = true;
        clearTimeout(timeout);
        this.activeSessions.delete(taskId);
        
        if (rateLimited) {
          this.sessionUsage.percentage = 100;
          reject(new Error('Codex rate limit hit - session exhausted'));
          return;
        }
        
        if (code !== 0) {
          reject(new Error(`Codex process exited with code ${code}. Output: ${output.slice(-500)}`));
          return;
        }
        
        if (tokens === 0) {
          tokens = this.estimateTokens(output);
        }
        
        resolve({
          output: output.trim(),
          tokens,
          estimatedUsage: Math.min(tokens / 1000, 15),
          code
        });
      });

      // Handle errors
      codexProcess.on('error', (error) => {
        completed = true;
        clearTimeout(timeout);
        this.activeSessions.delete(taskId);
        reject(new Error(`Codex process error: ${error.message}`));
      });
    });
  }

  /**
   * Update session usage tracking
   * @param {number} usagePercent - Usage percentage to add
   * @returns {Promise<void>}
   */
  async updateSessionUsage(usagePercent) {
    this.sessionUsage.percentage += usagePercent;
    this.sessionUsage.tasksCompleted++;
    
    // Update ledger
    const ledger = require('./ledger');
    await ledger.recordUsage('codex', {}, null, null);
    
    console.log(`[CODEX] Session usage updated: ${this.sessionUsage.percentage.toFixed(1)}%`);
  }

  /**
   * Estimate token count
   * @param {string} text - Text to estimate
   * @returns {number} Estimated tokens
   */
  estimateTokens(text) {
    if (!text) return 1000;
    return Math.ceil(text.length / 3.5);
  }

  /**
   * Clean up temporary files
   * @param {string} taskFile - Task file to clean up
   * @returns {Promise<void>}
   */
  async cleanup(taskFile, taskId) {
    try {
      await fs.unlink(taskFile);
      console.log(`[CODEX] Cleaned up task file: ${taskFile}`);
    } catch (error) {
      console.warn(`[CODEX] Could not clean up task file ${taskFile}:`, error.message);
    }
    // Clean up temp working directory if it exists
    if (taskId) {
      const taskDir = path.join(os.tmpdir(), 'openclaw-codex', `task-${taskId}`);
      try {
        await fs.rm(taskDir, { recursive: true, force: true });
      } catch (e) { /* ignore */ }
    }
  }

  /**
   * Kill all active sessions
   * @returns {Promise<void>}
   */
  async killAllSessions() {
    console.log(`[CODEX] Killing ${this.activeSessions.size} active sessions`);
    
    for (const [taskId, process] of this.activeSessions.entries()) {
      try {
        process.kill();
        console.log(`[CODEX] Killed session: ${taskId}`);
      } catch (error) {
        console.warn(`[CODEX] Error killing session ${taskId}:`, error.message);
      }
    }
    
    this.activeSessions.clear();
  }

  /**
   * Reset session usage
   * @returns {Promise<void>}
   */
  async resetSession() {
    this.sessionUsage.percentage = 0;
    this.sessionUsage.resetTime = new Date().toISOString();
    this.sessionUsage.tasksCompleted = 0;
    
    console.log('[CODEX] Session usage manually reset');
    
    const ledger = require('./ledger');
    await ledger.resetSession('codex');
  }

  /**
   * Get detailed status
   * @returns {Promise<Object>} Detailed status
   */
  async getDetailedStatus() {
    const basicStatus = await this.getSessionStatus();
    
    return {
      ...basicStatus,
      config: {
        enabled: this.config.backends.codex.enabled,
        maxConcurrent: this.config.backends.codex.maxConcurrent,
        timeoutSeconds: this.config.backends.codex.timeoutSeconds
      },
      activeSessions: Array.from(this.activeSessions.keys())
    };
  }

  /**
   * Test Codex connection
   * @returns {Promise<Object>} Test results
   */
  async testConnection() {
    const startTime = Date.now();
    
    try {
      const available = await this.isAvailable();
      if (!available) {
        return {
          success: false,
          duration: Date.now() - startTime,
          error: 'Codex CLI not available'
        };
      }

      const testTask = {
        description: 'Return the text "Codex test successful"',
        type: 'other',
        urgency: 'normal'
      };

      const result = await this.executeTask(testTask);
      
      return {
        success: result.success,
        duration: Date.now() - startTime,
        tokens: result.tokens,
        sessionUsage: result.sessionUsage
      };
      
    } catch (error) {
      return {
        success: false,
        duration: Date.now() - startTime,
        error: error.message
      };
    }
  }
}

module.exports = new CodexBridge();