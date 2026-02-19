const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

/**
 * OpenClaw Slack Notification Bridge
 * Mirrors the Telegram notification functionality for Slack via webhooks
 */

function getConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  } catch (_) {
    return { slackNotifications: { enabled: false } };
  }
}

/**
 * Send a message to Slack via webhook
 * @param {Object} payload - Slack webhook payload
 * @returns {Promise<boolean>} Whether message was sent successfully
 */
function sendSlackMessage(payload) {
  return new Promise((resolve) => {
    const config = getConfig();
    const slackConfig = config.slackNotifications;
    
    if (!slackConfig?.enabled || !slackConfig.webhookUrl) {
      console.log('[SLACK] Notifications disabled or webhook URL not configured');
      resolve(false);
      return;
    }

    try {
      const url = new URL(slackConfig.webhookUrl);
      const requestModule = url.protocol === 'https:' ? https : http;
      
      const data = JSON.stringify({
        channel: slackConfig.channel,
        username: 'OpenClaw Router',
        icon_emoji: ':robot_face:',
        ...payload
      });

      const options = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data)
        },
        timeout: 15000
      };

      const req = requestModule.request(options, (res) => {
        const success = res.statusCode === 200;
        if (!success) {
          console.error(`[SLACK] HTTP ${res.statusCode}: ${res.statusMessage}`);
        }
        resolve(success);
      });

      req.on('error', (err) => {
        console.error('[SLACK] Request error:', err.message);
        resolve(false);
      });

      req.on('timeout', () => {
        console.error('[SLACK] Request timeout');
        req.destroy();
        resolve(false);
      });

      req.write(data);
      req.end();
      
    } catch (err) {
      console.error('[SLACK] Failed to send message:', err.message);
      resolve(false);
    }
  });
}

/**
 * Format backend labels for display
 */
function formatBackendLabel(backend) {
  const labels = {
    'claude-code': 'Claude Code',
    'codex': 'Codex',
    'api': 'API',
    'local': 'Local'
  };
  return labels[backend] || backend;
}

/**
 * Format cost labels for display
 */
function formatCostLabel(step) {
  const isSubscription = ['claude-code', 'codex', 'local'].includes(step.backend);
  if (isSubscription) {
    return `subscription, ~${step.estimatedMinutes} min`;
  }
  return `$${step.estimatedCost.toFixed(2)}, ~${step.estimatedMinutes} min`;
}

/**
 * Send a plan approval request to Slack
 * @param {Object} plan - Plan from planner.decompose()
 * @param {Object} costBreakdown - Cost breakdown from planner.estimateCost()
 * @returns {Promise<boolean>} Whether message was sent
 */
async function sendPlanApproval(plan, costBreakdown) {
  const taskDesc = (plan.task?.description || 'Unknown task').substring(0, 80);

  // Build step descriptions
  const steps = plan.steps.map((step, i) => {
    const label = formatBackendLabel(step.backend);
    const cost = formatCostLabel(step);
    return `Step ${i + 1}: ${step.description.substring(0, 60)} → ${label} (${cost})`;
  }).join('\n');

  const apiCost = costBreakdown.totalApiCost.toFixed(2);
  const subMinutes = costBreakdown.totalSubscriptionMinutes;
  const totalMinutes = costBreakdown.totalEstimatedMinutes;

  // Build action buttons/links
  const config = getConfig();
  const dashboardPort = config.dashboard?.port || 3457;
  const authToken = config.dashboard?.authToken || '';
  
  const baseUrl = `http://localhost:${dashboardPort}`;
  const approveUrl = `${baseUrl}/api/plan/${plan.id}/approve?token=${authToken}`;
  const cancelUrl = `${baseUrl}/api/plan/${plan.id}/cancel?token=${authToken}`;
  const dashboardUrl = `${baseUrl}/?token=${authToken}#plan/${plan.id}`;

  const payload = {
    text: `Plan Approval Required`,
    attachments: [
      {
        color: 'warning',
        title: `"${taskDesc}"`,
        fields: [
          {
            title: 'Execution Plan',
            value: steps,
            short: false
          },
          {
            title: 'Cost Estimate',
            value: `$${apiCost} API + ~${subMinutes} min subscription`,
            short: true
          },
          {
            title: 'Total Time',
            value: `~${totalMinutes} min`,
            short: true
          }
        ],
        actions: [
          {
            type: 'button',
            text: '✅ Approve',
            url: approveUrl,
            style: 'primary'
          },
          {
            type: 'button',
            text: '❌ Cancel',
            url: cancelUrl,
            style: 'danger'
          },
          {
            type: 'button',
            text: '📊 Dashboard',
            url: dashboardUrl
          }
        ],
        footer: 'OpenClaw Task Router',
        ts: Math.floor(Date.now() / 1000)
      }
    ]
  };

  return await sendSlackMessage(payload);
}

/**
 * Send a progress update to Slack
 * @param {string} taskId - Task/plan identifier
 * @param {number} currentStep - Current step number (1-based)
 * @param {number} totalSteps - Total number of steps
 * @param {string} message - Status message
 * @param {Object} [details] - Optional details { taskDescription, stepDescriptions, eta }
 */
async function sendProgress(taskId, currentStep, totalSteps, message, details = {}) {
  const taskDesc = (details.taskDescription || taskId).substring(0, 80);
  
  let progressText = `Step ${currentStep}/${totalSteps}: ${message}`;
  
  if (details.stepDescriptions && Array.isArray(details.stepDescriptions)) {
    const stepProgress = details.stepDescriptions.map((desc, i) => {
      const stepNum = i + 1;
      let icon;
      if (stepNum < currentStep) {
        icon = '✅';
      } else if (stepNum === currentStep) {
        icon = '⚡';
      } else {
        icon = '⏳';
      }
      return `${icon} Step ${stepNum}/${totalSteps}: ${desc.substring(0, 60)}`;
    }).join('\n');
    
    progressText = stepProgress;
  }

  const payload = {
    text: `Task Progress Update`,
    attachments: [
      {
        color: 'good',
        title: `"${taskDesc}"`,
        text: progressText,
        fields: details.eta ? [
          {
            title: 'ETA',
            value: `~${details.eta} min remaining`,
            short: true
          }
        ] : [],
        footer: 'OpenClaw Task Router',
        ts: Math.floor(Date.now() / 1000)
      }
    ]
  };

  return await sendSlackMessage(payload);
}

/**
 * Send a task completion notification to Slack
 * @param {string} taskId - Task/plan identifier
 * @param {Object} results - Execution results
 */
async function sendCompletion(taskId, results) {
  const taskDesc = (results.taskDescription || taskId).substring(0, 80);
  const durationMin = results.duration ? Math.round(results.duration / 60000) : '?';
  const cost = typeof results.totalCost === 'number' ? `$${results.totalCost.toFixed(2)} API` : 'subscription only';

  const fields = [
    {
      title: 'Duration',
      value: `${durationMin} min`,
      short: true
    },
    {
      title: 'Cost',
      value: cost,
      short: true
    }
  ];

  if (results.completedSteps !== undefined && results.totalSteps !== undefined) {
    fields.push({
      title: 'Steps Completed',
      value: `${results.completedSteps}/${results.totalSteps}`,
      short: true
    });
  }

  if (results.outputPath) {
    fields.push({
      title: 'Output',
      value: results.outputPath,
      short: false
    });
  }

  const payload = {
    text: `Task Completed Successfully`,
    attachments: [
      {
        color: 'good',
        title: `"${taskDesc}"`,
        fields,
        footer: 'OpenClaw Task Router',
        ts: Math.floor(Date.now() / 1000)
      }
    ]
  };

  return await sendSlackMessage(payload);
}

/**
 * Send an error notification to Slack
 * @param {string} taskId - Task/plan identifier
 * @param {Error|string} error - Error object or message
 */
async function sendError(taskId, error) {
  const errMsg = error instanceof Error ? error.message : String(error);
  const shortId = taskId.substring(0, 30);

  const payload = {
    text: `Task Failed`,
    attachments: [
      {
        color: 'danger',
        title: `Task: ${shortId}`,
        text: `Error: ${errMsg.substring(0, 200)}`,
        footer: 'OpenClaw Task Router',
        ts: Math.floor(Date.now() / 1000)
      }
    ]
  };

  return await sendSlackMessage(payload);
}

module.exports = {
  sendPlanApproval,
  sendProgress,
  sendCompletion,
  sendError
};