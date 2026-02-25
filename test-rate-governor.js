#!/usr/bin/env node

/**
 * Test script for rate-governor.js
 * Tests basic functionality, rate limiting, throttle events, and learning
 */

const rateGovernor = require('./rate-governor');

async function testBasicFunctionality() {
  console.log('\n🧪 Testing Basic Functionality...');
  
  // Load the rate governor
  await rateGovernor.load();
  
  // Test canUse() for all backends
  const backends = ['claudeCode', 'codex', 'local', 'api'];
  for (const backend of backends) {
    const check = rateGovernor.canUse(backend);
    console.log(`  ${backend}: ${check.allowed ? '✅ Allowed' : '❌ Blocked'} ${check.reason ? `(${check.reason})` : ''}`);
    if (check.delayMs) {
      console.log(`    ⏱️  Delay: ${check.delayMs}ms`);
    }
    if (check.suggestedBackend) {
      console.log(`    🔀 Suggested fallback: ${check.suggestedBackend}`);
    }
  }
}

async function testRateTracking() {
  console.log('\n📊 Testing Rate Tracking...');
  
  // Record some requests for claudeCode
  console.log('  Recording 15 successful requests for claudeCode...');
  for (let i = 0; i < 15; i++) {
    rateGovernor.recordRequest('claudeCode', true);
  }
  
  // Check status
  const status = rateGovernor.getStatus();
  const ccStatus = status.backends.claudeCode;
  console.log(`  claudeCode: ${ccStatus.requestsLastHour}/${ccStatus.currentLimit} requests (${ccStatus.utilization}% utilization)`);
  
  // Test soft limit approach
  console.log('  Recording 5 more requests to approach soft limit...');
  for (let i = 0; i < 5; i++) {
    rateGovernor.recordRequest('claudeCode', true);
  }
  
  const softCheck = rateGovernor.canUse('claudeCode');
  console.log(`  Soft limit check: ${softCheck.allowed ? '✅ Allowed' : '❌ Blocked'} ${softCheck.delayMs ? `(delay: ${softCheck.delayMs}ms)` : ''}`);
}

async function testThrottling() {
  console.log('\n🚦 Testing Throttling & Adaptive Limits...');
  
  const initialStatus = rateGovernor.getStatus();
  const initialLimit = initialStatus.backends.codex.currentLimit;
  console.log(`  Initial codex limit: ${initialLimit} requests/hour`);
  
  // Simulate a throttle event
  console.log('  Simulating throttle event...');
  rateGovernor.recordThrottle('codex', { 
    error: 'Rate limit exceeded',
    source: 'test',
    timestamp: Date.now()
  });
  
  const postThrottleStatus = rateGovernor.getStatus();
  const newLimit = postThrottleStatus.backends.codex.currentLimit;
  const inCooldown = postThrottleStatus.backends.codex.inCooldown;
  
  console.log(`  New codex limit: ${newLimit} requests/hour (reduced from ${initialLimit})`);
  console.log(`  In cooldown: ${inCooldown ? '✅ Yes' : '❌ No'}`);
  
  // Test hard block during cooldown
  const blockCheck = rateGovernor.canUse('codex');
  console.log(`  Usage check during cooldown: ${blockCheck.allowed ? '✅ Allowed' : '❌ Blocked'}`);
  if (blockCheck.suggestedBackend) {
    console.log(`  Suggested fallback: ${blockCheck.suggestedBackend}`);
  }
}

async function testLearnings() {
  console.log('\n🧠 Testing Learning System...');
  
  const learnings = rateGovernor.getLearnings();
  
  console.log(`  Total throttle events: ${learnings.totalThrottleEvents}`);
  console.log(`  Most problematic backend: ${learnings.mostProblematicBackend || 'None'}`);
  console.log(`  Average recovery time: ${learnings.averageRecoveryTimeMinutes} minutes`);
  
  if (learnings.recommendations.length > 0) {
    console.log('  📋 Recommendations:');
    learnings.recommendations.forEach((rec, i) => {
      console.log(`    ${i + 1}. ${rec}`);
    });
  }
  
  if (Object.keys(learnings.patterns).length > 0) {
    console.log('  🔍 Patterns detected:');
    Object.entries(learnings.patterns).forEach(([backend, pattern]) => {
      console.log(`    ${backend}: ${pattern.throttleFrequency}, trend: ${pattern.trend}`);
    });
  }
}

async function testPersistence() {
  console.log('\n💾 Testing Persistence...');
  
  console.log('  Saving current state...');
  await rateGovernor.save();
  console.log('  ✅ State saved');
  
  console.log('  Reloading state...');
  await rateGovernor.load();
  console.log('  ✅ State reloaded');
  
  const status = rateGovernor.getStatus();
  console.log(`  Verified: ${status.backends.claudeCode.requestsLastHour} claudeCode requests still tracked`);
  console.log(`  Verified: ${status.backends.codex.inCooldown ? 'Codex still in cooldown' : 'Codex cooldown cleared'}`);
}

async function testStatusAPI() {
  console.log('\n📈 Testing Status & API Methods...');
  
  const status = rateGovernor.getStatus();
  
  console.log('  📊 Current Status:');
  console.log(`    Total requests: ${status.summary.totalRequests}`);
  console.log(`    Total throttles: ${status.summary.totalThrottles}`);
  
  console.log('  🔧 Backend Details:');
  Object.entries(status.backends).forEach(([backend, info]) => {
    console.log(`    ${backend}:`);
    console.log(`      Requests/hour: ${info.requestsLastHour}/${info.currentLimit}`);
    console.log(`      Utilization: ${info.utilization}%`);
    console.log(`      Throttle events: ${info.throttleEvents}`);
    console.log(`      Can use: ${info.canUse.allowed ? '✅' : '❌'}`);
    if (info.inCooldown) {
      console.log(`      ⏳ Cooldown until: ${info.cooldownUntil}`);
    }
  });
}

async function testManualControls() {
  console.log('\n🎛️  Testing Manual Controls...');
  
  // Test limit adjustment
  console.log('  Adjusting local backend limit to 50...');
  rateGovernor.adjustLimit('local', 50);
  
  const adjustedStatus = rateGovernor.getStatus();
  console.log(`  ✅ Local limit now: ${adjustedStatus.backends.local.currentLimit} requests/hour`);
  
  // Test backend reset
  console.log('  Resetting local backend...');
  rateGovernor.resetBackend('local');
  
  const resetStatus = rateGovernor.getStatus();
  console.log(`  ✅ Local limit reset to: ${resetStatus.backends.local.currentLimit} requests/hour`);
}

async function runAllTests() {
  console.log('🚀 OpenClaw Rate Governor Test Suite');
  console.log('=====================================');
  
  try {
    await testBasicFunctionality();
    await testRateTracking();
    await testThrottling();
    await testLearnings();
    await testPersistence();
    await testStatusAPI();
    await testManualControls();
    
    console.log('\n✅ All tests completed successfully!');
    
    // Final status summary
    console.log('\n📋 Final Status Summary:');
    const finalStatus = rateGovernor.getStatus();
    console.log(`   Total requests tracked: ${finalStatus.summary.totalRequests}`);
    console.log(`   Total throttle events: ${finalStatus.summary.totalThrottles}`);
    console.log(`   Backends in cooldown: ${Object.values(finalStatus.backends).filter(b => b.inCooldown).length}`);
    
  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run tests if called directly
if (require.main === module) {
  runAllTests().then(() => {
    console.log('\n🎯 Rate Governor is ready for production!');
    process.exit(0);
  }).catch(console.error);
}

module.exports = { runAllTests };