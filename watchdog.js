#!/usr/bin/env node

/**
 * OpenClaw Router Auto-Failover Watchdog
 * Monitors backend health and automatically adjusts routing scores for resilience.
 * Runs as a standalone PM2-managed process.
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const http = require('http');

const DATA_DIR = path.join(__dirname, 'data');
const MONITOR_FILE = path.join(DATA_DIR, 'monitor.json');
const WATCHDOG_LOG_FILE = path.join(DATA_DIR, 'watchdog-log.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');

// ─── Configuration ──────────────────────────────────────────────────
const HEALTH_CHECK_INTERVAL = 60 * 1000; // 60 seconds
const BACKEND_TIMEOUT = 10000; // 10 seconds per health check

// ─── State ──────────────────────────────────────────────────────────
let config = {};
let watchdogState = {
  backends: {
    claudeCode: { 
      isHealthy: true, 
      lastHealthy: null, 
      lastDown: null,
      uptimeMinutes: 0,
      downtimeMinutes: 0,
      totalChecks: 0,
      healthyChecks: 0,
      consecutiveFailures: 0
    },
    codex: { 
      isHealthy: true, 
      lastHealthy: null, 
      lastDown: null,
      uptimeMinutes: 0,
      downtimeMinutes: 0,
      totalChecks: 0,
      healthyChecks: 0,
      consecutiveFailures: 0
    },
    local: { 
      isHealthy: true, 
      lastHealthy: null, 
      lastDown: null,
      uptimeMinutes: 0,
      downtimeMinutes: 0,
      totalChecks: 0,
      healthyChecks: 0,
      consecutiveFailures: 0
    },
    api: { 
      isHealthy: true, 
      lastHealthy: null, 
      lastDown: null,
      uptimeMinutes: 0,
      downtimeMinutes: 0,
      totalChecks: 0,
      healthyChecks: 0,
      consecutiveFailures: 0
    }
  },
  startTime: new Date().toISOString(),
  lastCheck: null
};

// ─── Utilities ──────────────────────────────────────────────────────

async function ensureDataDir() {
  try { 
    await fsp.mkdir(DATA_DIR, { recursive: true }); 
  } catch (_) {}
}

async function loadConfig() {
  try {
    const configData = await fsp.readFile(CONFIG_FILE, 'utf8');
    config = JSON.parse(configData);
  } catch (err) {
    console.error('[WATCHDOG] Failed to load config:', err.message);
    process.exit(1);
  }
}

async function loadWatchdogState() {
  try {
    const stateData = await fsp.readFile(WATCHDOG_LOG_FILE, 'utf8');
    const loaded = JSON.parse(stateData);
    // Merge with defaults to ensure all backends are present
    watchdogState = { ...watchdogState, ...loaded };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('[WATCHDOG] Could not load state:', err.message);
    }
    // Use defaults
  }
}

async function saveWatchdogState() {
  await ensureDataDir();
  try {
    await fsp.writeFile(WATCHDOG_LOG_FILE, JSON.stringify(watchdogState, null, 2));
  } catch (err) {
    console.error('[WATCHDOG] Failed to save state:', err.message);
  }
}

async function logEvent(backend, event, details = {}) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    backend,
    event, // 'down', 'recovered', 'check_failed', 'check_ok'
    details
  };

  // Append to the watchdog log as event stream
  try {
    const logFile = path.join(DATA_DIR, 'watchdog-events.json');
    let events = [];
    
    try {
      const existing = await fsp.readFile(logFile, 'utf8');
      events = JSON.parse(existing);
    } catch (_) {
      // File doesn't exist, start with empty array
    }
    
    events.push(logEntry);
    
    // Keep only last 1000 events
    if (events.length > 1000) {
      events = events.slice(-1000);
    }
    
    await fsp.writeFile(logFile, JSON.stringify(events, null, 2));
  } catch (err) {
    console.error('[WATCHDOG] Failed to log event:', err.message);
  }

  console.log(`[WATCHDOG] ${backend}: ${event} - ${JSON.stringify(details)}`);
}

async function sendAlert(message, isRecovery = false) {
  try {
    const emoji = isRecovery ? '✅' : '⚠️';
    const cmd = `openclaw system event --text "${emoji} ${message}" --mode now`;
    execSync(cmd, { timeout: 5000, stdio: 'ignore' });
    console.log(`[WATCHDOG] Alert sent: ${message}`);
  } catch (err) {
    console.error('[WATCHDOG] Failed to send alert:', err.message);
  }
}

async function updateAdaptiveScore(backend, score) {
  try {
    let monitorData = {};
    
    try {
      const monitorStr = await fsp.readFile(MONITOR_FILE, 'utf8');
      monitorData = JSON.parse(monitorStr);
    } catch (err) {
      console.warn('[WATCHDOG] Could not load monitor.json, creating new structure');
      monitorData = {
        backends: {
          claudeCode: { results: [], totalTasks: 0, successRate: 0, avgDuration: 0, avgTokens: 0 },
          codex: { results: [], totalTasks: 0, successRate: 0, avgDuration: 0, avgTokens: 0 },
          api: { results: [], totalTasks: 0, successRate: 0, avgDuration: 0, avgTokens: 0 },
          local: { results: [], totalTasks: 0, successRate: 0, avgDuration: 0, avgTokens: 0 }
        },
        lastUpdated: new Date().toISOString()
      };
    }

    // Ensure backend exists
    if (!monitorData.backends[backend]) {
      monitorData.backends[backend] = { results: [], totalTasks: 0, successRate: 0, avgDuration: 0, avgTokens: 0 };
    }

    // Store the watchdog override score
    monitorData.backends[backend].watchdogScore = score;
    monitorData.backends[backend].watchdogTimestamp = new Date().toISOString();
    monitorData.lastUpdated = new Date().toISOString();

    await fsp.writeFile(MONITOR_FILE, JSON.stringify(monitorData, null, 2));
    console.log(`[WATCHDOG] Updated adaptive score for ${backend} to ${score}`);
  } catch (err) {
    console.error('[WATCHDOG] Failed to update adaptive score:', err.message);
  }
}

// ─── Health Check Functions ─────────────────────────────────────────

async function checkClaudeCode() {
  const backend = 'claudeCode';
  
  try {
    const output = execSync('which claude && claude --version', {
      timeout: BACKEND_TIMEOUT,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    if (output && output.includes('Claude')) {
      return { healthy: true, version: output.split('\n').pop() };
    } else {
      return { healthy: false, error: 'Invalid response from claude command' };
    }
  } catch (err) {
    return { healthy: false, error: err.message };
  }
}

async function checkCodex() {
  const backend = 'codex';
  
  try {
    const output = execSync('which codex && codex --version', {
      timeout: BACKEND_TIMEOUT,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    if (output && output.includes('codex')) {
      return { healthy: true, version: output.split('\n').pop() };
    } else {
      return { healthy: false, error: 'Invalid response from codex command' };
    }
  } catch (err) {
    return { healthy: false, error: err.message };
  }
}

async function checkOllama() {
  const backend = 'local';
  const ollamaUrl = config?.backends?.local?.ollamaUrl || 'http://localhost:11434';

  return new Promise((resolve) => {
    const url = new URL('/api/tags', ollamaUrl);

    const req = http.get(url, { timeout: BACKEND_TIMEOUT }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          const modelCount = Array.isArray(data.models) ? data.models.length : 0;
          resolve({ 
            healthy: true, 
            version: `${modelCount} models loaded`,
            models: (data.models || []).map(m => m.name) 
          });
        } catch (parseErr) {
          resolve({ healthy: false, error: 'Invalid JSON response from Ollama' });
        }
      });
    });

    req.on('error', (err) => {
      resolve({ healthy: false, error: err.message });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ healthy: false, error: 'Connection timeout' });
    });
  });
}

async function checkAPI() {
  const backend = 'api';
  
  try {
    // Check if API configuration is valid
    const apiConfig = config?.backends?.api;
    if (!apiConfig || !apiConfig.enabled) {
      return { healthy: false, error: 'API backend disabled in config' };
    }

    // Check if required API settings are present
    if (!apiConfig.defaultModel) {
      return { healthy: false, error: 'No default model configured for API backend' };
    }

    // For now, we assume API is healthy if config is valid
    // In the future, we could make a test API call here
    return { 
      healthy: true, 
      version: `API configured with ${apiConfig.defaultModel}`,
      dailyBudget: apiConfig.dailyBudgetUsd || 'unlimited'
    };
  } catch (err) {
    return { healthy: false, error: err.message };
  }
}

// ─── Main Health Check Cycle ───────────────────────────────────────

async function performHealthCheck(backend) {
  const backendState = watchdogState.backends[backend];
  backendState.totalChecks++;

  let result;
  
  switch (backend) {
    case 'claudeCode':
      result = await checkClaudeCode();
      break;
    case 'codex':
      result = await checkCodex();
      break;
    case 'local':
      result = await checkOllama();
      break;
    case 'api':
      result = await checkAPI();
      break;
    default:
      console.warn(`[WATCHDOG] Unknown backend: ${backend}`);
      return;
  }

  const wasHealthy = backendState.isHealthy;
  const isHealthy = result.healthy;

  // Update health state
  if (isHealthy) {
    backendState.isHealthy = true;
    backendState.lastHealthy = new Date().toISOString();
    backendState.healthyChecks++;
    backendState.consecutiveFailures = 0;
    
    await logEvent(backend, 'check_ok', { version: result.version });
    
    // If this is a recovery
    if (!wasHealthy) {
      // Restore adaptive score to seed value from config
      const seedScore = config.routing?.initialScores?.[backend] || 50;
      await updateAdaptiveScore(backend, seedScore);
      await sendAlert(`${backend} backend has RECOVERED`, true);
      await logEvent(backend, 'recovered', { 
        seedScore,
        downtimeMinutes: backendState.downtimeMinutes 
      });
    }
  } else {
    backendState.consecutiveFailures++;
    
    await logEvent(backend, 'check_failed', { 
      error: result.error,
      consecutiveFailures: backendState.consecutiveFailures 
    });
    
    // If this is the first failure
    if (wasHealthy) {
      backendState.isHealthy = false;
      backendState.lastDown = new Date().toISOString();
      
      // Set adaptive score to 0
      await updateAdaptiveScore(backend, 0);
      await sendAlert(`${backend} backend is DOWN: ${result.error}`);
      await logEvent(backend, 'down', { error: result.error });
    }
  }

  // Update uptime/downtime tracking
  const currentTime = new Date();
  if (backendState.lastHealthy && backendState.lastDown) {
    const lastHealthyTime = new Date(backendState.lastHealthy);
    const lastDownTime = new Date(backendState.lastDown);
    
    if (isHealthy && lastDownTime > lastHealthyTime) {
      // Currently healthy, was down - add to downtime
      const downMinutes = Math.floor((currentTime - lastDownTime) / (1000 * 60));
      backendState.downtimeMinutes += downMinutes;
    } else if (!isHealthy && lastHealthyTime > (new Date(backendState.lastDown || 0))) {
      // Currently down, was healthy - add to uptime  
      const upMinutes = Math.floor((currentTime - lastHealthyTime) / (1000 * 60));
      backendState.uptimeMinutes += upMinutes;
    }
  }
}

async function performAllHealthChecks() {
  console.log('[WATCHDOG] Starting health check cycle...');
  watchdogState.lastCheck = new Date().toISOString();

  const backends = Object.keys(watchdogState.backends);
  
  // Run all health checks in parallel
  await Promise.allSettled(
    backends.map(backend => performHealthCheck(backend))
  );

  // Calculate uptime percentages
  for (const backend of backends) {
    const state = watchdogState.backends[backend];
    const totalMinutes = state.uptimeMinutes + state.downtimeMinutes;
    state.uptimePercentage = totalMinutes > 0 ? 
      ((state.uptimeMinutes / totalMinutes) * 100).toFixed(2) : '100.00';
  }

  await saveWatchdogState();
  console.log('[WATCHDOG] Health check cycle completed');
}

// ─── API for Dashboard Integration ──────────────────────────────────

function getWatchdogStats() {
  const stats = {
    ...watchdogState,
    uptimeStats: {}
  };

  // Calculate uptime stats for each backend
  for (const [backend, state] of Object.entries(watchdogState.backends)) {
    stats.uptimeStats[backend] = {
      uptimePercentage: parseFloat(state.uptimePercentage || '100.00'),
      totalChecks: state.totalChecks,
      healthyChecks: state.healthyChecks,
      consecutiveFailures: state.consecutiveFailures,
      isCurrentlyHealthy: state.isHealthy,
      lastHealthy: state.lastHealthy,
      lastDown: state.lastDown
    };
  }

  return stats;
}

// ─── Main Entry Point ───────────────────────────────────────────────

async function main() {
  console.log('[WATCHDOG] OpenClaw Router Auto-Failover Watchdog starting...');
  
  await ensureDataDir();
  await loadConfig();
  await loadWatchdogState();

  console.log(`[WATCHDOG] Monitoring ${Object.keys(watchdogState.backends).length} backends every ${HEALTH_CHECK_INTERVAL / 1000}s`);
  console.log(`[WATCHDOG] Backends: ${Object.keys(watchdogState.backends).join(', ')}`);

  // Perform initial health check
  await performAllHealthChecks();

  // Start periodic health checks
  setInterval(async () => {
    try {
      await performAllHealthChecks();
    } catch (err) {
      console.error('[WATCHDOG] Error in health check cycle:', err.message);
    }
  }, HEALTH_CHECK_INTERVAL);

  console.log('[WATCHDOG] Watchdog is running');
}

// ─── Module Exports ──────────────────────────────────────────────────

if (require.main === module) {
  // Running as standalone script
  main().catch(err => {
    console.error('[WATCHDOG] Fatal error:', err.message);
    process.exit(1);
  });

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('[WATCHDOG] Received SIGINT, shutting down...');
    saveWatchdogState().then(() => process.exit(0))
      .catch(err => console.error('[WATCHDOG] Error:', err.message));
  });

  process.on('SIGTERM', () => {
    console.log('[WATCHDOG] Received SIGTERM, shutting down...');
    saveWatchdogState().then(() => process.exit(0))
      .catch(err => console.error('[WATCHDOG] Error:', err.message));
  });
} else {
  // Being required as module
  module.exports = {
    getWatchdogStats,
    performAllHealthChecks,
    performHealthCheck,
    loadConfig,
    loadWatchdogState,
    saveWatchdogState
  };
}