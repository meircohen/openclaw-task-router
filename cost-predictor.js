/**
 * OpenClaw Task Router - Cost Predictor
 * Fast cost estimation without full planner decomposition
 * Uses heuristics and historical data to predict task costs
 */

const fs = require('fs');
const path = require('path');

class CostPredictor {
  constructor() {
    this.config = null;
    this.historicalData = [];
    this.loaded = false;
    
    // Cost multipliers for different task types
    this.keywordMultipliers = {
      'analyze': 2.0,
      'analysis': 2.0,
      'build': 3.0,
      'create': 2.5,
      'develop': 3.0,
      'ocr': 5.0,
      'transcribe': 4.0,
      'translate': 2.0,
      'summarize': 1.5,
      'simple': 0.5,
      'quick': 0.5,
      'basic': 0.7,
      'complex': 2.5,
      'detailed': 2.0,
      'comprehensive': 3.0,
      'review': 1.2,
      'check': 0.8,
      'fix': 1.8,
      'debug': 2.2,
      'test': 1.5,
      'deploy': 2.0,
      'refactor': 2.5,
      'optimize': 2.8,
      'migrate': 3.5,
      'integrate': 3.0
    };

    // Base token estimates by word count ranges
    this.baseTokenEstimates = [
      { maxWords: 5, baseTokens: 150 },
      { maxWords: 10, baseTokens: 300 },
      { maxWords: 20, baseTokens: 600 },
      { maxWords: 50, baseTokens: 1200 },
      { maxWords: 100, baseTokens: 2000 },
      { maxWords: Infinity, baseTokens: 3000 }
    ];

    // Model pricing (USD per 1K tokens)
    this.modelPricing = {
      api: {
        input: 0.003,  // Claude Sonnet 4
        output: 0.015
      },
      subscription: {
        claudeCode: 20 / 30 / 1000, // $20/month ÷ 30 days ÷ 1000 tokens/day estimate
        codex: 10 / 30 / 1000       // $10/month ÷ 30 days ÷ 1000 tokens/day estimate
      }
    };
  }

  async load() {
    if (this.loaded) return;

    try {
      // Load config
      const configPath = path.join(__dirname, 'config.json');
      this.config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

      // Load historical data from monitor.json if it exists
      await this.loadHistoricalData();

      this.loaded = true;
      console.log('[COST-PREDICTOR] Loaded with', this.historicalData.length, 'historical tasks');
    } catch (error) {
      console.warn('[COST-PREDICTOR] Failed to load:', error.message);
      this.loaded = true; // Continue with defaults
    }
  }

  async loadHistoricalData() {
    try {
      const monitorPath = path.join(__dirname, 'data/monitor.json');
      if (!fs.existsSync(monitorPath)) return;

      const monitorData = JSON.parse(fs.readFileSync(monitorPath, 'utf8'));
      this.historicalData = [];

      // Extract task data from all backends
      for (const [backend, stats] of Object.entries(monitorData.backends || {})) {
        for (const result of stats.results || []) {
          if (result.task && result.tokens) {
            this.historicalData.push({
              description: result.task.description || '',
              tokens: result.tokens,
              success: result.success,
              backend,
              timestamp: result.timestamp,
              duration: result.duration,
              taskType: result.taskType
            });
          }
        }
      }

      // Sort by timestamp (most recent first)
      this.historicalData.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    } catch (error) {
      console.warn('[COST-PREDICTOR] Failed to load historical data:', error.message);
    }
  }

  /**
   * Find similar historical tasks based on description similarity
   * @param {string} description - Task description
   * @returns {Array} Similar tasks with similarity scores
   */
  findSimilarTasks(description) {
    if (!description || this.historicalData.length === 0) return [];

    const descWords = description.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const similar = [];

    for (const task of this.historicalData.slice(0, 100)) { // Check last 100 tasks
      const taskWords = task.description.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      
      // Calculate Jaccard similarity (intersection / union)
      const intersection = descWords.filter(w => taskWords.includes(w)).length;
      const union = new Set([...descWords, ...taskWords]).size;
      const similarity = union > 0 ? intersection / union : 0;

      if (similarity > 0.2) { // At least 20% similar
        similar.push({ ...task, similarity });
      }
    }

    return similar.sort((a, b) => b.similarity - a.similarity).slice(0, 5);
  }

  /**
   * Estimate tokens based on word count and keywords
   * @param {string} description - Task description
   * @returns {Object} Token estimation breakdown
   */
  estimateByHeuristics(description) {
    const words = description.split(/\s+/).filter(w => w.length > 0);
    const wordCount = words.length;
    const lowerDesc = description.toLowerCase();

    // Get base token estimate
    let baseTokens = 3000; // default for very long descriptions
    for (const range of this.baseTokenEstimates) {
      if (wordCount <= range.maxWords) {
        baseTokens = range.baseTokens;
        break;
      }
    }

    // Apply keyword multipliers
    let multiplier = 1.0;
    const matchedKeywords = [];
    
    for (const [keyword, mult] of Object.entries(this.keywordMultipliers)) {
      if (lowerDesc.includes(keyword)) {
        multiplier *= mult;
        matchedKeywords.push({ keyword, multiplier: mult });
      }
    }

    // Detect numbers (could indicate data processing scale)
    const numbers = description.match(/\d+/g) || [];
    if (numbers.length > 0) {
      const maxNumber = Math.max(...numbers.map(n => parseInt(n)));
      if (maxNumber > 100) {
        multiplier *= 1.5; // Large numbers suggest more complex processing
        matchedKeywords.push({ keyword: 'large-numbers', multiplier: 1.5 });
      }
    }

    // Cap multiplier to reasonable bounds
    multiplier = Math.min(multiplier, 10.0);
    multiplier = Math.max(multiplier, 0.1);

    const estimatedTokens = Math.round(baseTokens * multiplier);

    return {
      baseTokens,
      wordCount,
      multiplier,
      estimatedTokens,
      matchedKeywords
    };
  }

  /**
   * Predict cost for a task description
   * @param {string} description - Task description
   * @returns {Object} Cost prediction with breakdown
   */
  async predict(description) {
    if (!this.loaded) await this.load();

    if (!description || typeof description !== 'string') {
      throw new Error('Description must be a non-empty string');
    }

    // Get heuristic estimate
    const heuristics = this.estimateByHeuristics(description);
    
    // Find similar historical tasks
    const similarTasks = this.findSimilarTasks(description);
    
    let finalEstimate = heuristics.estimatedTokens;
    let confidence = 0.3; // Base confidence for heuristics only
    let method = 'heuristics';

    // If we have similar tasks, use them to refine the estimate
    if (similarTasks.length > 0) {
      const similarAvg = similarTasks.reduce((sum, task) => sum + task.tokens, 0) / similarTasks.length;
      const bestMatch = similarTasks[0];
      
      if (bestMatch.similarity > 0.6) {
        // High similarity - weight historical data heavily
        finalEstimate = Math.round((similarAvg * 0.7) + (heuristics.estimatedTokens * 0.3));
        confidence = Math.min(0.8, 0.4 + (bestMatch.similarity * 0.4));
        method = 'historical-weighted';
      } else {
        // Medium similarity - blend estimates
        finalEstimate = Math.round((similarAvg * 0.4) + (heuristics.estimatedTokens * 0.6));
        confidence = Math.min(0.6, 0.3 + (bestMatch.similarity * 0.3));
        method = 'historical-blend';
      }
    }

    // Calculate costs for different backends
    const apiCost = (finalEstimate / 1000) * (this.modelPricing.api.input + this.modelPricing.api.output);
    const subscriptionCost = (finalEstimate / 1000) * this.modelPricing.subscription.claudeCode;

    const breakdown = {
      method,
      heuristics,
      similarTasks: similarTasks.map(t => ({
        description: t.description.substring(0, 100) + '...',
        tokens: t.tokens,
        similarity: Math.round(t.similarity * 100) / 100,
        backend: t.backend
      })),
      finalCalculation: {
        baseEstimate: heuristics.estimatedTokens,
        historicalInfluence: similarTasks.length > 0 ? 
          Math.round(((finalEstimate - heuristics.estimatedTokens) / heuristics.estimatedTokens) * 100) : 0,
        finalEstimate
      }
    };

    return {
      estimatedTokens: finalEstimate,
      estimatedCostApi: Math.round(apiCost * 10000) / 10000, // 4 decimal places
      estimatedCostSubscription: Math.round(subscriptionCost * 10000) / 10000,
      confidence: Math.round(confidence * 100) / 100, // As percentage
      breakdown
    };
  }

  /**
   * Record actual usage for learning
   * @param {string} description - Task description
   * @param {number} actualTokens - Actual token usage
   * @param {string} backend - Backend used
   * @param {boolean} success - Whether task succeeded
   */
  recordActual(description, actualTokens, backend, success = true) {
    // In a real implementation, this would update the historical data
    // For now, we'll just log it
    console.log('[COST-PREDICTOR] Recording actual usage:', {
      description: description.substring(0, 50) + '...',
      actualTokens,
      backend,
      success
    });
  }

  /**
   * Get prediction accuracy stats
   * @returns {Object} Accuracy statistics
   */
  getAccuracyStats() {
    // This would analyze prediction vs actual data
    // For now, return placeholder stats
    return {
      totalPredictions: 0,
      accuracyWithin25Percent: 0,
      averageError: 0,
      lastUpdated: new Date().toISOString()
    };
  }
}

module.exports = new CostPredictor();