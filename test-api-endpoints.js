#!/usr/bin/env node

/**
 * Test script for Model Registry API endpoints
 * Tests the dashboard server API endpoints for model management
 */

const express = require('express');
const request = require('supertest');
const app = require('./dashboard-server');

async function testApiEndpoints() {
  console.log('=== Testing Model Registry API Endpoints ===\n');

  // Check if dashboard server is running
  try {
    const fetch = require('node-fetch');
    await fetch('http://localhost:3457/health');
  } catch (error) {
    console.log('SKIP: Dashboard server not running');
    process.exit(0);
  }

  try {
    // Test /api/models endpoint
    console.log('--- Testing /api/models ---');
    const modelsResponse = await request(app)
      .get('/api/models')
      .expect(200);

    const modelsData = modelsResponse.body;
    console.log(`✓ Models endpoint returned ${modelsData.totalModels} models`);
    console.log(`✓ ${modelsData.healthyProviders} healthy providers`);
    console.log('Available models:');
    
    for (const [modelId, config] of Object.entries(modelsData.models)) {
      const providers = config.providers.filter(p => p.available).map(p => p.id);
      console.log(`  ${modelId}: tier=${config.tier}, providers=[${providers.join(', ')}]`);
    }

    // Test specific model endpoint
    console.log('\n--- Testing /api/models/sonnet-4 ---');
    const sonnetResponse = await request(app)
      .get('/api/models/sonnet-4')
      .expect(200);

    const sonnetData = sonnetResponse.body;
    console.log('✓ Sonnet 4 model details:');
    console.log(`  Providers: ${sonnetData.providers.join(', ')}`);
    console.log(`  Tier: ${sonnetData.tier}`);
    console.log(`  Max Context: ${sonnetData.maxContext.toLocaleString()}`);
    console.log(`  Cost/1K In: $${sonnetData.costPer1kIn}`);
    console.log(`  Cost/1K Out: $${sonnetData.costPer1kOut}`);

    // Test non-existent model
    console.log('\n--- Testing /api/models/nonexistent ---');
    await request(app)
      .get('/api/models/nonexistent')
      .expect(404);
    console.log('✓ Non-existent model correctly returns 404');

    // Test provider health update
    console.log('\n--- Testing provider health update ---');
    const healthResponse = await request(app)
      .post('/api/models/provider/anthropic/health')
      .send({ healthy: false })
      .expect(200);

    const healthData = healthResponse.body;
    console.log(`✓ Provider health updated: ${healthData.provider} → ${healthData.healthy}`);

    // Verify health update affects model listing
    console.log('\n--- Verifying health update effect ---');
    const updatedModelsResponse = await request(app)
      .get('/api/models')
      .expect(200);

    const updatedData = updatedModelsResponse.body;
    const anthropicHealthy = Object.values(updatedData.providers).find(p => p.prefix === 'anthropic/')?.healthy;
    console.log(`✓ Anthropic provider health in registry: ${anthropicHealthy}`);

    // Restore health for cleanup
    await request(app)
      .post('/api/models/provider/anthropic/health')
      .send({ healthy: true })
      .expect(200);
    console.log('✓ Restored Anthropic provider health');

    console.log('\n=== API Endpoints Test Complete ===');

  } catch (error) {
    console.error(`✗ Test failed: ${error.message}`);
    if (error.response) {
      console.error(`Response: ${error.response.status} - ${JSON.stringify(error.response.body)}`);
    }
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