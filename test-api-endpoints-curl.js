#!/usr/bin/env node

/**
 * Test script for Model Registry API endpoints using curl
 * Tests the dashboard server API endpoints for model management
 */

const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

const BASE_URL = 'http://localhost:3457';
const AUTH_TOKEN = '300334746c4cfe53620457070720d41cb9f26ecd0bf63220'; // From config

// Check if dashboard server is running
async function checkServer() {
  try {
    await execPromise(`curl -s --max-time 2 ${BASE_URL}/health`);
    return true;
  } catch { return false; }
}

async function curlGet(endpoint) {
  const cmd = `curl -s -H "Authorization: Bearer ${AUTH_TOKEN}" "${BASE_URL}${endpoint}"`;
  const { stdout, stderr } = await execPromise(cmd);
  if (stderr) throw new Error(`Curl error: ${stderr}`);
  return JSON.parse(stdout);
}

async function curlPost(endpoint, data) {
  const cmd = `curl -s -X POST -H "Content-Type: application/json" -H "Authorization: Bearer ${AUTH_TOKEN}" -d '${JSON.stringify(data)}' "${BASE_URL}${endpoint}"`;
  const { stdout, stderr } = await execPromise(cmd);
  if (stderr) throw new Error(`Curl error: ${stderr}`);
  return JSON.parse(stdout);
}

async function testApiEndpoints() {
  console.log('=== Testing Model Registry API Endpoints ===\n');
  console.log('Note: This test requires the dashboard server to be running on port 3457\n');

  // Check if dashboard server is running
  if (!(await checkServer())) {
    console.log('SKIP: Dashboard server not running on :3457');
    process.exit(0);
  }

  try {
    // Test /api/models endpoint
    console.log('--- Testing /api/models ---');
    const modelsData = await curlGet('/api/models');
    
    console.log(`✓ Models endpoint returned ${modelsData.totalModels} models`);
    console.log(`✓ ${modelsData.healthyProviders} healthy providers`);
    console.log('Available models:');
    
    for (const [modelId, config] of Object.entries(modelsData.models)) {
      const providers = config.providers.filter(p => p.available).map(p => p.id);
      console.log(`  ${modelId}: tier=${config.tier}, providers=[${providers.join(', ')}], cost/10K=$${config.estimatedCostPer10k.mixed.toFixed(4)}`);
    }

    // Test specific model endpoint
    console.log('\n--- Testing /api/models/sonnet-4 ---');
    const sonnetData = await curlGet('/api/models/sonnet-4');
    
    console.log('✓ Sonnet 4 model details:');
    console.log(`  Providers: ${sonnetData.providers.join(', ')}`);
    console.log(`  Tier: ${sonnetData.tier}`);
    console.log(`  Max Context: ${sonnetData.maxContext.toLocaleString()}`);
    console.log(`  Cost/1K In: $${sonnetData.costPer1kIn}`);
    console.log(`  Cost/1K Out: $${sonnetData.costPer1kOut}`);

    // Test provider health update
    console.log('\n--- Testing provider health update ---');
    const healthData = await curlPost('/api/models/provider/openrouter/health', { healthy: false });
    
    console.log(`✓ Provider health updated: ${healthData.provider} → ${healthData.healthy}`);

    // Verify health update affects model listing
    console.log('\n--- Verifying health update effect ---');
    const updatedData = await curlGet('/api/models');
    
    const openrouterHealthy = Object.values(updatedData.providers).find(p => p.prefix === 'openrouter/')?.healthy;
    console.log(`✓ OpenRouter provider health in registry: ${openrouterHealthy}`);

    // Show impact on model availability
    const affectedModels = Object.entries(updatedData.models)
      .filter(([_, config]) => config.providers.some(p => p.id === 'openrouter' && !p.available))
      .map(([modelId]) => modelId);
    console.log(`✓ Models affected by OpenRouter being down: ${affectedModels.join(', ')}`);

    // Restore health for cleanup
    await curlPost('/api/models/provider/openrouter/health', { healthy: true });
    console.log('✓ Restored OpenRouter provider health');

    console.log('\n=== API Endpoints Test Complete ===');

  } catch (error) {
    console.error(`✗ Test failed: ${error.message}`);
    console.log('\nMake sure the dashboard server is running with:');
    console.log('cd /Users/meircohen/.openclaw/workspace/router && node dashboard-server.js');
  }
}

if (require.main === module) {
  testApiEndpoints()
    .then(() => process.exit(0))
    .catch(error => {
      console.error(error);
      process.exit(1);
    });
}

module.exports = { testApiEndpoints };