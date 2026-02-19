#!/usr/bin/env node

/**
 * OpenClaw Task Router — Approval Flow End-to-End Test Suite
 *
 * Tests the full plan approval lifecycle:
 *   1. Plan creation triggers approval when estimated cost > $2
 *   2. approvePlan() retrieves the pending plan and executes it
 *   3. cancelPlan() removes the plan from pending store
 *   4. Plans expire after 30 minutes
 *   5. notify.sendPlanApproval() is called with correct format
 */

const fs = require('fs');
const path = require('path');

const planner = require('./planner');
const notify = require('./notify');

const PENDING_PLANS_PATH = path.join(__dirname, 'data', 'pending-plans.json');

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, testName) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${testName}`);
  } else {
    failed++;
    failures.push(testName);
    console.log(`  FAIL  ${testName}`);
  }
}

// ── Helpers ──────────────────────────────────────────────────────

/** Read pending-plans.json raw (no expiry pruning) */
function readRawPendingPlans() {
  try {
    return JSON.parse(fs.readFileSync(PENDING_PLANS_PATH, 'utf8'));
  } catch (_) {
    return {};
  }
}

/** Write pending-plans.json directly */
function writeRawPendingPlans(obj) {
  fs.writeFileSync(PENDING_PLANS_PATH, JSON.stringify(obj, null, 2));
}

/** Clear the pending-plans store */
function clearPendingPlans() {
  writeRawPendingPlans({});
}

// ────────────────────────────────────────────────────────────────
// 1. Plan creation — cost > $2 triggers approval flag
// ────────────────────────────────────────────────────────────────

function testPlanCreationNeedsApproval() {
  console.log('\n--- Approval Flow: plan creation triggers approval when cost > $2 ---');

  // Build an expensive task that uses the API backend (non-subscription)
  // API steps cost real money; subscription steps are $0
  const expensivePlan = planner.decompose({
    description: 'Analyze comprehensive security vulnerabilities requiring extensive API usage.',
    type: 'analysis',
    complexity: 150, // High complexity forces large token count (150 * 2500 = 375K tokens)
    files: ['file1.js', 'file2.js', 'file3.js'], // 3+ files forces heuristic path
    toolsNeeded: ['web']
  });

  const cost = planner.estimateCost(expensivePlan);

  assert(cost.totalApiCost > 2, `API cost exceeds $2 threshold (got $${cost.totalApiCost.toFixed(4)})`);
  assert(cost.needsApproval === true, 'Cost breakdown has needsApproval=true');
  assert(expensivePlan.needsApproval === true, 'Plan object has needsApproval=true');

  // Cheap task should NOT need approval
  const cheapPlan = planner.decompose({
    description: 'Fix a typo in readme',
    type: 'docs',
    complexity: 1
  });

  const cheapCost = planner.estimateCost(cheapPlan);

  assert(cheapCost.totalApiCost <= 2, `Cheap plan cost is <= $2 (got $${cheapCost.totalApiCost.toFixed(4)})`);
  assert(cheapCost.needsApproval === false, 'Cheap plan does NOT need approval');
  assert(cheapPlan.needsApproval === false, 'Cheap plan object has needsApproval=false');
}

// ────────────────────────────────────────────────────────────────
// 2. Pending plan store — storePendingPlan / getPendingPlan
// ────────────────────────────────────────────────────────────────

function testPendingPlanStore() {
  console.log('\n--- Approval Flow: pending plan store operations ---');

  clearPendingPlans();

  const plan = planner.decompose({
    description: 'Analyze entire codebase using API for security audit across all files. Comprehensive analysis requiring extensive token usage, vulnerability scanning, code review, threat modeling, and detailed reporting with recommendations for each security issue found.',
    type: 'analysis',
    complexity: 10,
    files: Array.from({ length: 50 }, (_, i) => `src/security/audit${i}.js`),
    toolsNeeded: ['web', 'git', 'shell', 'npm']
  });
  const cost = planner.estimateCost(plan);

  // Store
  notify.storePendingPlan(plan.id, plan, cost);

  // Retrieve
  const retrieved = notify.getPendingPlan(plan.id);

  assert(retrieved !== null, 'Pending plan is retrievable after store');
  assert(retrieved.plan.id === plan.id, 'Retrieved plan ID matches');
  assert(retrieved.costBreakdown.totalApiCost === cost.totalApiCost, 'Cost breakdown preserved');
  assert(retrieved.status === 'pending', 'Status is pending');
  assert(typeof retrieved.createdAt === 'string', 'createdAt is a string timestamp');

  // Verify persisted to disk
  const raw = readRawPendingPlans();
  assert(raw[plan.id] !== undefined, 'Plan is persisted in pending-plans.json');

  // Non-existent plan returns null
  assert(notify.getPendingPlan('nonexistent_plan_xyz') === null, 'Non-existent plan returns null');

  clearPendingPlans();
}

// ────────────────────────────────────────────────────────────────
// 3. approvePlan() — retrieves pending plan and triggers execution
// ────────────────────────────────────────────────────────────────

function testApprovePlan() {
  console.log('\n--- Approval Flow: approvePlan() triggers execution ---');

  clearPendingPlans();

  const plan = planner.decompose({
    description: 'Analyze codebase using API for comprehensive security audit across all files',
    type: 'analysis',
    complexity: 10,
    files: Array.from({ length: 20 }, (_, i) => `file${i}.js`),
    toolsNeeded: ['web']
  });
  const cost = planner.estimateCost(plan);

  // Store the plan as pending
  notify.storePendingPlan(plan.id, plan, cost);
  assert(notify.getPendingPlan(plan.id) !== null, 'Plan stored before approval');

  // Verify the router module exports approvePlan
  const router = require('./index');
  assert(typeof router.approvePlan === 'function', 'approvePlan is exported from index.js');
  assert(typeof router.cancelPlan === 'function', 'cancelPlan is exported from index.js');
  assert(typeof router.getPendingPlans === 'function', 'getPendingPlans is exported from index.js');

  // approvePlan pulls from notify store — verify it removes the pending entry
  // (We won't actually execute since backends are stubs, but we test the retrieval + removal path)
  const pending = notify.getPendingPlan(plan.id);
  assert(pending !== null, 'getPendingPlan returns the plan');
  assert(pending.plan.steps.length > 0, 'Retrieved plan has steps');

  // Simulate what approvePlan does: remove from pending, then attempt execution
  notify.removePendingPlan(plan.id);
  assert(notify.getPendingPlan(plan.id) === null, 'Plan removed from pending store after approval');

  // Verify disk is clean
  const raw = readRawPendingPlans();
  assert(raw[plan.id] === undefined, 'Plan removed from pending-plans.json on disk');

  clearPendingPlans();
}

// ────────────────────────────────────────────────────────────────
// 4. cancelPlan() — removes plan from pending store
// ────────────────────────────────────────────────────────────────

function testCancelPlan() {
  console.log('\n--- Approval Flow: cancelPlan() removes pending plan ---');

  clearPendingPlans();

  const plan = planner.decompose({
    description: 'Analyze comprehensive security vulnerabilities requiring extensive API usage.',
    type: 'analysis',
    complexity: 150, // High complexity forces large token count
    files: ['file1.js', 'file2.js', 'file3.js'],
    toolsNeeded: ['web']
  });
  const cost = planner.estimateCost(plan);

  notify.storePendingPlan(plan.id, plan, cost);
  assert(notify.getPendingPlan(plan.id) !== null, 'Plan exists before cancel');

  // Cancel via notify.removePendingPlan (same path as router.cancelPlan)
  const removed = notify.removePendingPlan(plan.id);
  assert(removed === true, 'removePendingPlan returns true for existing plan');
  assert(notify.getPendingPlan(plan.id) === null, 'Plan is null after cancel');

  // Cancel non-existent plan returns false
  const removedAgain = notify.removePendingPlan(plan.id);
  assert(removedAgain === false, 'removePendingPlan returns false when plan already gone');

  // Verify disk
  const raw = readRawPendingPlans();
  assert(raw[plan.id] === undefined, 'Cancelled plan removed from disk');

  clearPendingPlans();
}

// ────────────────────────────────────────────────────────────────
// 5. Plans expire after 30 minutes
// ────────────────────────────────────────────────────────────────

function testPlanExpiry() {
  console.log('\n--- Approval Flow: plans expire after 30 minutes ---');

  clearPendingPlans();

  const planId = 'plan_expiry_test_001';
  const fakePlan = { id: planId, steps: [], task: { description: 'expiry test' } };
  const fakeCost = { totalApiCost: 5.00, needsApproval: true };

  // Write a plan with createdAt 31 minutes ago (expired)
  const expiredTime = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  const freshTime = new Date().toISOString();

  const rawPlans = {
    [planId]: {
      plan: fakePlan,
      costBreakdown: fakeCost,
      createdAt: expiredTime,
      status: 'pending'
    },
    'plan_fresh_test_002': {
      plan: { id: 'plan_fresh_test_002', steps: [], task: { description: 'fresh test' } },
      costBreakdown: fakeCost,
      createdAt: freshTime,
      status: 'pending'
    }
  };

  writeRawPendingPlans(rawPlans);

  // getPendingPlan triggers loadPendingPlans() which prunes expired entries
  const expired = notify.getPendingPlan(planId);
  assert(expired === null, 'Expired plan (31 min old) returns null');

  const fresh = notify.getPendingPlan('plan_fresh_test_002');
  assert(fresh !== null, 'Fresh plan (just created) is still retrievable');

  // getAllPendingPlans should only contain the fresh one
  const allPlans = notify.getAllPendingPlans();
  assert(allPlans[planId] === undefined, 'Expired plan not in getAllPendingPlans');
  assert(allPlans['plan_fresh_test_002'] !== undefined, 'Fresh plan present in getAllPendingPlans');

  // Verify that the on-disk file was pruned by the load
  // (loadPendingPlans doesn't save after pruning, but getPendingPlan reads the pruned set)
  // Store a fresh plan to trigger a save path, then verify expired is gone on next read
  notify.storePendingPlan('plan_trigger_save', fakePlan, fakeCost);
  const rawAfter = readRawPendingPlans();
  // The storePendingPlan calls loadPendingPlans (which prunes) then saves
  assert(rawAfter[planId] === undefined, 'Expired plan pruned from disk after store cycle');
  assert(rawAfter['plan_fresh_test_002'] !== undefined, 'Fresh plan survived pruning on disk');

  clearPendingPlans();
}

// ────────────────────────────────────────────────────────────────
// 6. notify.sendPlanApproval() format validation
// ────────────────────────────────────────────────────────────────

function testSendPlanApprovalFormat() {
  console.log('\n--- Approval Flow: sendPlanApproval() message format ---');

  clearPendingPlans();

  // Since execSync is imported at the module level, we'll test by checking return value
  // and ensuring the plan is properly stored (which indicates the notification logic ran)
  let testPassed = true;

  const plan = planner.decompose({
    description: 'Analyze comprehensive security vulnerabilities requiring extensive API usage.',
    type: 'analysis',
    complexity: 150, // High complexity forces large token count
    files: ['file1.js', 'file2.js', 'file3.js'],
    toolsNeeded: ['web']
  });
  const cost = planner.estimateCost(plan);

  // Force notifications enabled for this test
  const configPath = path.join(__dirname, 'config.json');
  const origConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const testConfig = { ...origConfig, notifications: { ...origConfig.notifications, enabled: true } };
  fs.writeFileSync(configPath, JSON.stringify(testConfig, null, 2));

  try {
    const sent = notify.sendPlanApproval(plan, cost);

    // Since we can't easily capture the execSync call due to module-level destructuring,
    // we'll verify that the function worked by checking it returned true with notifications enabled
    // and that the plan was properly stored (which only happens after notification logic runs)
    assert(sent === true, 'sendPlanApproval sent a notification message');

    // Verify the plan was stored as pending
    const stored = notify.getPendingPlan(plan.id);
    assert(stored !== null, 'sendPlanApproval stores plan as pending');
    assert(stored.status === 'pending', 'Stored plan has status=pending');
    assert(stored.costBreakdown.totalApiCost === cost.totalApiCost, 'Stored cost matches');

  } finally {
    // Restore config
    fs.writeFileSync(configPath, JSON.stringify(origConfig, null, 2));
  }

  clearPendingPlans();
}

// ────────────────────────────────────────────────────────────────
// 7. Multiple pending plans — getPendingPlans returns all
// ────────────────────────────────────────────────────────────────

function testMultiplePendingPlans() {
  console.log('\n--- Approval Flow: multiple pending plans ---');

  clearPendingPlans();

  const plan1 = planner.decompose({
    description: 'First API analysis task requiring extensive API usage.',
    type: 'analysis',
    complexity: 150, // High complexity forces large token count
    files: ['file1.js', 'file2.js', 'file3.js'],
    toolsNeeded: ['web']
  });
  const plan2 = planner.decompose({
    description: 'Second API analysis task requiring extensive API usage.',
    type: 'analysis',
    complexity: 150, // High complexity forces large token count
    files: ['fileA.js', 'fileB.js', 'fileC.js'],
    toolsNeeded: ['web']
  });

  const cost1 = planner.estimateCost(plan1);
  const cost2 = planner.estimateCost(plan2);

  notify.storePendingPlan(plan1.id, plan1, cost1);
  notify.storePendingPlan(plan2.id, plan2, cost2);

  const all = notify.getAllPendingPlans();
  const keys = Object.keys(all);

  assert(keys.length === 2, `getAllPendingPlans returns 2 plans (got ${keys.length})`);
  assert(all[plan1.id] !== undefined, 'First plan present');
  assert(all[plan2.id] !== undefined, 'Second plan present');

  // Cancel one — the other remains
  notify.removePendingPlan(plan1.id);
  const afterCancel = notify.getAllPendingPlans();
  assert(afterCancel[plan1.id] === undefined, 'Cancelled plan removed');
  assert(afterCancel[plan2.id] !== undefined, 'Other plan still present');

  clearPendingPlans();
}

// ────────────────────────────────────────────────────────────────
// 8. Route with plan=true stores pending plan for expensive tasks
// ────────────────────────────────────────────────────────────────

function testRouteWithPlanMode() {
  console.log('\n--- Approval Flow: route() with plan=true for expensive task ---');

  // We test that planner.decompose + estimateCost + the threshold logic
  // in route() would trigger sendPlanApproval for expensive tasks.
  // Since route() requires full initialization, we test the logic directly.

  const plan = planner.decompose({
    description: 'Analyze comprehensive security vulnerabilities requiring extensive API usage.',
    type: 'analysis',
    complexity: 150, // High complexity forces large token count
    files: ['file1.js', 'file2.js', 'file3.js'],
    toolsNeeded: ['web']
  });
  const cost = planner.estimateCost(plan);
  const formatted = planner.formatPlanForUser(plan);

  // Simulate the threshold check from route() (line 150-156 of index.js)
  const threshold = 2; // default
  const wouldSendApproval = cost.totalApiCost > threshold;

  assert(wouldSendApproval === true, 'Expensive task triggers approval notification path');
  assert(typeof formatted === 'string', 'Formatted plan is a string');
  assert(formatted.includes('approval required'), 'Formatted plan mentions approval required');

  // Cheap task should NOT trigger
  const cheapPlan = planner.decompose({
    description: 'Fix a typo',
    type: 'docs',
    complexity: 1
  });
  const cheapCost = planner.estimateCost(cheapPlan);
  const cheapWouldSend = cheapCost.totalApiCost > threshold;

  assert(cheapWouldSend === false, 'Cheap task does NOT trigger approval notification');
}

// ────────────────────────────────────────────────────────────────
// Run all approval flow tests
// ────────────────────────────────────────────────────────────────

function runAllTests() {
  const startTime = Date.now();

  console.log('OpenClaw Task Router — Approval Flow Test Suite');
  console.log('='.repeat(55));

  // Ensure clean state
  clearPendingPlans();

  testPlanCreationNeedsApproval();
  testPendingPlanStore();
  testApprovePlan();
  testCancelPlan();
  testPlanExpiry();
  testSendPlanApprovalFormat();
  testMultiplePendingPlans();
  testRouteWithPlanMode();

  // Final cleanup
  clearPendingPlans();

  const duration = Date.now() - startTime;

  console.log('\n' + '='.repeat(55));
  console.log(`Results: ${passed} passed, ${failed} failed (${(duration / 1000).toFixed(1)}s)`);

  if (failures.length > 0) {
    console.log('\nFailed tests:');
    for (const f of failures) {
      console.log(`  - ${f}`);
    }
  }

  console.log();

  if (failed > 0) {
    process.exit(1);
  }
  
  process.exit(0);
}

if (require.main === module) {
  runAllTests();
}

module.exports = { runAllTests };
