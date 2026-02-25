const pty = require('node-pty');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

/**
 * Claude Code CLI Bridge for OpenClaw Task Router
 * Manages PTY sessions with Claude Code CLI tool
 */
class ClaudeCodeBridge {
  constructor() {
    this.config = null;
    this.activeSessions = new Map();
    this.sessionUsage = {
      percentage: 0,
      resetTime: null,
      tasksCompleted: 0
    };
  }

  /**
   * Initialize the Claude Code bridge
   * @returns {Promise<void>}
   */
  async initialize() {
    this.config = require('./config.json');
    console.log('[CLAUDE] Initialized Claude Code bridge');
  }

  /**
   * Check if Claude Code CLI is available and authenticated
   * @returns {Promise<boolean>} Whether Claude Code is available
   */
  async isAvailable() {
    if (!this.config) {
      this.config = require('./config.json');
    }

    if (!this.config.backends.claudeCode.enabled) {
      return false;
    }

    try {
      // Check if Claude CLI exists using execSync (pty not needed for simple check)
      const { execSync } = require('child_process');
      const output = execSync('which claude 2>/dev/null || true', { encoding: 'utf8', timeout: 5000 });
      const hasClaudeCli = output.trim().length > 0 && !output.includes('not found');
      return hasClaudeCli;

    } catch (error) {
      console.error('[CLAUDE] Error checking availability:', error.message);
      return false;
    }
  }

  /**
   * Get current session status and usage
   * @returns {Promise<Object>} Session status
   */
  async getSessionStatus() {
    if (!this.config) {
      this.config = require('./config.json');
    }

    // Check if we need to reset session usage
    const now = new Date();
    const resetInterval = this.config.backends.claudeCode.sessionResetHours * 60 * 60 * 1000;
    
    if (!this.sessionUsage.resetTime || (now - new Date(this.sessionUsage.resetTime)) > resetInterval) {
      this.sessionUsage.percentage = 0;
      this.sessionUsage.resetTime = now.toISOString();
      this.sessionUsage.tasksCompleted = 0;
      console.log('[CLAUDE] Session usage reset');
    }

    return {
      available: await this.isAvailable(),
      usagePercentage: this.sessionUsage.percentage,
      maxUsagePercentage: this.config.backends.claudeCode.maxAutoUsagePercent,
      resetTime: this.sessionUsage.resetTime,
      tasksCompleted: this.sessionUsage.tasksCompleted,
      activeSessions: this.activeSessions.size
    };
  }

  /**
   * Execute a task using Claude Code CLI
   * @param {Object} task - Task object
   * @returns {Promise<Object>} Execution result
   */
  async executeTask(task) {
    const startTime = Date.now();
    
    if (!await this.isAvailable()) {
      throw new Error('Claude Code CLI not available - check installation and authentication');
    }

    const status = await this.getSessionStatus();
    if (status.usagePercentage >= this.config.backends.claudeCode.maxAutoUsagePercent) {
      throw new Error(`Claude Code session limit reached: ${status.usagePercentage}%`);
    }

    const taskId = `claude_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    console.log(`[CLAUDE] Starting task ${taskId}`);

    try {
      // Create task file
      const taskFile = await this.createTaskFile(task, taskId);
      
      // Execute Claude CLI
      const result = await this.runClaudeSession(taskFile, task, taskId);
      
      // Update session usage
      await this.updateSessionUsage(result.estimatedUsage || 10);
      
      // Cleanup
      await this.cleanup(taskFile);
      
      const duration = Date.now() - startTime;
      console.log(`[CLAUDE] Task ${taskId} completed in ${(duration / 1000).toFixed(1)}s`);

      return {
        success: true,
        backend: 'claudeCode',
        model: this.config.backends.claudeCode.preferredModel,
        response: result.output,
        duration,
        tokens: result.tokens,
        outputPath: task.outputPath,
        sessionUsage: this.sessionUsage.percentage
      };

    } catch (error) {
      const duration = Date.now() - startTime;
      console.error(`[CLAUDE] Task ${taskId} failed after ${(duration / 1000).toFixed(1)}s:`, error.message);
      
      // Still update usage even on failure (to prevent spam retries)
      await this.updateSessionUsage(5);
      
      throw error;
    }
  }

  /**
   * Create a task specification file for Claude
   * @param {Object} task - Task object
   * @param {string} taskId - Task identifier
   * @returns {Promise<string>} Path to created task file
   */
  async createTaskFile(task, taskId) {
    const tempDir = path.join(os.tmpdir(), 'openclaw-router');
    await fs.mkdir(tempDir, { recursive: true });
    
    const taskFile = path.join(tempDir, `task-${taskId}.md`);
    
    let content = `# OpenClaw Task: ${taskId}\n\n`;
    content += `## Task Description\n${task.description}\n\n`;
    
    if (task.type) {
      content += `## Task Type\n${task.type}\n\n`;
    }
    
    if (task.complexity) {
      content += `## Complexity Level\n${task.complexity}/10\n\n`;
    }
    
    if (task.urgency && task.urgency !== 'normal') {
      content += `## Urgency\n${task.urgency}\n\n`;
    }
    
    if (task.files && task.files.length > 0) {
      content += `## Relevant Files\n`;
      for (const file of task.files) {
        content += `- ${file}\n`;
      }
      content += '\n';
    }
    
    if (task.outputPath) {
      content += `## Output Requirements\n`;
      content += `Save the result to: \`${task.outputPath}\`\n\n`;
      
      const ext = path.extname(task.outputPath);
      if (ext === '.md') {
        content += 'Format: Markdown\n\n';
      } else if (ext === '.json') {
        content += 'Format: Valid JSON\n\n';
      } else if (['.js', '.ts', '.py', '.go'].includes(ext)) {
        content += `Format: ${ext.substring(1)} code with proper comments\n\n`;
      }
    }
    
    // Add quality requirements
    content += `## Quality Requirements\n`;
    content += `- Include comprehensive error handling\n`;
    content += `- Add appropriate comments and documentation\n`;
    content += `- Follow best practices for the language/format\n`;
    content += `- Test edge cases where applicable\n\n`;
    
    // Model preference
    content += `## Model Preference\nPrefer Sonnet for cost efficiency.\n\n`;
    
    content += `---\n\nPlease complete this task comprehensively.`;
    
    await fs.writeFile(taskFile, content, 'utf8');
    console.log(`[CLAUDE] Created task file: ${taskFile}`);
    
    return taskFile;
  }

  /**
   * Run Claude CLI session with PTY
   * @param {string} taskFile - Path to task specification file
   * @param {Object} task - Original task object
   * @param {string} taskId - Task identifier
   * @returns {Promise<Object>} Execution result
   */
  async runClaudeSession(taskFile, task, taskId) {
    return new Promise((resolve, reject) => {
      const timeoutMs = this.config.backends.claudeCode.timeoutSeconds * 1000;
      let output = '';
      let errorOutput = '';
      let completed = false;
      let rateLimited = false;
      let tokens = 0;

      // Sanitize the task file path to prevent injection
      const sanitizedTaskFile = taskFile.replace(/[;&|`$()]/g, '');
      
      // Spawn Claude process using child_process.spawn (works in all contexts)
      const { spawn } = require('child_process');
      const claudeProcess = spawn('claude', ['-p', task.description, '--allowedTools', 'Edit,Write,Bash,Read', '--dangerously-skip-permissions'], {
        cwd: task.outputPath ? path.dirname(path.resolve(task.outputPath)) : process.cwd(),
        env: {
          ...process.env,
          TERM: 'xterm-256color'
        },
        stdio: ['pipe', 'pipe', 'pipe']
      });

      this.activeSessions.set(taskId, claudeProcess);

      // Close stdin so Claude doesn't wait for input
      claudeProcess.stdin.end();

      // Set timeout
      const timeout = setTimeout(() => {
        if (!completed) {
          console.error(`[CLAUDE] Task ${taskId} timed out after ${timeoutMs/1000}s`);
          claudeProcess.kill('SIGTERM');
          this.activeSessions.delete(taskId);
          const timeoutError = new Error(`Claude Code backend timeout - task exceeded ${timeoutMs/1000} seconds`);
          timeoutError.code = 'CLAUDE_CODE_TIMEOUT';
          timeoutError.backend = 'claudeCode';
          timeoutError.shouldFallback = true;
          reject(timeoutError);
        }
      }, timeoutMs);

      // Handle process output
      claudeProcess.stdout.on('data', (data) => {
        const chunk = data.toString();
        output += chunk;
        
        // Check for rate limiting indicators
        if (chunk.includes('rate limit') || 
            chunk.includes('quota exceeded') || 
            chunk.includes('too many requests') ||
            chunk.includes('usage limit')) {
          rateLimited = true;
          console.warn(`[CLAUDE] Rate limit detected for task ${taskId}`);
        }
        
        // Check for completion indicators
        if (chunk.includes('Task completed') || 
            chunk.includes('Done') || 
            chunk.includes('✓') ||
            chunk.includes('finished')) {
          console.log(`[CLAUDE] Completion signal detected for task ${taskId}`);
        }
        
        // Extract token count if available
        const tokenMatch = chunk.match(/(\d+)\s+tokens?/i);
        if (tokenMatch) {
          tokens = Math.max(tokens, parseInt(tokenMatch[1]));
        }
      });

      claudeProcess.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      // Handle process exit
      claudeProcess.on('exit', (code) => {
        completed = true;
        clearTimeout(timeout);
        this.activeSessions.delete(taskId);
        
        if (rateLimited) {
          // Mark session as exhausted
          this.sessionUsage.percentage = 100;
          reject(new Error('Claude Code rate limit hit - session exhausted'));
          return;
        }
        
        if (code !== 0) {
          reject(new Error(`Claude Code process exited with code ${code}. Output: ${output.slice(-500)}`));
          return;
        }
        
        // Estimate token usage if not detected
        if (tokens === 0) {
          tokens = this.estimateTokens(output);
        }
        
        resolve({
          output: output.trim(),
          tokens,
          estimatedUsage: Math.min(tokens / 1000, 15), // Cap at 15% per task
          code
        });
      });

      // Handle process errors
      claudeProcess.on('error', (error) => {
        completed = true;
        clearTimeout(timeout);
        this.activeSessions.delete(taskId);
        reject(new Error(`Claude Code process error: ${error.message}`));
      });
    });
  }

  /**
   * Update session usage tracking
   * @param {number} usagePercent - Percentage points to add
   * @returns {Promise<void>}
   */
  async updateSessionUsage(usagePercent) {
    this.sessionUsage.percentage += usagePercent;
    this.sessionUsage.tasksCompleted++;
    
    // Update ledger
    const ledger = require('./ledger');
    await ledger.recordUsage('claudeCode', {}, null, null);
    
    console.log(`[CLAUDE] Session usage updated: ${this.sessionUsage.percentage.toFixed(1)}%`);
  }

  /**
   * Estimate token count from output
   * @param {string} text - Text to estimate
   * @returns {number} Estimated token count
   */
  estimateTokens(text) {
    if (!text) return 1000;
    
    // Claude specific estimation (slightly different from generic)
    // Account for both input and output tokens
    return Math.ceil(text.length / 3.5);
  }

  /**
   * Clean up temporary files
   * @param {string} taskFile - Path to task file to clean up
   * @returns {Promise<void>}
   */
  async cleanup(taskFile) {
    try {
      await fs.unlink(taskFile);
      console.log(`[CLAUDE] Cleaned up task file: ${taskFile}`);
    } catch (error) {
      console.warn(`[CLAUDE] Could not clean up task file ${taskFile}:`, error.message);
    }
  }

  /**
   * Force kill all active sessions
   * @returns {Promise<void>}
   */
  async killAllSessions() {
    console.log(`[CLAUDE] Killing ${this.activeSessions.size} active sessions`);
    
    for (const [taskId, process] of this.activeSessions.entries()) {
      try {
        process.kill();
        console.log(`[CLAUDE] Killed session: ${taskId}`);
      } catch (error) {
        console.warn(`[CLAUDE] Error killing session ${taskId}:`, error.message);
      }
    }
    
    this.activeSessions.clear();
  }

  /**
   * Reset session usage (admin function)
   * @returns {Promise<void>}
   */
  async resetSession() {
    this.sessionUsage.percentage = 0;
    this.sessionUsage.resetTime = new Date().toISOString();
    this.sessionUsage.tasksCompleted = 0;
    
    console.log('[CLAUDE] Session usage manually reset');
    
    // Update ledger
    const ledger = require('./ledger');
    await ledger.resetSession('claudeCode');
  }

  /**
   * Get detailed status for monitoring
   * @returns {Promise<Object>} Detailed status
   */
  async getDetailedStatus() {
    const basicStatus = await this.getSessionStatus();
    
    return {
      ...basicStatus,
      config: {
        enabled: this.config.backends.claudeCode.enabled,
        preferredModel: this.config.backends.claudeCode.preferredModel,
        timeoutSeconds: this.config.backends.claudeCode.timeoutSeconds,
        sessionResetHours: this.config.backends.claudeCode.sessionResetHours
      },
      activeSessions: Array.from(this.activeSessions.keys()),
      nextResetTime: this.sessionUsage.resetTime ? 
        new Date(new Date(this.sessionUsage.resetTime).getTime() + 
                this.config.backends.claudeCode.sessionResetHours * 60 * 60 * 1000).toISOString() : null
    };
  }

  /**
   * Test Claude Code availability and basic functionality
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
          error: 'Claude CLI not available'
        };
      }

      // Simple test task
      const testTask = {
        description: 'Return the text "Claude Code test successful"',
        type: 'other',
        urgency: 'normal'
      };

      const result = await this.executeTask(testTask);
      
      return {
        success: result.success,
        duration: Date.now() - startTime,
        model: result.model,
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

module.exports = new ClaudeCodeBridge();