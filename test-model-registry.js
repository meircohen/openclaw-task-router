#!/usr/bin/env node

/**
 * Test script for Model Registry functionality
 * Verifies model selection logic and API integration
 */

const modelRegistry = require('./model-registry');

async function testModelSelection() {
  console.log('=== Testing Model Registry ===\n');
  
  // Initialize registry
  await modelRegistry.load();
  
  // Test cases with different complexity and task types
  const testCases = [
    {
      name: 'Simple code task',
      task: { description: 'Write a simple function', type: 'code' },
      complexity: 3,
      contextSize: 5000
    },
    {
      name: 'Complex analysis',
      task: { description: 'Analyze complex financial data with deep reasoning', type: 'analysis' },
      complexity: 9,
      contextSize: 50000
    },
    {
      name: 'Large context task',
      task: { description: 'Process entire codebase', type: 'code' },
      complexity: 6,
      contextSize: 300000
    },
    {
      name: 'Math reasoning',
      task: { description: 'Solve complex mathematical problem', type: 'math' },
      complexity: 7,
      contextSize: 20000
    },
    {
      name: 'Simple classification',
      task: { description: 'Classify this text', type: 'classification' },
      complexity: 2,
      contextSize: 2000
    }
  ];

  for (const testCase of testCases) {
    console.log(`\n--- ${testCase.name} ---`);
    console.log(`Task: ${testCase.task.description}`);
    console.log(`Type: ${testCase.task.type}, Complexity: ${testCase.complexity}, Context: ${testCase.contextSize}`);
    
    try {
      const selection = await modelRegistry.selectModel(testCase.task, testCase.complexity, testCase.contextSize);
      console.log(`✓ Selected: ${selection.model} on ${selection.provider}`);
      console.log(`  Full ID: ${selection.fullModelId}`);
      console.log(`  Cost: $${selection.estimatedCost.toFixed(4)}`);
      console.log(`  Reason: ${selection.reason}`);
    } catch (error) {
      console.log(`✗ Error: ${error.message}`);
    }
  }

  // Test registry access
  console.log('\n=== Registry Info ===');
  const registry = modelRegistry.getRegistry();
  console.log(`Total models: ${Object.keys(registry.models).length}`);
  console.log(`Total providers: ${Object.keys(registry.providers).length}`);
  console.log(`Healthy providers: ${Object.values(registry.providers).filter(p => p.healthy).length}`);
  
  // Test specific model info
  console.log('\n--- Model Details ---');
  const opusInfo = modelRegistry.getModelInfo('opus-4.6');
  if (opusInfo) {
    console.log('Opus 4.6:', JSON.stringify(opusInfo, null, 2));
  }

  console.log('\n=== Test Complete ===');
}

if (require.main === module) {
  testModelSelection()
    .then(() => process.exit(0))
    .catch(error => {
      console.error(error);
      process.exit(1);
    });
}

module.exports = { testModelSelection };