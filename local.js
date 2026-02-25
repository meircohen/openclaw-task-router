const axios = require('axios');

/**
 * Local Model Bridge for OpenClaw Task Router - Ollama Integration
 * Handles local AI model execution via Ollama HTTP API
 */
class LocalBridge {
  constructor() {
    this.config = null;
    this.availableModels = [];
    this.lastModelCheck = null;
    this.modelCheckInterval = 5 * 60 * 1000; // 5 minutes
  }

  /**
   * Initialize the local bridge and check model availability
   * @returns {Promise<void>}
   */
  async initialize() {
    this.config = require('./config.json');
    await this.checkModelsAvailability();
    console.log('[LOCAL] Initialized with', this.availableModels.length, 'available models');
  }

  /**
   * Check which models are available in Ollama
   * @returns {Promise<void>}
   */
  async checkModelsAvailability() {
    try {
      const response = await axios.get(`${this.config.backends.local.ollamaUrl}/api/tags`, {
        timeout: 10000
      });
      
      this.availableModels = response.data.models.map(model => model.name);
      this.lastModelCheck = new Date();
      
      console.log('[LOCAL] Available models:', this.availableModels.join(', '));
    } catch (error) {
      console.error('[LOCAL] Error checking available models:', error.message);
      this.availableModels = [];
    }
  }

  /**
   * Get available models (with caching)
   * @returns {Promise<Array>} Array of available model names
   */
  async listModels() {
    // Refresh model list if it's stale
    if (!this.lastModelCheck || (Date.now() - this.lastModelCheck > this.modelCheckInterval)) {
      await this.checkModelsAvailability();
    }
    
    return [...this.availableModels];
  }

  /**
   * Select the best model for a given task type
   * @param {string} taskType - Task type (code, docs, review, other)
   * @returns {string|null} Best available model name or null if none available
   */
  selectModel(taskType) {
    if (!this.config) {
      this.config = require('./config.json');
    }

    const preferredModels = this.config.backends.local.models;
    let candidates = [];

    switch (taskType) {
      case 'code':
      case 'review':
        candidates = [
          preferredModels.code,
          'deepseek-coder:latest',
          'codestral:latest',
          'codegeex4:latest'
        ];
        break;
        
      case 'docs':
      case 'writing':
        candidates = [
          preferredModels.docs,
          'llama3:latest',
          'qwen2:latest',
          'gemma2:latest'
        ];
        break;
        
      case 'analysis':
      case 'research':
        candidates = [
          'llama3:latest',
          preferredModels.docs,
          'qwen2:latest'
        ];
        break;
        
      default:
        candidates = [
          preferredModels.docs,
          'llama3:latest',
          'qwen2:latest',
          preferredModels.code
        ];
    }

    // Find the first available model from candidates
    for (const candidate of candidates) {
      if (candidate && this.availableModels.includes(candidate)) {
        return candidate;
      }
    }

    // Fallback to any available model
    return this.availableModels.length > 0 ? this.availableModels[0] : null;
  }

  /**
   * Check if the local backend is available
   * @returns {Promise<boolean>} Whether the local backend is available
   */
  async isAvailable() {
    if (!this.config) {
      this.config = require('./config.json');
    }

    if (!this.config.backends.local.enabled) {
      return false;
    }

    try {
      const response = await axios.get(`${this.config.backends.local.ollamaUrl}/api/tags`, {
        timeout: 5000
      });
      
      return response.status === 200 && response.data.models && response.data.models.length > 0;
    } catch (error) {
      console.error('[LOCAL] Availability check failed:', error.message);
      return false;
    }
  }

  /**
   * Execute a task using local models
   * @param {Object} task - Task object with description, type, files, etc.
   * @returns {Promise<Object>} Execution result
   */
  async executeTask(task) {
    const startTime = Date.now();
    
    if (!this.config) {
      this.config = require('./config.json');
    }

    if (!await this.isAvailable()) {
      throw new Error('Local backend not available - Ollama not running or no models available');
    }

    const model = this.selectModel(task.type);
    if (!model) {
      throw new Error('No suitable local model available for task type: ' + task.type);
    }

    console.log(`[LOCAL] Executing task with model: ${model}`);

    try {
      const prompt = this.buildPrompt(task);
      const result = await this.callOllama(model, prompt);
      
      const duration = Date.now() - startTime;
      
      // Save output if outputPath specified
      if (task.outputPath && result.response) {
        try {
          const fs = require('fs').promises;
          const path = require('path');
          
          await fs.mkdir(path.dirname(task.outputPath), { recursive: true });
          await fs.writeFile(task.outputPath, result.response, 'utf8');
          
          console.log(`[LOCAL] Output saved to ${task.outputPath}`);
        } catch (saveError) {
          console.error('[LOCAL] Error saving output:', saveError.message);
        }
      }

      console.log(`[LOCAL] Task completed in ${(duration / 1000).toFixed(1)}s using ${model}`);

      return {
        success: true,
        backend: 'local',
        model,
        response: result.response,
        duration,
        tokens: this.estimateTokens(prompt + result.response),
        cost: 0, // Local is free
        outputPath: task.outputPath
      };

    } catch (error) {
      const duration = Date.now() - startTime;
      console.error(`[LOCAL] Task failed after ${(duration / 1000).toFixed(1)}s:`, error.message);
      
      throw new Error(`Local execution failed: ${error.message}`);
    }
  }

  /**
   * Build a comprehensive prompt for the local model
   * @param {Object} task - Task object
   * @returns {string} Formatted prompt
   */
  buildPrompt(task) {
    let prompt = '';

    // System context based on task type
    switch (task.type) {
      case 'code':
        prompt += 'You are an expert programmer. Write clean, efficient, well-documented code.\n\n';
        break;
      case 'review':
        prompt += 'You are a senior code reviewer. Provide thorough, constructive feedback.\n\n';
        break;
      case 'docs':
        prompt += 'You are a technical writer. Create clear, comprehensive documentation.\n\n';
        break;
      case 'analysis':
        prompt += 'You are an analyst. Provide detailed, structured analysis with insights.\n\n';
        break;
      default:
        prompt += 'You are a helpful AI assistant. Provide accurate, detailed responses.\n\n';
    }

    // Add task description
    prompt += `Task: ${task.description}\n\n`;

    // Add complexity and urgency context
    if (task.complexity) {
      prompt += `Complexity Level: ${task.complexity}/10\n`;
    }
    
    if (task.urgency && task.urgency !== 'normal') {
      prompt += `Urgency: ${task.urgency}\n`;
    }

    // Add file context if provided
    if (task.files && task.files.length > 0) {
      prompt += `\nRelevant files:\n`;
      for (const file of task.files) {
        prompt += `- ${file}\n`;
      }
      prompt += '\n';
    }

    // Add specific instructions based on task type
    if (task.type === 'code') {
      prompt += 'Requirements:\n';
      prompt += '- Include JSDoc comments for functions\n';
      prompt += '- Add error handling with try-catch blocks\n';
      prompt += '- Follow best practices for the language\n';
      prompt += '- Include basic input validation\n\n';
    } else if (task.type === 'review') {
      prompt += 'Review Guidelines:\n';
      prompt += '- Check for security vulnerabilities\n';
      prompt += '- Assess code quality and maintainability\n';
      prompt += '- Suggest improvements\n';
      prompt += '- Note any missing error handling\n\n';
    }

    // Output format instructions
    if (task.outputPath) {
      const ext = task.outputPath.split('.').pop();
      if (ext === 'md') {
        prompt += 'Format your response in Markdown.\n\n';
      } else if (ext === 'json') {
        prompt += 'Format your response as valid JSON.\n\n';
      } else if (['js', 'py', 'ts', 'go'].includes(ext)) {
        prompt += `Write your response as ${ext} code.\n\n`;
      }
    }

    prompt += 'Please provide your response:';

    return prompt;
  }

  /**
   * Call Ollama API to generate response
   * @param {string} model - Model name
   * @param {string} prompt - Input prompt
   * @returns {Promise<Object>} Ollama response
   */
  async callOllama(model, prompt) {
    const requestData = {
      model,
      prompt,
      stream: false,
      options: {
        temperature: 0.7,
        top_p: 0.9,
        top_k: 40,
        num_ctx: 4096 // Context window
      }
    };

    // Adjust parameters based on task
    if (prompt.includes('code') || prompt.includes('Code')) {
      requestData.options.temperature = 0.3; // More deterministic for code
    }

    const response = await axios.post(
      `${this.config.backends.local.ollamaUrl}/api/generate`,
      requestData,
      {
        timeout: this.config.backends.local.timeoutSeconds * 1000,
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    if (response.status !== 200) {
      throw new Error(`Ollama API returned status ${response.status}`);
    }

    if (!response.data.response) {
      throw new Error('Ollama API returned empty response');
    }

    return response.data;
  }

  /**
   * Estimate token count for a given text
   * @param {string} text - Input text
   * @returns {number} Estimated token count
   */
  estimateTokens(text) {
    if (!text) return 0;
    // Rough estimation: 1 token ≈ 4 characters for English text
    return Math.ceil(text.length / 4);
  }

  /**
   * Get current status of local backend
   * @returns {Promise<Object>} Status object
   */
  async getStatus() {
    const status = {
      enabled: this.config?.backends?.local?.enabled || false,
      available: false,
      models: [],
      ollamaUrl: this.config?.backends?.local?.ollamaUrl,
      lastCheck: this.lastModelCheck,
      error: null
    };

    try {
      status.available = await this.isAvailable();
      if (status.available) {
        status.models = await this.listModels();
      }
    } catch (error) {
      status.error = error.message;
    }

    return status;
  }

  /**
   * Pull a model from Ollama registry
   * @param {string} modelName - Model name to pull
   * @returns {Promise<boolean>} Whether the pull succeeded
   */
  async pullModel(modelName) {
    try {
      console.log(`[LOCAL] Pulling model: ${modelName}`);
      
      const response = await axios.post(
        `${this.config.backends.local.ollamaUrl}/api/pull`,
        { name: modelName },
        { timeout: 600000 } // 10 minute timeout for model downloads
      );

      if (response.status === 200) {
        console.log(`[LOCAL] Successfully pulled model: ${modelName}`);
        await this.checkModelsAvailability(); // Refresh available models
        return true;
      }
      
      return false;
    } catch (error) {
      console.error(`[LOCAL] Error pulling model ${modelName}:`, error.message);
      return false;
    }
  }

  /**
   * Remove a model from local storage
   * @param {string} modelName - Model name to remove
   * @returns {Promise<boolean>} Whether the removal succeeded
   */
  async removeModel(modelName) {
    try {
      console.log(`[LOCAL] Removing model: ${modelName}`);
      
      const response = await axios.delete(
        `${this.config.backends.local.ollamaUrl}/api/delete`,
        {
          data: { name: modelName },
          timeout: 30000
        }
      );

      if (response.status === 200) {
        console.log(`[LOCAL] Successfully removed model: ${modelName}`);
        await this.checkModelsAvailability(); // Refresh available models
        return true;
      }
      
      return false;
    } catch (error) {
      console.error(`[LOCAL] Error removing model ${modelName}:`, error.message);
      return false;
    }
  }

  /**
   * Test model performance with a simple prompt
   * @param {string} modelName - Model to test
   * @returns {Promise<Object>} Test results
   */
  async testModel(modelName) {
    const testPrompt = 'Write a simple "Hello, World!" program in Python.';
    const startTime = Date.now();
    
    try {
      const result = await this.callOllama(modelName, testPrompt);
      const duration = Date.now() - startTime;
      
      return {
        success: true,
        model: modelName,
        duration,
        responseLength: result.response.length,
        tokensEstimate: this.estimateTokens(testPrompt + result.response)
      };
    } catch (error) {
      return {
        success: false,
        model: modelName,
        duration: Date.now() - startTime,
        error: error.message
      };
    }
  }
}

module.exports = new LocalBridge();