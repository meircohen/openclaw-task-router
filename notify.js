const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Lazy load Slack notifications
let slackNotify = null;
function getSlackNotify() {
  if (!slackNotify) {
    try {
      slackNotify = require('./slack-notify');
    } catch (err) {
      console.warn('[NOTIFY] Slack notifications not available:', err.message);
      slackNotify = {
        sendPlanApproval: () => false,
        sendProgress: () => false,
        sendCompletion: () => false,
        sendError: () => false
      };
    }
  }
  return slackNotify;
}

/**
 * OpenClaw Notification Bridge
 * Sends plan approvals, progress updates, completions, and errors to Telegram
 * via `openclaw system event`. Manages pending plans with auto-expiry.
 */

const dataDir = process.env.ROUTER_TEST_MODE ? process.env.ROUTER_TEST_DATA_DIR : path.join(__dirname, 'data');
const PENDING_PLANS_PATH = path.join(dataDir, 'pending-plans.json');
const PLAN_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes

// ─── Pending Plans Store ──────────────────────────────────────────

function loadPendingPlans() {
  try {
    const raw = fs.readFileSync(PENDING_PLANS_PATH, 'utf8');
    const plans = JSON.parse(raw);
    // Prune expired plans
    const now = Date.now();
    const active = {};
    let pruned = false;
    for (const [id, entry] of Object.entries(plans)) {
      if (now - new Date(entry.createdAt).getTime() < PLAN_EXPIRY_MS) {
        active[id] = entry;
      } else {
        pruned = true;
      }
    }
    if (pruned) {
      savePendingPlans(active);
    }
    return active;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[NOTIFY] Error loading pending plans:', err.message);
    }
    return {};
  }
}

function savePendingPlans(plans) {
  try {
    const dir = path.dirname(PENDING_PLANS_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(PENDING_PLANS_PATH, JSON.stringify(plans, null, 2));
  } catch (err) {
    console.error('[NOTIFY] Error saving pending plans:', err.message);
  }
}

function storePendingPlan(planId, plan, costBreakdown) {
  const plans = loadPendingPlans();
  plans[planId] = {
    plan,
    costBreakdown,
    createdAt: new Date().toISOString(),
    status: 'pending'
  };
  savePendingPlans(plans);
}

function getPendingPlan(planId) {
  const plans = loadPendingPlans();
  return plans[planId] || null;
}

function removePendingPlan(planId) {
  const plans = loadPendingPlans();
  const existed = !!plans[planId];
  delete plans[planId];
  savePendingPlans(plans);
  return existed;
}

function getAllPendingPlans() {
  return loadPendingPlans();
}

// ─── Message Sending ──────────────────────────────────────────────

function sendMessage(text) {
  const config = getConfig();
  if (!config.notifications?.enabled) {
    console.log('[NOTIFY] Notifications disabled, skipping');
    return false;
  }

  try {
    // Escape single quotes for shell safety
    const escaped = text.replace(/'/g, "'\\''");
    execSync(`openclaw system event --text '${escaped}' --mode now`, {
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return true;
  } catch (err) {
    console.error('[NOTIFY] Failed to send message:', err.message);
    return false;
  }
}

function getConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  } catch (_) {
    return { notifications: { enabled: false } };
  }
}

// ─── Message Formatting ───────────────────────────────────────────

function formatBackendLabel(backend) {
  const labels = {
    'claude-code': 'Claude Code',
    'codex': 'Codex',
    'api': 'API',
    'local': 'Local'
  };
  return labels[backend] || backend;
}

function formatCostLabel(step) {
  const isSubscription = ['claude-code', 'codex', 'local'].includes(step.backend);
  if (isSubscription) {
    return `subscription, ~${step.estimatedMinutes} min`;
  }
  return `$${step.estimatedCost.toFixed(2)}, ~${step.estimatedMinutes} min`;
}

// ─── Public API ───────────────────────────────────────────────────

/**
 * Send a plan approval request to Telegram and store as pending
 * @param {Object} plan - Plan from planner.decompose()
 * @param {Object} costBreakdown - Cost breakdown from planner.estimateCost()
 * @returns {boolean} Whether message was sent
 */
function sendPlanApproval(plan, costBreakdown) {
  const taskDesc = (plan.task?.description || 'Unknown task').substring(0, 80);

  const lines = [];
  lines.push(`Plan Approval -- "${taskDesc}"`);
  lines.push('');

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    const label = formatBackendLabel(step.backend);
    const cost = formatCostLabel(step);
    lines.push(`Step ${i + 1}: ${step.description.substring(0, 60)} -> ${label} (${cost})`);
  }

  lines.push('');

  const apiCost = costBreakdown.totalApiCost.toFixed(2);
  const subMinutes = costBreakdown.totalSubscriptionMinutes;
  const totalMinutes = costBreakdown.totalEstimatedMinutes;

  lines.push(`Est. cost: $${apiCost} API + ~${subMinutes} min subscription`);
  lines.push(`Total time: ~${totalMinutes} min`);
  lines.push('');

  // Add clickable action URLs since OpenClaw doesn't support inline buttons
  const config = getConfig();
  const dashboardPort = config.dashboard?.port || 3457;
  const authToken = config.dashboard?.authToken || '';
  
  const baseUrl = `http://localhost:${dashboardPort}`;
  const approveUrl = `${baseUrl}/api/plan/${plan.id}/approve?token=${authToken}`;
  const cancelUrl = `${baseUrl}/api/plan/${plan.id}/cancel?token=${authToken}`;
  const dashboardUrl = `${baseUrl}/?token=${authToken}#plan/${plan.id}`;

  lines.push('Actions:');
  lines.push(`✅ Approve: ${approveUrl}`);
  lines.push(`❌ Cancel: ${cancelUrl}`);
  lines.push(`📊 Dashboard: ${dashboardUrl}`);
  lines.push('');
  lines.push('Or reply "approve" to execute the plan.');

  // Store as pending
  storePendingPlan(plan.id, plan, costBreakdown);

  const telegramSent = sendMessage(lines.join('\n'));
  
  // Also send to Slack if enabled
  const slackConfig = getConfig();
  if (slackConfig.slackNotifications?.enabled) {
    getSlackNotify().sendPlanApproval(plan, costBreakdown);
  }

  return telegramSent;
}

/**
 * Send a progress update
 * @param {string} taskId - Task/plan identifier
 * @param {number} currentStep - Current step number (1-based)
 * @param {number} totalSteps - Total number of steps
 * @param {string} message - Status message
 * @param {Object} [details] - Optional details { taskDescription, stepDescriptions, eta }
 */
function sendProgress(taskId, currentStep, totalSteps, message, details = {}) {
  const taskDesc = (details.taskDescription || taskId).substring(0, 80);

  const lines = [];
  lines.push(`Task Progress -- "${taskDesc}"`);

  if (details.stepDescriptions && Array.isArray(details.stepDescriptions)) {
    for (let i = 0; i < details.stepDescriptions.length; i++) {
      const stepNum = i + 1;
      let icon;
      if (stepNum < currentStep) {
        icon = '[done]';
      } else if (stepNum === currentStep) {
        icon = '[running]';
      } else {
        icon = '[pending]';
      }
      lines.push(`${icon} Step ${stepNum}/${totalSteps}: ${details.stepDescriptions[i].substring(0, 60)}`);
    }
  } else {
    lines.push(`Step ${currentStep}/${totalSteps}: ${message}`);
  }

  if (details.eta) {
    lines.push(`ETA: ~${details.eta} min remaining`);
  }

  const telegramSent = sendMessage(lines.join('\n'));
  
  // Also send to Slack if enabled
  const slackConfig = getConfig();
  if (slackConfig.slackNotifications?.enabled) {
    getSlackNotify().sendProgress(taskId, currentStep, totalSteps, message, details);
  }

  return telegramSent;
}

/**
 * Send a task completion notification
 * @param {string} taskId - Task/plan identifier
 * @param {Object} results - Execution results
 */
function sendCompletion(taskId, results) {
  const lines = [];

  const taskDesc = (results.taskDescription || taskId).substring(0, 80);
  const durationMin = results.duration ? Math.round(results.duration / 60000) : '?';
  const cost = typeof results.totalCost === 'number' ? `$${results.totalCost.toFixed(2)} API` : 'subscription only';

  lines.push(`Task Complete -- "${taskDesc}"`);
  lines.push(`${durationMin} min | ${cost}`);

  if (results.completedSteps !== undefined && results.totalSteps !== undefined) {
    lines.push(`Steps: ${results.completedSteps}/${results.totalSteps} completed`);
  }

  if (results.outputPath) {
    lines.push(`Output: ${results.outputPath}`);
  }

  // Clean up pending plan if it exists
  removePendingPlan(taskId);

  const telegramSent = sendMessage(lines.join('\n'));
  
  // Also send to Slack if enabled
  const slackConfig = getConfig();
  if (slackConfig.slackNotifications?.enabled) {
    getSlackNotify().sendCompletion(taskId, results);
  }

  return telegramSent;
}

/**
 * Send an error notification
 * @param {string} taskId - Task/plan identifier
 * @param {Error|string} error - Error object or message
 */
function sendError(taskId, error) {
  const errMsg = error instanceof Error ? error.message : String(error);
  const shortId = taskId.substring(0, 30);

  const lines = [];
  lines.push(`Task Error -- ${shortId}`);
  lines.push(`Error: ${errMsg.substring(0, 200)}`);

  const telegramSent = sendMessage(lines.join('\n'));
  
  // Also send to Slack if enabled
  const slackConfig = getConfig();
  if (slackConfig.slackNotifications?.enabled) {
    getSlackNotify().sendError(taskId, error);
  }

  return telegramSent;
}

// ─── Scheduler Event Wiring ───────────────────────────────────────

/**
 * Wire notification handlers to a scheduler's EventEmitter
 * @param {EventEmitter} scheduler - The subscription scheduler
 */
function wireSchedulerEvents(scheduler) {
  scheduler.on('progress', (taskId, step, total, message) => {
    sendProgress(taskId, step, total, message);
  });

  scheduler.on('complete', (taskId, result) => {
    sendCompletion(taskId, {
      taskDescription: result?.response?.substring(0, 80) || taskId,
      duration: result?.duration,
      totalCost: result?.cost,
      outputPath: result?.outputPath
    });
  });

  scheduler.on('error', (taskId, error) => {
    sendError(taskId, error);
  });
}

// ─── Exports ──────────────────────────────────────────────────────

module.exports = {
  sendPlanApproval,
  sendProgress,
  sendCompletion,
  sendError,
  wireSchedulerEvents,
  // Pending plan management
  storePendingPlan,
  getPendingPlan,
  removePendingPlan,
  getAllPendingPlans
};
