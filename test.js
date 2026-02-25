#!/usr/bin/env node

/**
 * OpenClaw Task Router v2 — Comprehensive Test Suite
 * Tests planner, scheduler, multi-route execution, and all existing functionality.
 */

const fs = require('fs');
const path = require('path');

// Set up temporary data directory for tests
const TEST_DATA_DIR = path.join(__dirname, 'data', 'test-tmp');

function setupTestEnvironment() {
  // Create test data directory
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

  // Override data paths for modules that support it
  process.env.ROUTER_TEST_MODE = 'true';
  process.env.ROUTER_TEST_DATA_DIR = TEST_DATA_DIR;
}

function cleanupTestEnvironment() {
  // Remove test data directory
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
  
  // Clean up environment variables
  delete process.env.ROUTER_TEST_MODE;
  delete process.env.ROUTER_TEST_DATA_DIR;
}

// Set up test environment before requiring modules
setupTestEnvironment();

const planner = require('./planner');
const scheduler = require('./scheduler');

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

// ────────────────────────────────────────────────────────────────
// 1. Planner — decompose()
// ────────────────────────────────────────────────────────────────

function testPlannerSimpleTask() {
  console.log('\n--- Planner: simple task (no decomposition) ---');

  const plan = planner.decompose({
    description: 'Write a hello world',
    type: 'code',
    complexity: 2
  });

  assert(plan && plan.id, 'Plan has an id');
  assert(plan.steps.length === 1, 'Simple task produces 1 step');
  assert(plan.steps[0].backend !== undefined, 'Step has a backend');
  assert(plan.totalCost >= 0, 'Cost is non-negative');
  assert(plan.needsApproval === false, 'Simple task needs no approval');
}

function testPlannerComplexTask() {
  console.log('\n--- Planner: complex task (multi-step) ---');

  const plan = planner.decompose({
    description: 'OCR and extract data from financial documents, then analyze for tax optimization opportunities and generate a recommendation report formatted in markdown',
    type: 'analysis',
    complexity: 8,
    files: ['doc1.pdf', 'doc2.pdf', 'doc3.pdf']
  });

  assert(plan.steps.length >= 3, `Complex task produces >= 3 steps (got ${plan.steps.length})`);

  // Check that there's a synthesis step at the end
  const lastStep = plan.steps[plan.steps.length - 1];
  assert(lastStep.type === 'synthesis', 'Last step is synthesis');
  assert(lastStep.dependencies.length > 0, 'Synthesis step has dependencies');

  // Check file-ops step exists
  const fileOpsStep = plan.steps.find(s => s.type === 'file-ops');
  assert(fileOpsStep !== undefined, 'Plan includes a file-ops step');

  // Check analysis step exists
  const analysisStep = plan.steps.find(s => s.type === 'analysis');
  assert(analysisStep !== undefined, 'Plan includes an analysis step');
}

function testPlannerExpensiveTask() {
  console.log('\n--- Planner: expensive task (needs approval) ---');

  const plan = planner.decompose({
    description: 'Analyze entire codebase using API for comprehensive security audit, investigate vulnerabilities, generate detailed recommendations across all files',
    type: 'analysis',
    complexity: 10,
    files: Array.from({length: 20}, (_, i) => `file${i}.js`),
    toolsNeeded: ['web']
  });

  const cost = planner.estimateCost(plan);

  assert(cost.totalApiCost >= 0, 'API cost is calculated');
  assert(cost.stepCount > 0, 'Cost breakdown has steps');
  assert(typeof cost.totalEstimatedMinutes === 'number', 'Time estimate is a number');
  assert(cost.perStep.length === plan.steps.length, 'Per-step breakdown matches step count');
}

function testPlannerBackwardCompatible() {
  console.log('\n--- Planner: backward-compatible routing ---');

  // A simple task should get a single step — fallback for graceful degradation
  const plan = planner.decompose({
    description: 'Fix a typo in readme',
    complexity: 1
  });

  assert(plan.steps.length === 1, 'Trivial task gets 1 step');
  assert(plan.allSubscription === true || plan.totalCost === 0, 'Trivial task is free');
}

// ────────────────────────────────────────────────────────────────
// 2. Planner — estimateCost() & formatPlanForUser()
// ────────────────────────────────────────────────────────────────

function testCostEstimation() {
  console.log('\n--- Planner: cost estimation ---');

  const plan = planner.decompose({
    description: 'Refactor authentication module across multiple files and write tests',
    type: 'code',
    complexity: 7,
    files: ['auth.js', 'middleware.js', 'test.js']
  });

  const cost = planner.estimateCost(plan);

  assert(cost.planId === plan.id, 'Cost references correct plan');
  assert(typeof cost.totalApiCost === 'number', 'Total API cost is a number');
  assert(typeof cost.totalSubscriptionMinutes === 'number', 'Subscription minutes is a number');
  assert(typeof cost.totalLocalMinutes === 'number', 'Local minutes is a number');
  assert(typeof cost.totalEstimatedMinutes === 'number', 'Total estimated minutes is a number');
  assert(cost.totalEstimatedMinutes > 0, 'Time estimate is positive');

  // Subscription steps should be free
  for (const entry of cost.perStep) {
    if (['claude-code', 'codex', 'local'].includes(entry.backend)) {
      assert(entry.isFree === true, `Step on ${entry.backend} is marked free`);
      assert(entry.estimatedCost === 0, `Step on ${entry.backend} has $0 cost`);
    }
  }
}

function testFormatPlan() {
  console.log('\n--- Planner: formatPlanForUser ---');

  const plan = planner.decompose({
    description: 'Research market trends, analyze competitors, and generate a strategy document',
    type: 'research',
    complexity: 7
  });

  const formatted = planner.formatPlanForUser(plan);

  assert(typeof formatted === 'string', 'Formatted plan is a string');
  assert(formatted.includes('Task Plan'), 'Contains header');
  assert(formatted.includes('Backend:'), 'Contains backend info');
  assert(formatted.includes('Cost Summary'), 'Contains cost summary');
  assert(formatted.length > 100, 'Formatted plan is substantial');
}

// ────────────────────────────────────────────────────────────────
// 3. Planner — decomposition heuristics
// ────────────────────────────────────────────────────────────────

function testHeuristics() {
  console.log('\n--- Planner: heuristic detection ---');

  // File operations
  const fileTask = planner.decompose({
    description: 'OCR and parse all PDF invoices from the inbox',
    files: ['inv1.pdf', 'inv2.pdf', 'inv3.pdf', 'inv4.pdf']
  });
  const hasFileOps = fileTask.steps.some(s => s.type === 'file-ops');
  assert(hasFileOps, 'Detects file-ops from OCR keyword');

  // Research
  const researchTask = planner.decompose({
    description: 'Research and investigate the latest AI agent frameworks',
    complexity: 6
  });
  const hasResearch = researchTask.steps.some(s => s.type === 'research');
  assert(hasResearch, 'Detects research from keyword');

  // Multi-file code
  const codeTask = planner.decompose({
    description: 'Refactor the full system architecture across multiple files',
    complexity: 9
  });
  const hasCode = codeTask.steps.some(s => s.type === 'code');
  assert(hasCode, 'Detects multi-file code changes');

  // Documentation
  const docsTask = planner.decompose({
    description: 'Document all API endpoints and create a developer guide',
    complexity: 5
  });
  const hasDocs = docsTask.steps.some(s => s.type === 'docs');
  assert(hasDocs, 'Detects documentation from keyword');
}

// ────────────────────────────────────────────────────────────────
// 4. Scheduler — enqueue, getStatus, getETA, cancel
// ────────────────────────────────────────────────────────────────

async function testSchedulerEnqueue() {
  console.log('\n--- Scheduler: enqueue ---');

  // Fresh load
  scheduler.queue = [];
  scheduler.completed = [];
  scheduler.active = new Map();
  scheduler.loaded = true;

  const id1 = await scheduler.enqueue(
    { description: 'Background code review' },
    'claude-code',
    'background'
  );
  assert(typeof id1 === 'string' && id1.startsWith('sched_'), 'Returns a scheduler task ID');

  const id2 = await scheduler.enqueue(
    { description: 'Urgent fix deploy' },
    'codex',
    'urgent'
  );

  const id3 = await scheduler.enqueue(
    { description: 'Normal documentation' },
    'claude-code',
    'normal'
  );

  assert(scheduler.queue.length === 3, 'Queue has 3 tasks');

  // Urgent should be first
  assert(scheduler.queue[0].id === id2, 'Urgent task is first in queue');
  assert(scheduler.queue[scheduler.queue.length - 1].id === id1, 'Background task is last');
}

async function testSchedulerGetStatus() {
  console.log('\n--- Scheduler: getStatus ---');

  const status = scheduler.getStatus();

  assert(typeof status.totalQueued === 'number', 'Status has totalQueued');
  assert(typeof status.totalActive === 'number', 'Status has totalActive');
  assert(typeof status.paused === 'boolean', 'Status has paused flag');
  assert(status.backends !== undefined, 'Status has backends');
  assert(status.backends['claude-code'] !== undefined, 'Has claude-code backend info');
  assert(status.backends['codex'] !== undefined, 'Has codex backend info');
  assert(status.backends['claude-code'].concurrencyLimit === 1, 'Claude-code concurrency is 1');
  assert(status.backends['codex'].concurrencyLimit === 3, 'Codex concurrency is 3');
}

async function testSchedulerGetETA() {
  console.log('\n--- Scheduler: getETA ---');

  // Get ETA for a queued task
  const firstTask = scheduler.queue[0];
  const eta = scheduler.getETA(firstTask.id);

  assert(eta !== null, 'ETA returned for queued task');
  assert(eta.status === 'queued', 'Status is queued');
  assert(typeof eta.position === 'number', 'Has position');
  assert(typeof eta.estimatedStartMinutes === 'number', 'Has estimated start minutes');
  assert(typeof eta.estimatedTotalMinutes === 'number', 'Has estimated total minutes');

  // Non-existent task
  const noEta = scheduler.getETA('nonexistent_id');
  assert(noEta === null, 'Returns null for unknown task');
}

async function testSchedulerCancel() {
  console.log('\n--- Scheduler: cancel ---');

  const initialCount = scheduler.queue.length;
  const taskToCancel = scheduler.queue[scheduler.queue.length - 1]; // background task

  const cancelled = await scheduler.cancel(taskToCancel.id);
  assert(cancelled === true, 'Cancel returns true for queued task');
  assert(scheduler.queue.length === initialCount - 1, 'Queue size decreased by 1');

  const cancelAgain = await scheduler.cancel('nonexistent_id');
  assert(cancelAgain === false, 'Cancel returns false for unknown task');
}

async function testSchedulerPauseResume() {
  console.log('\n--- Scheduler: pause/resume ---');

  scheduler.pause();
  assert(scheduler.paused === true, 'Scheduler is paused');

  const status1 = scheduler.getStatus();
  assert(status1.paused === true, 'Status reflects paused');

  scheduler.resume();
  assert(scheduler.paused === false, 'Scheduler is resumed');
}

// ────────────────────────────────────────────────────────────────
// 5. Scheduler — ordering and priority
// ────────────────────────────────────────────────────────────────

async function testSchedulerOrdering() {
  console.log('\n--- Scheduler: ordering ---');

  // Pause first so _tick() doesn't dispatch our test tasks
  scheduler.pause();

  // Full reset — clear internal state and prevent disk loads from interfering
  scheduler.queue = [];
  scheduler.active = new Map();
  scheduler.completed = [];
  scheduler.loaded = true;
  scheduler._processing = false;
  // Mock save/load to prevent disk interference during test
  const origSave = scheduler.save.bind(scheduler);
  const origLoad = scheduler.load.bind(scheduler);
  scheduler.save = async () => {};
  scheduler.load = async () => {};

  await scheduler.enqueue({ description: 'Low prio' }, 'codex', 'background');
  await scheduler.enqueue({ description: 'High prio' }, 'codex', 'urgent');
  await scheduler.enqueue({ description: 'Normal prio' }, 'codex', 'normal');
  await scheduler.enqueue({ description: 'Another urgent' }, 'codex', 'urgent');
  await scheduler.enqueue({ description: 'Background 2' }, 'codex', 'background');

  // Filter to just our test tasks (description starts with known strings)
  // Verify priority ordering: urgents first, then normal, then background
  const priorities = scheduler.queue.map(t => t.priorityName);
  const urgentCount = priorities.filter(p => p === 'urgent').length;
  const normalIdx = priorities.indexOf('normal');
  const bgIdx = priorities.indexOf('background');
  assert(urgentCount >= 2, 'At least 2 urgent tasks');
  assert(normalIdx > priorities.lastIndexOf('urgent') || normalIdx === -1, 'Normal comes after urgent');
  assert(bgIdx > normalIdx || bgIdx === -1, 'Background comes after normal');
  assert(scheduler.queue.length >= 5, 'Queue has at least 5 tasks');
}

// ────────────────────────────────────────────────────────────────
// 6. Multi-route context passing (unit test — no live backends)
// ────────────────────────────────────────────────────────────────

function testContextPassing() {
  console.log('\n--- Multi-route: context passing logic ---');

  // Simulate the context extraction
  const result1 = { response: 'Step 1 produced these findings: revenue grew 20%', duration: 1000 };
  const ctx1 = result1.response.substring(0, 1000);
  assert(ctx1.includes('revenue grew 20%'), 'Context extracted from response');

  const result2 = { output: 'Analysis output with details', duration: 500 };
  const ctx2 = result2.output ? result2.output.substring(0, 1000) : '';
  assert(ctx2.includes('Analysis output'), 'Context extracted from output field');

  // Simulate building a task with context
  const step = {
    description: 'Synthesize findings',
    dependencies: ['step1', 'step2'],
    type: 'synthesis'
  };
  const priorContext = { step1: ctx1, step2: ctx2 };

  let description = step.description;
  const contextSnippets = step.dependencies
    .filter(depId => priorContext[depId])
    .map(depId => priorContext[depId].substring(0, 500));
  if (contextSnippets.length > 0) {
    description += '\n\nContext from prior steps:\n' + contextSnippets.join('\n---\n');
  }

  assert(description.includes('revenue grew 20%'), 'Context from step1 injected');
  assert(description.includes('Analysis output'), 'Context from step2 injected');
  assert(description.includes('Synthesize findings'), 'Original description preserved');
}

// ────────────────────────────────────────────────────────────────
// 7. Failure recovery logic
// ────────────────────────────────────────────────────────────────

function testFailureRecovery() {
  console.log('\n--- Multi-route: failure recovery logic ---');

  // Test fallback chain
  const fallbackChain = ['api', 'local'];

  function getNextFallback(failedBackend) {
    const index = fallbackChain.indexOf(failedBackend);
    if (index !== -1 && index < fallbackChain.length - 1) {
      return fallbackChain[index + 1];
    }
    if (failedBackend !== 'local') return 'local';
    return null;
  }

  assert(getNextFallback('api') === 'local', 'API falls back to local');
  assert(getNextFallback('claudeCode') === 'local', 'Claude falls back to local');
  assert(getNextFallback('codex') === 'local', 'Codex falls back to local');
  assert(getNextFallback('local') === null, 'Local has no fallback');

  // Test critical vs non-critical step handling
  const errors = {};
  const failedSet = new Set();
  const remaining = new Set(['s1']);

  // Critical step failure
  const criticalStep = { id: 's1', index: 0, critical: true, description: 'critical' };
  if (criticalStep.critical) {
    errors[criticalStep.id] = 'test error';
    failedSet.add(criticalStep.id);
    remaining.delete(criticalStep.id);
  }
  assert(failedSet.has('s1'), 'Critical step added to failed set');
  assert(!remaining.has('s1'), 'Critical step removed from remaining');

  // Non-critical step failure
  const remaining2 = new Set(['s2']);
  const optionalStep = { id: 's2', index: 1, critical: false, description: 'optional' };
  if (!optionalStep.critical) {
    errors[optionalStep.id] = 'Skipped (non-critical): test error';
    remaining2.delete(optionalStep.id);
  }
  assert(errors['s2'].includes('Skipped'), 'Non-critical step marked as skipped');
  assert(!remaining2.has('s2'), 'Non-critical step removed from remaining');
}

// ────────────────────────────────────────────────────────────────
// 8. Planner dependency graph
// ────────────────────────────────────────────────────────────────

function testDependencyGraph() {
  console.log('\n--- Planner: dependency graph ---');

  const plan = planner.decompose({
    description: 'Extract data from files, analyze the extracted data, then generate a formatted report with documentation',
    complexity: 8,
    files: ['data1.csv', 'data2.csv', 'data3.csv']
  });

  // All steps should have valid dependency references
  const stepIds = new Set(plan.steps.map(s => s.id));
  for (const step of plan.steps) {
    for (const depId of step.dependencies) {
      assert(stepIds.has(depId), `Dependency ${depId} exists in plan for step ${step.id}`);
    }
  }

  // The first step(s) should have no dependencies
  const firstSteps = plan.steps.filter(s => s.dependencies.length === 0);
  assert(firstSteps.length > 0, 'Plan has at least one step with no dependencies');

  // Synthesis (last) step should depend on other steps
  const lastStep = plan.steps[plan.steps.length - 1];
  if (plan.steps.length > 1) {
    assert(lastStep.dependencies.length > 0, 'Last step has dependencies');
  }
}

// ────────────────────────────────────────────────────────────────
// 9. Planner — parallel time estimation
// ────────────────────────────────────────────────────────────────

function testParallelTimeEstimation() {
  console.log('\n--- Planner: parallel time estimation ---');

  // Create a plan with parallel steps
  const plan = planner.decompose({
    description: 'Research market trends, extract data from documents, then analyze findings together',
    complexity: 7,
    files: ['report1.pdf', 'report2.pdf']
  });

  const cost = planner.estimateCost(plan);

  // Total parallel time should be less than sum of all step times
  const sequentialTime = plan.steps.reduce((sum, s) => sum + s.estimatedMinutes, 0);
  assert(cost.totalEstimatedMinutes <= sequentialTime,
    `Parallel time (${cost.totalEstimatedMinutes}) <= sequential (${sequentialTime})`);
  assert(cost.totalEstimatedMinutes > 0, 'Parallel time is positive');
}

// ────────────────────────────────────────────────────────────────
// 10. Scheduler — health tracking
// ────────────────────────────────────────────────────────────────

function testSchedulerHealth() {
  console.log('\n--- Scheduler: health tracking ---');

  assert(scheduler.health['claude-code'] !== undefined, 'Has claude-code health');
  assert(scheduler.health['codex'] !== undefined, 'Has codex health');
  assert(typeof scheduler.health['claude-code'].throttled === 'boolean', 'throttled is boolean');
  assert(typeof scheduler.health['claude-code'].consecutiveFailures === 'number', 'consecutiveFailures is number');

  // Simulate throttle
  scheduler.health['codex'].throttled = true;
  scheduler.health['codex'].backoffUntil = new Date(Date.now() + 60000).toISOString();
  const status = scheduler.getStatus();
  assert(status.backends['codex'].health.throttled === true, 'Status reflects throttled backend');

  // Reset
  scheduler.health['codex'].throttled = false;
  scheduler.health['codex'].backoffUntil = null;
}

// ────────────────────────────────────────────────────────────────
// 11. Scheduler — event emitter
// ────────────────────────────────────────────────────────────────

async function testSchedulerEvents() {
  console.log('\n--- Scheduler: event emitter ---');

  // Pause first so _tick() doesn't dispatch our test tasks
  scheduler.pause();

  let enqueueEvent = false;
  let cancelEvent = false;
  let pauseEvent = false;
  let resumeEvent = false;

  scheduler.once('enqueue', () => { enqueueEvent = true; });
  scheduler.once('cancelled', () => { cancelEvent = true; });

  const id = await scheduler.enqueue({ description: 'event test' }, 'codex', 'normal');
  assert(enqueueEvent, 'Enqueue event emitted');

  await scheduler.cancel(id);
  assert(cancelEvent, 'Cancel event emitted');

  // Now test pause/resume events
  scheduler.resume(); // need to resume so we can pause again and catch event
  scheduler.once('paused', () => { pauseEvent = true; });
  scheduler.once('resumed', () => { resumeEvent = true; });

  scheduler.pause();
  assert(pauseEvent, 'Pause event emitted');

  scheduler.resume();
  assert(resumeEvent, 'Resume event emitted');

  // Re-pause to prevent background dispatching
  scheduler.pause();
}

// ────────────────────────────────────────────────────────────────
// New Module Tests
// ────────────────────────────────────────────────────────────────

async function testCircuitBreaker() {
  console.log('\n--- Circuit Breaker: state transitions ---');

  const circuitBreaker = require('./circuit-breaker');
  await circuitBreaker.load();

  // Reset to clean state
  circuitBreaker.reset('testBackend');
  
  // Initial state should be CLOSED
  let state = circuitBreaker.getState('testBackend');
  assert(state.state === 'CLOSED', 'Initial state is CLOSED');
  assert(state.failures === 0, 'Initial failures count is 0');

  // Can execute in CLOSED state
  assert(circuitBreaker.canExecute('testBackend') === true, 'Can execute in CLOSED state');

  // Record failures to trigger OPEN (threshold is now 8)
  for (let i = 0; i < 8; i++) {
    circuitBreaker.recordFailure('testBackend', { error: 'test failure' });
  }

  state = circuitBreaker.getState('testBackend');
  assert(state.state === 'OPEN', 'State transitions to OPEN after threshold failures');
  assert(state.failures === 8, 'Failure count tracks correctly');
  assert(state.cooldownEnds !== null, 'Cooldown timer is set');

  // Cannot execute in OPEN state
  assert(circuitBreaker.canExecute('testBackend') === false, 'Cannot execute in OPEN state');

  console.log('\n--- Circuit Breaker: failure counting and cooldown ---');

  // Test rate limit detection
  circuitBreaker.reset('rateLimitBackend');
  circuitBreaker.recordFailure('rateLimitBackend', { error: 'rate limit exceeded', rateLimited: true });
  
  state = circuitBreaker.getState('rateLimitBackend');
  assert(state.failures === 1, 'Rate limit failure recorded');

  console.log('\n--- Circuit Breaker: recovery ---');

  // Test recovery path (can't easily test time-based transitions without mocking time)
  circuitBreaker.reset('recoveryBackend');
  circuitBreaker.recordSuccess('recoveryBackend'); // Should be no-op in CLOSED
  
  state = circuitBreaker.getState('recoveryBackend');
  assert(state.state === 'CLOSED', 'Success in CLOSED state maintains CLOSED');

  // Test getAll (returns predefined backends, not custom test backends)
  const allStates = circuitBreaker.getAll();
  assert(typeof allStates === 'object', 'getAll returns object');
  assert(allStates.claudeCode !== undefined, 'getAll includes standard backends');

  // Clean up test backends (ISSUE 6)
  circuitBreaker.removeBackend('testBackend');
  circuitBreaker.removeBackend('rateLimitBackend');
  circuitBreaker.removeBackend('recoveryBackend');
}

async function testDedup() {
  console.log('\n--- Dedup: similarity detection ---');

  const dedup = require('./dedup');
  await dedup.load();

  // Clear any existing tasks
  const existing = dedup.getRecent();
  for (const task of existing) {
    dedup.complete(task.id, { failed: true }); // Mark as failed to clear
  }

  // Test duplicate detection
  const task1 = { description: 'Analyze security vulnerabilities in the authentication system' };
  const task2 = { description: 'Analyze security vulnerabilities in authentication system components' };
  
  dedup.register('task1', task1);
  
  const result = dedup.check(task2);
  assert(result.similarity > 0.5, `High similarity detected (${(result.similarity * 100).toFixed(1)}%)`);
  assert(result.recommendation !== 'proceed', 'Similar task flagged for review');

  console.log('\n--- Dedup: 70% threshold test ---');

  // Test different enough task
  const differentTask = { description: 'Create a new React component for the dashboard' };
  const diffResult = dedup.check(differentTask);
  assert(diffResult.similarity < 0.7, 'Different task has low similarity');
  assert(diffResult.isDuplicate === false, 'Different task not marked as duplicate');

  console.log('\n--- Dedup: scope detection ---');

  // Test different scope (numeric ranges)
  const pageTask1 = { description: 'Process pages 1-10 from the document' };
  const pageTask2 = { description: 'Process pages 11-20 from the document' };
  
  dedup.register('pageTask1', pageTask1);
  const scopeResult = dedup.check(pageTask2);
  // Scope detection may flag as similar but not duplicate due to different ranges
  assert(scopeResult.isDuplicate === false, 'Different scope not marked as duplicate');

  console.log('\n--- Dedup: failed task retries ---');

  // Test retry of failed task
  dedup.register('failedTask', { description: 'This task will fail' });
  dedup.complete('failedTask', { failed: true });
  
  const retryResult = dedup.check({ description: 'This task will fail and needs retry' });
  assert(retryResult.isDuplicate === false, 'Failed tasks can be retried');

  // Test getRecent
  const recent = dedup.getRecent();
  assert(Array.isArray(recent), 'getRecent returns array');
}

async function testSession() {
  console.log('\n--- Session: task management ---');

  const session = require('./session');
  await session.load();

  // Test addTask
  const task = await session.addTask({
    taskId: 'test123',
    description: 'Test task for session management',
    plan: { steps: 5 },
    startedFrom: 'test'
  });

  assert(task.taskId === 'test123', 'Task ID stored correctly');
  assert(task.description !== '', 'Task description stored');
  assert(task.status === 'running', 'Default status is running');

  console.log('\n--- Session: getActiveTask and updateTask ---');

  // Test getActiveTask
  const retrieved = session.getActiveTask('test123');
  assert(retrieved !== null, 'Active task retrievable');
  assert(retrieved.taskId === 'test123', 'Retrieved task has correct ID');

  // Test updateTask
  const updated = await session.updateTask('test123', { 
    currentStep: 3,
    eta: '5 min' 
  });
  assert(updated.currentStep === 3, 'Task updated correctly');
  assert(updated.eta === '5 min', 'Multiple fields updated');

  console.log('\n--- Session: completeTask ---');

  // Test completeTask
  const completed = await session.completeTask('test123', {
    duration: 120000,
    cost: 2.50,
    outputPath: '/tmp/test-output.txt'
  });

  assert(completed !== null, 'Task completion returns task');
  assert(completed.status === 'complete', 'Status updated to complete');
  assert(completed.duration === 120000, 'Duration stored');
  assert(completed.cost === 2.50, 'Cost stored');

  // Task should no longer be active
  assert(session.getActiveTask('test123') === null, 'Completed task no longer active');

  console.log('\n--- Session: channel tracking ---');

  // Test channel tracking
  await session.setChannelActive('telegram', 'test456');
  const channelState = session.getChannelState('telegram');
  assert(channelState.lastTaskId === 'test456', 'Channel task ID tracked');
  assert(channelState.lastActive !== null, 'Channel active time recorded');

  // Test getSummary
  const summary = session.getSummary();
  assert(typeof summary.activeTasks === 'number', 'Summary includes active task count');
  assert(typeof summary.recentlyCompleted === 'number', 'Summary includes completed count');

  console.log('\n--- Session: getContext ---');

  // Test getContext
  const context = session.getContext();
  assert(context.activeTasks !== undefined, 'Context includes active tasks');
  assert(context.recentCompleted !== undefined, 'Context includes recent completed');
  assert(context.channelHistory !== undefined, 'Context includes channel history');
}

async function testWarmup() {
  console.log('\n--- Warmup: health check initialization ---');

  const warmup = require('./warmup');
  await warmup.loadState();

  // Test getHealth
  const health = warmup.getHealth();
  assert(typeof health === 'object', 'getHealth returns object');

  // Test individual backend health
  const claudeHealth = warmup.getHealth('claudeCode');
  assert(claudeHealth.backend === 'claudeCode', 'Backend health has correct backend name');
  assert(['warm', 'healthy', 'cold', 'dead'].includes(claudeHealth.status), 'Health status is valid');

  console.log('\n--- Warmup: health scores ---');

  // Test health scores
  const score = warmup.getHealthScore('claudeCode');
  assert(typeof score === 'number', 'Health score is a number');
  assert(score >= 0 && score <= 100, 'Health score in valid range');

  const unknownScore = warmup.getHealthScore('unknownBackend');
  assert(unknownScore === 25, 'Unknown backend gets cold score (25)');

  console.log('\n--- Warmup: pre-warming ---');

  // Test pre-warming (without actually spawning processes in test)
  // This mainly tests the API exists and handles unknown backends
  const preWarmResult = warmup.preWarm('unknownBackend');
  assert(preWarmResult === null, 'Unknown backend pre-warm returns null');

  // Test state persistence
  await warmup.saveState();
  assert(true, 'State save completes without error');
}

function testNotify() {
  console.log('\n--- Notify: pending plan management ---');

  const notify = require('./notify');

  // Clean up any existing pending plans
  const existing = notify.getAllPendingPlans();
  for (const planId of Object.keys(existing)) {
    notify.removePendingPlan(planId);
  }

  // Test plan storage
  const testPlan = {
    id: 'test-plan-123',
    steps: [{ description: 'Test step', backend: 'api', estimatedCost: 1.50 }],
    task: { description: 'Test notification plan' }
  };
  const testCost = { totalApiCost: 1.50, needsApproval: true };

  notify.storePendingPlan(testPlan.id, testPlan, testCost);

  // Test retrieval
  const retrieved = notify.getPendingPlan(testPlan.id);
  assert(retrieved !== null, 'Pending plan stored and retrieved');
  assert(retrieved.plan.id === testPlan.id, 'Retrieved plan has correct ID');
  assert(retrieved.costBreakdown.totalApiCost === 1.50, 'Cost breakdown preserved');
  assert(retrieved.status === 'pending', 'Status is pending');

  console.log('\n--- Notify: plan removal ---');

  // Test removal
  const removed = notify.removePendingPlan(testPlan.id);
  assert(removed === true, 'Plan removal returns true for existing plan');
  
  const notFound = notify.getPendingPlan(testPlan.id);
  assert(notFound === null, 'Removed plan no longer retrievable');

  // Test removal of non-existent plan
  const removedAgain = notify.removePendingPlan(testPlan.id);
  assert(removedAgain === false, 'Removing non-existent plan returns false');

  console.log('\n--- Notify: getAllPendingPlans ---');

  // Test multiple plans
  notify.storePendingPlan('plan1', { id: 'plan1' }, { totalApiCost: 2.0 });
  notify.storePendingPlan('plan2', { id: 'plan2' }, { totalApiCost: 3.0 });

  const allPlans = notify.getAllPendingPlans();
  const planIds = Object.keys(allPlans);
  assert(planIds.length === 2, 'Multiple pending plans stored');
  assert(planIds.includes('plan1'), 'First plan in results');
  assert(planIds.includes('plan2'), 'Second plan in results');

  // Test message formatting (without actually sending - would need to mock execSync)
  console.log('\n--- Notify: message formatting (mock) ---');

  // Mock the plan approval to test format (won't actually send)
  const mockPlan = {
    id: 'format-test',
    steps: [
      { description: 'Test step 1', backend: 'api', estimatedCost: 1.0, estimatedMinutes: 5 },
      { description: 'Test step 2', backend: 'claude-code', estimatedCost: 0, estimatedMinutes: 10 }
    ],
    task: { description: 'Format test plan' }
  };
  const mockCost = { 
    totalApiCost: 1.0, 
    totalSubscriptionMinutes: 10,
    totalEstimatedMinutes: 15 
  };

  // Store the mock plan 
  notify.storePendingPlan(mockPlan.id, mockPlan, mockCost);
  const stored = notify.getPendingPlan(mockPlan.id);
  assert(stored !== null, 'Mock plan stored for format test');

  // Clean up
  notify.removePendingPlan('plan1');
  notify.removePendingPlan('plan2'); 
  notify.removePendingPlan('format-test');
}

// ────────────────────────────────────────────────────────────────
// Refinement Queue Tests
// ────────────────────────────────────────────────────────────────

function testRefinementQueueEnqueue() {
  console.log('\n--- Refinement Queue: enqueue task result ---');

  const { RefinementQueue } = require('./refinement-queue');
  const queue = new RefinementQueue({ enabled: true, minComplexityToQueue: 3 });
  
  // Test eligible task
  const eligibleTask = {
    taskId: 'rt_test123',
    description: 'write unit tests for auth module',
    backend: 'local',
    model: 'ollama/phi3:mini',
    complexity: 5,
    type: 'code',
    result: { files: ['test-auth.js'], summary: 'Generated unit tests' },
    tokens: 2000,
    duration: 8000
  };
  
  const result1 = queue.enqueue(eligibleTask);
  assert(result1.queued === true, 'Eligible task should be queued');
  assert(result1.queueItem.priority >= 3, 'Priority should be calculated');
  
  // Test ineligible task (too simple)
  const simpleTask = {
    taskId: 'rt_simple',
    description: 'hello world',
    backend: 'local',
    complexity: 2,
    type: 'code'
  };
  
  const result2 = queue.enqueue(simpleTask);
  assert(result2.queued === false, 'Simple task should not be queued');
  
  // Test ineligible backend
  const expensiveTask = {
    taskId: 'rt_expensive',
    description: 'complex analysis',
    backend: 'claudeCode',
    complexity: 8,
    type: 'analysis'
  };
  
  const result3 = queue.enqueue(expensiveTask);
  assert(result3.queued === false, 'Expensive backend task should not be queued');
}

function testRefinementQueueGetNext() {
  console.log('\n--- Refinement Queue: getNextRefinement returns highest priority ---');

  const { RefinementQueue } = require('./refinement-queue');
  const queue = new RefinementQueue();
  
  // Add items with different priorities
  queue.enqueue({
    taskId: 'rt_low', backend: 'local', complexity: 3, type: 'code',
    result: { summary: 'Low priority task' }
  });
  
  queue.enqueue({
    taskId: 'rt_high', backend: 'local', complexity: 8, type: 'code',
    result: { files: ['complex.js'], summary: 'High priority task' }
  });
  
  const next = queue.getNextRefinement();
  assert(next !== null, 'Should return an item');
  assert(next.priority >= 7, 'Should return highest priority item');
  assert(next.originalTaskId === 'rt_high', 'Should return the high priority task');
}

function testRefinementQueueComplexityFilter() {
  console.log('\n--- Refinement Queue: items below minComplexity are rejected ---');

  const { RefinementQueue } = require('./refinement-queue');
  const queue = new RefinementQueue({ minComplexityToQueue: 4 });
  
  const lowComplexityTask = {
    taskId: 'rt_low_complexity',
    backend: 'local',
    complexity: 3,
    type: 'code'
  };
  
  const result = queue.enqueue(lowComplexityTask);
  assert(result.queued === false, 'Task below complexity threshold should be rejected');
  
  const highComplexityTask = {
    taskId: 'rt_high_complexity',
    backend: 'local',
    complexity: 5,
    type: 'code',
    result: { summary: 'Complex task' }
  };
  
  const result2 = queue.enqueue(highComplexityTask);
  assert(result2.queued === true, 'Task above complexity threshold should be queued');
}

function testRefinementQueueStartRefinement() {
  console.log('\n--- Refinement Queue: startRefinement marks as in-progress ---');

  const { RefinementQueue } = require('./refinement-queue');
  const queue = new RefinementQueue();
  
  // Add a task
  const task = {
    taskId: 'rt_start_test',
    backend: 'local',
    complexity: 5,
    type: 'code',
    result: { summary: 'Test task' }
  };
  
  const enqueueResult = queue.enqueue(task);
  const itemId = enqueueResult.queueItem.id;
  
  const startResult = queue.startRefinement(itemId, 'claudeCode');
  assert(startResult.success === true, 'Should successfully start refinement');
  
  const item = queue.data.queue.find(i => i.id === itemId);
  assert(item.status === 'in-progress', 'Status should be in-progress');
  assert(item.refinementBackend === 'claudeCode', 'Backend should be recorded');
  assert(item.startedAt !== undefined, 'Start time should be recorded');
}

function testRefinementQueueCompleteRefinement() {
  console.log('\n--- Refinement Queue: completeRefinement moves to completed with stats ---');

  const { RefinementQueue } = require('./refinement-queue');
  const queue = new RefinementQueue();
  
  // Add and start a task
  const task = {
    taskId: 'rt_complete_test',
    backend: 'local',
    complexity: 6,
    type: 'code',
    result: { summary: 'Test task' },
    tokens: 1500
  };
  
  const enqueueResult = queue.enqueue(task);
  const itemId = enqueueResult.queueItem.id;
  queue.startRefinement(itemId, 'claudeCode');
  
  const refinedResult = {
    files: ['improved-code.js'],
    summary: 'Improved version with better error handling'
  };
  
  const completeResult = queue.completeRefinement(itemId, refinedResult, 75);
  assert(completeResult.success === true, 'Should successfully complete refinement');
  
  // Check that item moved to completed
  const queueItem = queue.data.queue.find(i => i.id === itemId);
  assert(queueItem === undefined, 'Item should be removed from queue');
  
  const completedItem = queue.data.completed.find(i => i.id === itemId);
  assert(completedItem !== undefined, 'Item should be in completed list');
  assert(completedItem.status === 'completed', 'Status should be completed');
  assert(completedItem.improvementScore === 75, 'Improvement score should be recorded');
  
  // Check stats
  assert(queue.data.stats.totalRefined >= 1, 'Total refined count should increment');
  assert(queue.data.stats.avgImprovementScore === 75, 'Average improvement score should be calculated');
  assert(queue.data.stats.tokensSaved > 0, 'Tokens saved should be calculated');
}

function testRefinementQueueSkipRefinement() {
  console.log('\n--- Refinement Queue: skipRefinement works ---');

  const { RefinementQueue } = require('./refinement-queue');
  const queue = new RefinementQueue();
  
  // Add a task
  const task = {
    taskId: 'rt_skip_test',
    backend: 'local',
    complexity: 4,
    type: 'code',
    result: { summary: 'Test task' }
  };
  
  const enqueueResult = queue.enqueue(task);
  const itemId = enqueueResult.queueItem.id;
  
  const skipResult = queue.skipRefinement(itemId, 'Original was already high quality');
  assert(skipResult.success === true, 'Should successfully skip refinement');
  
  // Check that item moved to completed with skip status
  const queueItem = queue.data.queue.find(i => i.id === itemId);
  assert(queueItem === undefined, 'Item should be removed from queue');
  
  const completedItem = queue.data.completed.find(i => i.id === itemId);
  assert(completedItem !== undefined, 'Item should be in completed list');
  assert(completedItem.status === 'skipped', 'Status should be skipped');
  assert(completedItem.skipReason === 'Original was already high quality', 'Skip reason should be recorded');
}

function testRefinementQueueMaxSize() {
  console.log('\n--- Refinement Queue: queue respects maxQueueSize (drops lowest priority) ---');

  // Delete require cache to get fresh instance
  delete require.cache[require.resolve('./refinement-queue')];
  const { RefinementQueue } = require('./refinement-queue');
  const queue = new RefinementQueue({ maxQueueSize: 2 });
  
  // Clear any existing queue state
  queue.data.queue = [];
  queue.data.completed = [];
  queue.data.stats = { totalRefined: 0, avgImprovementScore: 0, tokensSaved: 0 };
  
  // Add first task (low priority)
  const result1 = queue.enqueue({
    taskId: 'rt_first', backend: 'local', complexity: 3, type: 'code',
    result: { summary: 'First task' }
  });
  
  // Add second task (medium priority)  
  const result2 = queue.enqueue({
    taskId: 'rt_second', backend: 'local', complexity: 5, type: 'code',
    result: { summary: 'Second task' }
  });
  
  const initialQueueLength = queue.data.queue.length;
  assert(initialQueueLength >= 1, 'At least one task should be in queue initially');
  
  // Add third task (high priority) - should evict lowest priority
  const result3 = queue.enqueue({
    taskId: 'rt_third', backend: 'local', complexity: 8, type: 'code',
    result: { files: ['complex.js'], summary: 'Third task' }
  });
  
  assert(queue.data.queue.length <= 2, 'Queue should respect maxQueueSize (2) after multiple enqueues');
  
  const taskIds = queue.data.queue.map(item => item.originalTaskId);
  assert(!taskIds.includes('rt_first'), 'Lowest priority task should be removed');
  assert(taskIds.includes('rt_third'), 'Highest priority task should be kept');
}

function testRefinementQueueGetStats() {
  console.log('\n--- Refinement Queue: getStats returns correct counts ---');

  const { RefinementQueue } = require('./refinement-queue');
  const queue = new RefinementQueue();
  
  // Clear any existing queue state
  queue.data.queue = [];
  queue.data.completed = [];
  
  // Add some tasks
  queue.enqueue({
    taskId: 'rt_stats1', backend: 'local', complexity: 4, type: 'code',
    result: { summary: 'Stats test task 1' }
  });
  
  queue.enqueue({
    taskId: 'rt_stats2', backend: 'local', complexity: 5, type: 'code',
    result: { summary: 'Stats test task 2' }
  });
  
  const stats = queue.getStats();
  assert(stats.queueLength === 2, 'Queue length should be correct');
  assert(stats.totalRefined >= 0, 'Total refined should be non-negative');
  assert(stats.remainingThisHour >= 0, 'Remaining this hour should be non-negative');
  assert(typeof stats.avgImprovementScore === 'number', 'Average improvement score should be a number');
}

async function testRefinementQueueIdleCheck() {
  console.log('\n--- Refinement Queue: checkIdleAndRefine does nothing when queue is empty ---');

  const { RefinementQueue } = require('./refinement-queue');
  const queue = new RefinementQueue();
  
  // Clear any existing queue state
  queue.data.queue = [];
  queue.data.completed = [];
  
  // Empty queue test - needs to be async
  const result = await queue.checkIdleAndRefine();
  assert(result.processed === false, 'Should not process when queue is empty');
  assert(result.reason && result.reason.includes('No pending refinements'), 'Should report correct reason');
}

async function testRefinementQueueBusyCheck() {
  console.log('\n--- Refinement Queue: checkIdleAndRefine does nothing when backends are busy ---');

  const { RefinementQueue } = require('./refinement-queue');
  const queue = new RefinementQueue({ maxRefinementsPerHour: 0 }); // Set to 0 to simulate rate limit
  
  // Clear any existing queue state
  queue.data.queue = [];
  queue.data.completed = [];
  
  // Add a task
  queue.enqueue({
    taskId: 'rt_busy_test',
    backend: 'local',
    complexity: 5,
    type: 'code',
    result: { summary: 'Busy test task' }
  });
  
  const result = await queue.checkIdleAndRefine();
  assert(result.processed === false, 'Should not process when rate limited');
  assert(result.reason && result.reason.includes('rate limit'), 'Should report rate limit reason');
}

// ────────────────────────────────────────────────────────────────
// Run all tests
// ────────────────────────────────────────────────────────────────

async function runAllTests() {
  const startTime = Date.now();

  console.log('OpenClaw Task Router v2 — Test Suite');
  console.log('='.repeat(50));

  // Planner tests
  testPlannerSimpleTask();
  testPlannerComplexTask();
  testPlannerExpensiveTask();
  testPlannerBackwardCompatible();
  testCostEstimation();
  testFormatPlan();
  testHeuristics();
  testDependencyGraph();
  testParallelTimeEstimation();

  // Scheduler tests
  await testSchedulerEnqueue();
  await testSchedulerGetStatus();
  await testSchedulerGetETA();
  await testSchedulerCancel();
  await testSchedulerPauseResume();
  await testSchedulerOrdering();
  testSchedulerHealth();
  await testSchedulerEvents();

  // Multi-route logic tests
  testContextPassing();
  testFailureRecovery();

  // New module tests
  await testCircuitBreaker();
  await testDedup();
  await testSession();
  await testWarmup();
  testNotify();

  // Refinement Queue tests
  testRefinementQueueEnqueue();
  testRefinementQueueGetNext();
  testRefinementQueueComplexityFilter();
  testRefinementQueueStartRefinement();
  testRefinementQueueCompleteRefinement();
  testRefinementQueueSkipRefinement();
  testRefinementQueueMaxSize();
  testRefinementQueueGetStats();
  await testRefinementQueueIdleCheck();
  await testRefinementQueueBusyCheck();

  const duration = Date.now() - startTime;

  console.log('\n' + '='.repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed (${(duration / 1000).toFixed(1)}s)`);

  if (failures.length > 0) {
    console.log('\nFailed tests:');
    for (const f of failures) {
      console.log(`  - ${f}`);
    }
  }

  console.log();

  // Cleanup scheduler timer if running
  scheduler.stop();

  // Clean up test environment
  cleanupTestEnvironment();

  if (failed > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runAllTests()
    .then(() => {
      console.log('All tests passed!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Test suite crashed:', error);
      process.exit(1);
    });
}

module.exports = { runAllTests };
