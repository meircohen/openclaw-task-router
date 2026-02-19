const fs = require('fs').promises;
const path = require('path');

/**
 * OpenClaw Model Registry - Multi-Provider Model Marketplace
 * Replaces the flat "api" backend with intelligent model selection across providers
 */
class ModelRegistry {
  constructor() {
    const dataDir = process.env.ROUTER_TEST_MODE ? process.env.ROUTER_TEST_DATA_DIR : path.join(__dirname, 'data');
    this.dataPath = path.join(dataDir, 'model-registry-state.json');
    
    // Model definitions with pricing, capabilities, and provider mapping
    this.models = {
      "opus-4.6": {
        providers: ["anthropic", "openrouter"],
        tier: "premium",
        costPer1kIn: 0.015,
        costPer1kOut: 0.075,
        maxContext: 200000,
        strengths: ["complex-analysis", "deep-reasoning", "writing"]
      },
      "sonnet-4": {
        providers: ["anthropic", "openrouter"],
        tier: "standard",
        costPer1kIn: 0.003,
        costPer1kOut: 0.015,
        maxContext: 200000,
        strengths: ["code-gen", "general", "analysis"]
      },
      "haiku-4.5": {
        providers: ["anthropic", "openrouter"],
        tier: "fast",
        costPer1kIn: 0.00025,
        costPer1kOut: 0.00125,
        maxContext: 200000,
        strengths: ["simple-tasks", "classification", "quick-lookups"]
      },
      "gpt-4.1": {
        providers: ["openai"],
        tier: "standard",
        costPer1kIn: 0.002,
        costPer1kOut: 0.008,
        maxContext: 128000,
        strengths: ["code-gen", "instruction-following"]
      },
      "gpt-4.1-mini": {
        providers: ["openai"],
        tier: "fast",
        costPer1kIn: 0.0004,
        costPer1kOut: 0.0016,
        maxContext: 128000,
        strengths: ["simple-tasks", "fast"]
      },
      "grok-3": {
        providers: ["xai"],
        tier: "standard",
        costPer1kIn: 0.003,
        costPer1kOut: 0.015,
        maxContext: 131072,
        strengths: ["reasoning", "analysis"]
      },
      "gemini-2.5-pro": {
        providers: ["openrouter"],
        tier: "premium",
        costPer1kIn: 0.00125,
        costPer1kOut: 0.005,
        maxContext: 1000000,
        strengths: ["large-context", "analysis", "multimodal"]
      },
      "deepseek-r1": {
        providers: ["openrouter"],
        tier: "budget",
        costPer1kIn: 0.00055,
        costPer1kOut: 0.00219,
        maxContext: 128000,
        strengths: ["reasoning", "math", "code-gen"]
      },
      "llama-4-maverick": {
        providers: ["openrouter"],
        tier: "budget",
        costPer1kIn: 0.0002,
        costPer1kOut: 0.0006,
        maxContext: 128000,
        strengths: ["general", "code-gen"]
      }
    };

    // Provider registry with health status and routing preferences
    this.providers = {
      "anthropic": {
        prefix: "anthropic/",
        healthy: true,
        priority: 1
      },
      "openai": {
        prefix: "openai/",
        healthy: true,
        priority: 2
      },
      "openrouter": {
        prefix: "openrouter/",
        healthy: true,
        priority: 3
      },
      "xai": {
        prefix: "xai/",
        healthy: true,
        priority: 4
      }
    };

    // Task type to strength mapping for intelligent selection
    this.taskTypeStrengths = {
      'code': ['code-gen'],
      'analysis': ['complex-analysis', 'analysis', 'deep-reasoning'],
      'reasoning': ['deep-reasoning', 'reasoning'],
      'research': ['analysis', 'complex-analysis'],
      'simple': ['simple-tasks', 'fast', 'quick-lookups'],
      'classification': ['classification', 'simple-tasks'],
      'writing': ['writing', 'general'],
      'general': ['general'],
      'math': ['math', 'reasoning']
    };

    // Shadow bench trust data (will be loaded from persistence)
    this.trustData = {};
    this.loaded = false;
  }

  /**
   * Load registry state from persistent storage
   */
  async load() {
    if (this.loaded) return;

    try {
      const data = await fs.readFile(this.dataPath, 'utf8');
      const state = JSON.parse(data);
      
      // Merge trust data and provider health status
      if (state.trustData) {
        this.trustData = state.trustData;
      }
      if (state.providers) {
        Object.assign(this.providers, state.providers);
      }
      
      console.log('[MODEL-REGISTRY] Loaded state from persistence');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn('[MODEL-REGISTRY] Failed to load state:', error.message);
      }
    }

    this.loaded = true;
  }

  /**
   * Save registry state to persistent storage
   */
  async save() {
    try {
      await fs.mkdir(path.dirname(this.dataPath), { recursive: true });
      const state = {
        providers: this.providers,
        trustData: this.trustData,
        lastUpdated: new Date().toISOString()
      };
      await fs.writeFile(this.dataPath, JSON.stringify(state, null, 2));
    } catch (error) {
      console.error('[MODEL-REGISTRY] Failed to save state:', error.message);
    }
  }

  /**
   * Select the optimal model based on task requirements
   * @param {Object} task - Task object with description, type, etc.
   * @param {number} complexity - Task complexity score (1-10)
   * @param {number} contextSize - Estimated context size in tokens
   * @returns {Object} Selection result with model, provider, cost estimate, and reasoning
   */
  async selectModel(task, complexity, contextSize) {
    if (!this.loaded) await this.load();

    // Step 1: Map complexity to tier
    const tier = this._mapComplexityToTier(complexity);
    console.log(`[MODEL-REGISTRY] Complexity ${complexity} → tier: ${tier}`);

    // Step 2: Handle large context override
    if (contextSize > 200000) {
      console.log(`[MODEL-REGISTRY] Large context (${contextSize}) → forcing gemini-2.5-pro`);
      return this._buildSelection('gemini-2.5-pro', 'openrouter', contextSize, 'large-context override');
    }

    // Step 3: Filter models by tier and task type strengths
    const candidateModels = this._filterModelsByTierAndType(tier, task.type);
    console.log(`[MODEL-REGISTRY] Candidates for ${tier}/${task.type}:`, candidateModels.map(m => m.modelId));

    if (candidateModels.length === 0) {
      // Fallback to standard tier if no matches
      const fallbackModels = this._filterModelsByTierAndType('standard', task.type);
      console.log('[MODEL-REGISTRY] No tier matches, falling back to standard tier');
      return this._selectBestCandidate(fallbackModels, contextSize, 'tier fallback');
    }

    // Step 4: Apply shadow bench trust data if available
    const trustedModels = this._filterByTrust(candidateModels, task.type);
    const finalCandidates = trustedModels.length > 0 ? trustedModels : candidateModels;

    // Step 5: Select cheapest among qualifying models
    return this._selectBestCandidate(finalCandidates, contextSize, 'optimal selection');
  }

  /**
   * Map complexity score to model tier
   * @param {number} complexity - Complexity score (1-10)
   * @returns {string} Model tier
   * @private
   */
  _mapComplexityToTier(complexity) {
    if (complexity >= 8) return 'premium';
    if (complexity >= 4) return 'standard';
    return 'fast'; // complexity 1-3 → fast/budget
  }

  /**
   * Filter models by tier and task type strengths
   * @param {string} tier - Target tier
   * @param {string} taskType - Task type
   * @returns {Array} Array of {modelId, config, provider} objects
   * @private
   */
  _filterModelsByTierAndType(tier, taskType) {
    const candidates = [];
    const targetStrengths = this.taskTypeStrengths[taskType] || ['general'];

    for (const [modelId, config] of Object.entries(this.models)) {
      // Check tier match (allow budget models for fast tier)
      const tierMatch = config.tier === tier || (tier === 'fast' && config.tier === 'budget');
      
      // Check strength match
      const strengthMatch = targetStrengths.some(strength => 
        config.strengths.includes(strength)
      );

      if (tierMatch && strengthMatch) {
        // Add all healthy providers for this model
        for (const providerName of config.providers) {
          if (this.providers[providerName]?.healthy) {
            candidates.push({
              modelId,
              config,
              provider: providerName
            });
          }
        }
      }
    }

    return candidates;
  }

  /**
   * Filter candidates by shadow bench trust data
   * @param {Array} candidates - Candidate models
   * @param {string} taskType - Task type
   * @returns {Array} Trusted models or empty array
   * @private
   */
  _filterByTrust(candidates, taskType) {
    const trusted = [];
    
    for (const candidate of candidates) {
      const trustKey = `${candidate.modelId}:${taskType}`;
      const trust = this.trustData[trustKey];
      
      if (trust && trust.trustLevel === 'trusted' && trust.samples >= 20) {
        trusted.push(candidate);
      }
    }

    return trusted;
  }

  /**
   * Select the best candidate based on cost and provider priority
   * @param {Array} candidates - Candidate models
   * @param {number} contextSize - Context size for cost estimation
   * @param {string} reason - Selection reason
   * @returns {Object} Selection result
   * @private
   */
  _selectBestCandidate(candidates, contextSize, reason) {
    if (candidates.length === 0) {
      throw new Error('No qualifying models available');
    }

    // Calculate costs and sort by total cost, then provider priority
    const scored = candidates.map(candidate => {
      const cost = this._estimateCost(candidate.config, contextSize);
      const providerPriority = this.providers[candidate.provider].priority;
      
      return {
        ...candidate,
        estimatedCost: cost,
        providerPriority
      };
    }).sort((a, b) => {
      // Primary sort: cost (ascending)
      if (Math.abs(a.estimatedCost - b.estimatedCost) > 0.001) {
        return a.estimatedCost - b.estimatedCost;
      }
      // Secondary sort: provider priority (ascending = better)
      return a.providerPriority - b.providerPriority;
    });

    const selected = scored[0];
    return this._buildSelection(selected.modelId, selected.provider, contextSize, reason, selected.estimatedCost);
  }

  /**
   * Build the selection response object
   * @param {string} modelId - Selected model ID
   * @param {string} provider - Selected provider
   * @param {number} contextSize - Context size
   * @param {string} reason - Selection reason
   * @param {number} estimatedCost - Pre-calculated cost (optional)
   * @returns {Object} Selection result
   * @private
   */
  _buildSelection(modelId, provider, contextSize, reason, estimatedCost = null) {
    const config = this.models[modelId];
    const providerConfig = this.providers[provider];
    
    if (!config || !providerConfig) {
      throw new Error(`Invalid model/provider combination: ${modelId}/${provider}`);
    }

    const cost = estimatedCost || this._estimateCost(config, contextSize);
    const fullModelId = this._buildFullModelId(modelId, provider);

    return {
      model: modelId,
      provider,
      fullModelId,
      estimatedCost: cost,
      reason,
      config,
      providerConfig
    };
  }

  /**
   * Estimate cost based on context size and model pricing
   * @param {Object} modelConfig - Model configuration
   * @param {number} contextSize - Context size in tokens
   * @returns {number} Estimated cost in USD
   * @private
   */
  _estimateCost(modelConfig, contextSize) {
    // Assume 70% input, 30% output token distribution
    const inputTokens = contextSize * 0.7;
    const outputTokens = contextSize * 0.3;
    
    const inputCost = (inputTokens / 1000) * modelConfig.costPer1kIn;
    const outputCost = (outputTokens / 1000) * modelConfig.costPer1kOut;
    
    return inputCost + outputCost;
  }

  /**
   * Build the full model identifier for API calls
   * @param {string} modelId - Model ID
   * @param {string} provider - Provider name
   * @returns {string} Full model identifier
   * @private
   */
  _buildFullModelId(modelId, provider) {
    const providerConfig = this.providers[provider];
    
    // Map to actual API model names
    const modelMappings = {
      'opus-4.6': {
        'anthropic': 'claude-opus-4-6',
        'openrouter': 'anthropic/claude-opus-4-6'
      },
      'sonnet-4': {
        'anthropic': 'claude-sonnet-4-20250514',
        'openrouter': 'anthropic/claude-sonnet-4-20250514'
      },
      'haiku-4.5': {
        'anthropic': 'claude-haiku-4-5',
        'openrouter': 'anthropic/claude-haiku-4-5'
      },
      'gpt-4.1': {
        'openai': 'gpt-4-1'
      },
      'gpt-4.1-mini': {
        'openai': 'gpt-4-1-mini'
      },
      'grok-3': {
        'xai': 'grok-3'
      },
      'gemini-2.5-pro': {
        'openrouter': 'google/gemini-2.5-pro'
      },
      'deepseek-r1': {
        'openrouter': 'deepseek/deepseek-r1'
      },
      'llama-4-maverick': {
        'openrouter': 'meta/llama-4-maverick'
      }
    };

    const actualModelName = modelMappings[modelId]?.[provider] || modelId;
    return `${providerConfig.prefix}${actualModelName}`;
  }

  /**
   * Get the complete registry (models + providers)
   * @returns {Object} Full registry data
   */
  getRegistry() {
    return {
      models: this.models,
      providers: this.providers,
      trustData: this.trustData
    };
  }

  /**
   * List all available models as an array
   * @returns {Array} Array of model objects with id and config
   */
  listModels() {
    return Object.entries(this.models).map(([modelId, config]) => ({
      id: modelId,
      ...config
    }));
  }

  /**
   * Get a specific model by ID (alias for getModelInfo for API compatibility)
   * @param {string} modelId - Model identifier
   * @returns {Object|null} Model details or null if not found
   */
  getModel(modelId) {
    return this.getModelInfo(modelId);
  }

  /**
   * Get detailed information about a specific model
   * @param {string} modelId - Model identifier
   * @returns {Object|null} Model details or null if not found
   */
  getModelInfo(modelId) {
    return this.models[modelId] || null;
  }

  /**
   * Add a new model to the registry
   * @param {string} modelId - Model identifier
   * @param {Object} config - Model configuration
   */
  addModel(modelId, config) {
    this.models[modelId] = config;
    console.log(`[MODEL-REGISTRY] Added model: ${modelId}`);
    this.save();
  }

  /**
   * Update provider health status
   * @param {string} provider - Provider name
   * @param {boolean} healthy - Health status
   */
  setProviderHealth(provider, healthy) {
    if (this.providers[provider]) {
      this.providers[provider].healthy = healthy;
      console.log(`[MODEL-REGISTRY] Provider ${provider} health: ${healthy}`);
      this.save();
    }
  }

  /**
   * Record shadow bench trust data
   * @param {string} modelId - Model ID
   * @param {string} taskType - Task type
   * @param {Object} trustData - Trust metrics
   */
  updateTrustData(modelId, taskType, trustData) {
    const trustKey = `${modelId}:${taskType}`;
    this.trustData[trustKey] = trustData;
    this.save();
  }

  /**
   * Get models suitable for a given context size
   * @param {number} contextSize - Required context size
   * @returns {Array} Models that can handle the context size
   */
  getModelsForContextSize(contextSize) {
    return Object.entries(this.models)
      .filter(([_, config]) => config.maxContext >= contextSize)
      .map(([modelId, config]) => ({ modelId, config }));
  }
}

module.exports = new ModelRegistry();