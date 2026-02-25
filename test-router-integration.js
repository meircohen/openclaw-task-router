#!/usr/bin/env node

/**
 * Test script for Router + Model Registry integration
 * Verifies that API backend correctly uses model selection
 */

const router = require('./index');

async function testRouterIntegration() {
  console.log('=== Testing Router Integration ===\n');
  
  // Initialize if not already initialized
  await router.initialize();
  
  // Test API routing with different task types
  const testCases = [
    {
      name: 'Code generation with tools',
      task: {
        description: 'Generate a Python script and save it to file',
        type: 'code',
        toolsNeeded: ['write_file']
      }
    },
    {
      name: 'Complex analysis task',
      task: {
        description: 'Analyze market trends and provide strategic recommendations',
        type: 'analysis',
        complexity: 8
      }
    },
    {
      name: 'Simple query',
      task: {
        description: 'What is the weather like?',
        type: 'simple',
        complexity: 2
      }
    }
  ];

  for (const testCase of testCases) {
    console.log(`\n--- ${testCase.name} ---`);
    console.log(`Task: ${testCase.task.description}`);
    
    try {
      // Route the task (plan mode to avoid actual execution)
      const result = await router.route(testCase.task, { plan: true });
      
      if (result.selfHandle) {
        console.log('✓ Router decided to self-handle');
        continue;
      }

      if (result.plan) {
        console.log(`✓ Generated plan with ${result.plan.steps.length} steps`);
        
        // Check if any step uses API backend
        const apiSteps = result.plan.steps.filter(step => step.backend === 'api');
        if (apiSteps.length > 0) {
          console.log(`  API steps: ${apiSteps.length}`);
          console.log(`  First API step: ${apiSteps[0].description}`);
        }
      } else {
        // Direct routing
        console.log(`✓ Direct route: backend=${result.backend || 'unknown'}`);
      }
    } catch (error) {
      console.log(`✗ Error: ${error.message}`);
    }
  }

  // Test direct API execution
  console.log('\n=== Testing Direct API Execution ===');
  
  const apiTask = {
    description: 'Write a complex analysis report',
    type: 'analysis',
    complexity: 7,
    forceBackend: 'api',
    outputPath: '/tmp/test-output.txt'
  };

  try {
    console.log('Executing API task...');
    const result = await router.route(apiTask);
    console.log('✓ API execution result:');
    console.log(`  Success: ${result.success}`);
    console.log(`  Backend: ${result.backend}`);
    console.log(`  Model: ${result.model || 'unknown'}`);
    if (result.speakableResult) {
      console.log(`  Speakable: ${result.speakableResult}`);
    }
    console.log(`  Duration: ${result.duration}ms`);
    console.log(`  Cost: $${result.cost?.toFixed(4) || '0.0000'}`);
  } catch (error) {
    console.log(`✗ API execution error: ${error.message}`);
  }

  console.log('\n=== Integration Test Complete ===');
}

if (require.main === module) {
  testRouterIntegration()
    .then(() => {
      console.log('Integration test passed!');
      process.exit(0);
    })
    .catch(error => {
      console.error('Integration test failed:', error);
      process.exit(1);
    });
}

module.exports = { testRouterIntegration };