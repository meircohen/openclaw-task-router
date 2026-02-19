/**
 * OpenClaw Session Continuity — Active Context Manager
 * Maintains cross-channel session state so Voice, Telegram, Slack,
 * and Dashboard all share a single "working memory" of what Oz is doing.
 *
 * Persists to data/active-context.json.
 */

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

const DATA_DIR = process.env.ROUTER_TEST_MODE ? process.env.ROUTER_TEST_DATA_DIR : path.join(__dirname, 'data');
const CONTEXT_FILE = path.join(DATA_DIR, 'active-context.json');
const MAX_RECENT_COMPLETED = 10;

// ─── Default empty context ──────────────────────────────────────────
function emptyContext() {
  return {
    lastUpdated: new Date().toISOString(),
    activeTasks: [],
    recentCompleted: [],
    channelHistory: {}
  };
}

// ─── In-memory state ────────────────────────────────────────────────
let context = null;
let loaded = false;

// ─── Persistence ────────────────────────────────────────────────────

async function ensureDataDir() {
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
  } catch (_) { /* already exists */ }
}

async function load() {
  await ensureDataDir();
  try {
    const raw = await fsp.readFile(CONTEXT_FILE, 'utf8');
    context = JSON.parse(raw);
  } catch (_) {
    context = emptyContext();
  }
  loaded = true;
  return context;
}

async function save() {
  if (!context) return;
  await ensureDataDir();
  context.lastUpdated = new Date().toISOString();
  await fsp.writeFile(CONTEXT_FILE, JSON.stringify(context, null, 2));
}

function ensureLoaded() {
  if (!loaded) {
    // Synchronous fallback for callers that don't await load()
    try {
      const raw = fs.readFileSync(CONTEXT_FILE, 'utf8');
      context = JSON.parse(raw);
    } catch (_) {
      context = emptyContext();
    }
    loaded = true;
  }
}

// ─── Exports ────────────────────────────────────────────────────────

/**
 * Get the full active context
 * @returns {Object} Full context object
 */
function getContext() {
  ensureLoaded();
  return { ...context };
}

/**
 * Get a single active task by ID
 * @param {string} taskId
 * @returns {Object|null} Task object or null
 */
function getActiveTask(taskId) {
  ensureLoaded();
  return context.activeTasks.find(t => t.taskId === taskId) || null;
}

/**
 * Update a task's state (partial merge)
 * @param {string} taskId
 * @param {Object} updates — fields to merge into the task
 * @returns {Promise<Object|null>} Updated task or null if not found
 */
async function updateTask(taskId, updates) {
  ensureLoaded();
  const task = context.activeTasks.find(t => t.taskId === taskId);
  if (!task) return null;

  Object.assign(task, updates, { lastUpdate: updates.lastUpdate || `updated at ${new Date().toISOString()}` });
  await save();
  return task;
}

/**
 * Register a new active task
 * @param {Object} task — must include taskId, description; other fields optional
 * @returns {Promise<Object>} The stored task object
 */
async function addTask(task) {
  ensureLoaded();

  const entry = {
    taskId: task.taskId,
    description: task.description || '',
    status: task.status || 'running',
    plan: task.plan || null,
    currentStep: task.currentStep || 0,
    totalSteps: task.totalSteps || 0,
    startedFrom: task.startedFrom || 'cli',
    startedAt: task.startedAt || new Date().toISOString(),
    eta: task.eta || null,
    lastUpdate: task.lastUpdate || 'task started',
    outputPath: task.outputPath || null
  };

  context.activeTasks.push(entry);
  await save();
  return entry;
}

/**
 * Mark a task as complete and move it to recentCompleted
 * @param {string} taskId
 * @param {Object} [result] — optional result metadata (duration, cost, outputPath, etc.)
 * @returns {Promise<Object|null>} Completed task entry or null
 */
async function completeTask(taskId, result = {}) {
  ensureLoaded();

  const idx = context.activeTasks.findIndex(t => t.taskId === taskId);
  if (idx === -1) return null;

  const task = context.activeTasks.splice(idx, 1)[0];
  task.status = 'complete';
  task.completedAt = new Date().toISOString();
  task.lastUpdate = 'task complete';
  if (result.outputPath) task.outputPath = result.outputPath;
  if (result.duration) task.duration = result.duration;
  if (result.cost) task.cost = result.cost;

  // Prepend to recentCompleted, trim to max
  context.recentCompleted.unshift(task);
  if (context.recentCompleted.length > MAX_RECENT_COMPLETED) {
    context.recentCompleted = context.recentCompleted.slice(0, MAX_RECENT_COMPLETED);
  }

  await save();
  return task;
}

/**
 * Mark a task as failed and move it to recentCompleted
 * @param {string} taskId
 * @param {string} error — error message
 * @returns {Promise<Object|null>}
 */
async function failTask(taskId, error) {
  ensureLoaded();

  const idx = context.activeTasks.findIndex(t => t.taskId === taskId);
  if (idx === -1) return null;

  const task = context.activeTasks.splice(idx, 1)[0];
  task.status = 'failed';
  task.completedAt = new Date().toISOString();
  task.lastUpdate = `failed: ${error}`;
  task.error = error;

  context.recentCompleted.unshift(task);
  if (context.recentCompleted.length > MAX_RECENT_COMPLETED) {
    context.recentCompleted = context.recentCompleted.slice(0, MAX_RECENT_COMPLETED);
  }

  await save();
  return task;
}

/**
 * Get the last-active state for a specific channel
 * @param {string} channel — 'voice' | 'telegram' | 'slack' | 'dashboard' | 'cli'
 * @returns {Object} Channel state { lastActive, lastTaskId }
 */
function getChannelState(channel) {
  ensureLoaded();
  return context.channelHistory[channel] || { lastActive: null, lastTaskId: null };
}

/**
 * Update a channel's last-active time and optionally link a task
 * @param {string} channel
 * @param {string} [taskId] — optional task ID to associate
 * @returns {Promise<void>}
 */
async function setChannelActive(channel, taskId) {
  ensureLoaded();

  context.channelHistory[channel] = {
    lastActive: new Date().toISOString(),
    lastTaskId: taskId || context.channelHistory[channel]?.lastTaskId || null
  };

  await save();
}

/**
 * Get summary suitable for voice / short-form channels
 * @returns {Object} { activeTasks: number, latestTask, recentlyCompleted: number }
 */
function getSummary() {
  ensureLoaded();

  const latest = context.activeTasks.length > 0 ? context.activeTasks[0] : null;

  return {
    activeTasks: context.activeTasks.length,
    latestTask: latest ? {
      taskId: latest.taskId,
      description: latest.description,
      status: latest.status,
      currentStep: latest.currentStep,
      totalSteps: latest.totalSteps,
      lastUpdate: latest.lastUpdate
    } : null,
    recentlyCompleted: context.recentCompleted.length
  };
}

module.exports = {
  load,
  save,
  getContext,
  getActiveTask,
  updateTask,
  addTask,
  completeTask,
  failTask,
  getChannelState,
  setChannelActive,
  getSummary
};
