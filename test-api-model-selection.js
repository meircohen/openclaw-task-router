#!/usr/bin/env node

/**
 * Focused test for API model selection in executeWithApiSubagent
 */

// Mock the router's internal parts we need
const modelRegistry = require('./model-registry');
const ledger = require('./ledger');
const planner = require('./planner');

class MockRouter {
  constructor() {
    this.config = {
      backends: {
        api: {
          defaultModel: 'anthropic/claude-sonnet-4-20250514'
        }
      }
    };
  }

  estimateTokens(task) {
    return (task.description || '').length * 4 + 2000;
  }

  _getModelDisplayName(modelId) {
    const displayNames = {
      'opus-4.6': 'Opus 4.6',
      'sonnet-4': 'Sonnet 4',
      'haiku-4.5': 'Haiku 4.5',
      'gpt-4.1': 'GPT-4.1',
      'gpt-4.1-mini': 'GPT-4.1 Mini',
      'grok-3': 'Grok 3',
      'gemini-2.5-pro': 'Gemini 2.5 Pro',
      'deepseek-r1': 'DeepSeek R1',
      'llama-4-maverick': 'Llama 4 Maverick'
    };
    return displayNames[modelId] || modelId;
  }

  async executeWithApiSubagent(task, scoring = null) {
    const startTime = Date.now();

    try {
      // Get task complexity and context size for model selection
      const complexity = scoring?.complexity || planner._inferComplexity(task.description);
      const contextSize = scoring?.estimatedTokens || this.estimateTokens(task);

      // Select optimal model using the registry
      const modelSelection = await modelRegistry.selectModel(task, complexity, contextSize);
      
      console.log(`[ROUTER] Selected ${modelSelection.model} on ${modelSelection.provider} (${modelSelection.reason})`);
      console.log(`[ROUTER] Estimated cost: $${modelSelection.estimatedCost.toFixed(4)}`);

      // Simulate processing time based on model tier
      const processingTime = modelSelection.config.tier === 'fast' ? 100 : 
                             modelSelection.config.tier === 'standard' ? 150 : 200;
      await new Promise(resolve => setTimeout(resolve, processingTime));

      const duration = Date.now() - startTime;
      const actualTokens = contextSize;

      // Create enhanced speakable result
      const providerName = modelSelection.provider.charAt(0).toUpperCase() + modelSelection.provider.slice(1);
      const modelDisplayName = this._getModelDisplayName(modelSelection.model);
      const speakableResult = `Routing to ${modelDisplayName} on ${providerName}, estimated cost $${modelSelection.estimatedCost.toFixed(2)}`;

      return {
        success: true,
        backend: 'api',
        model: modelSelection.fullModelId,
        modelSelection,
        response: `API Sub-agent completed: ${task.description}`,
        speakableResult,
        duration,
        tokens: actualTokens,
        cost: modelSelection.estimatedCost,
        outputPath: task.outputPath
      };
    } catch (error) {
      console.error('[ROUTER] Model selection failed:', error.message);
      
      // Fallback to default model if selection fails
      const duration = Date.now() - startTime;
      const estimatedTokens = this.estimateTokens(task);
      const cost = 0.05; // Mock cost
      
      return {
        success: true,
        backend: 'api',
        model: this.config.backends.api.defaultModel,
        response: `API Sub-agent completed: ${task.description} (fallback model)`,
        speakableResult: `Routing to default model (selection failed)`,
        duration,
        tokens: estimatedTokens,
        cost,
        outputPath: task.outputPath
      };
    }
  }
}

async function testApiModelSelection() {
  console.log('=== Testing API Model Selection ===\n');
  
  await modelRegistry.load();
  await ledger.load();
  
  const router = new MockRouter();
  
  const testCases = [
    {
      name: 'Simple code task',
      task: {
        description: 'Write a simple function to add two numbers',
        type: 'code',
        outputPath: '/tmp/simple.py'
      }
    },
    {
      name: 'Complex analysis',
      task: {
        description: 'Perform deep strategic analysis of market conditions, competitor landscape, and provide detailed recommendations with risk assessment',
        type: 'analysis',
        outputPath: '/tmp/analysis.md'
      }
    },
    {
      name: 'Large context processing',
      task: {
        description: 'Process and analyze an entire large codebase with thousands of files and generate comprehensive documentation',
        type: 'docs',
        outputPath: '/tmp/docs.md'
      }
    },
    {
      name: 'Math problem solving',
      task: {
        description: 'Solve complex calculus problems with detailed step-by-step explanations',
        type: 'math',
        outputPath: '/tmp/math.md'
      }
    }
  ];

  for (const testCase of testCases) {
    console.log(`\n--- ${testCase.name} ---`);
    console.log(`Task: ${testCase.task.description.slice(0, 80)}...`);
    
    try {
      const result = await router.executeWithApiSubagent(testCase.task);
      console.log('✓ Execution result:');
      console.log(`  Model: ${result.model}`);
      console.log(`  Speakable: ${result.speakableResult}`);
      console.log(`  Duration: ${result.duration}ms`);
      console.log(`  Cost: $${result.cost.toFixed(4)}`);
      console.log(`  Success: ${result.success}`);
      
      if (result.modelSelection) {
        console.log(`  Selection Details:`);
        console.log(`    Tier: ${result.modelSelection.config.tier}`);
        console.log(`    Strengths: ${result.modelSelection.config.strengths.join(', ')}`);
      }
    } catch (error) {
      console.log(`✗ Error: ${error.message}`);
    }
  }

  console.log('\n=== API Model Selection Test Complete ===');
}

if (require.main === module) {
  testApiModelSelection()
    .then(() => process.exit(0))
    .catch(error => {
      console.error(error);
      process.exit(1);
    });
}

module.exports = { testApiModelSelection };