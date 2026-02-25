#!/usr/bin/env node
/**
 * Router CLI — Entry point for all routed work.
 * Usage:
 *   node cli.js route "Build a REST API" [--force claude|codex|local|api] [--urgency high|normal|low] [--plan-only]
 *   node cli.js plan "OCR 1000 pages and analyze" 
 *   node cli.js approve <taskId>
 *   node cli.js cancel <taskId>
 *   node cli.js status
 *   node cli.js queue
 */

const router = require('./index');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const command = args[0];

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--force' && args[i + 1]) flags.force = args[++i];
    if (args[i] === '--urgency' && args[i + 1]) flags.urgency = args[++i];
    if (args[i] === '--plan-only') flags.planOnly = true;
    if (args[i] === '--output' && args[i + 1]) flags.outputPath = args[++i];
    if (args[i] === '--backend' && args[i + 1]) flags.backend = args[++i];
    if (args[i] === '--from' && args[i + 1]) flags.from = args[++i];
    if (args[i] === '--to' && args[i + 1]) flags.to = args[++i];
    if (args[i] === '--limit' && args[i + 1]) flags.limit = parseInt(args[++i], 10);
  }
  return flags;
}

async function searchHistory(keyword, flags = {}) {
  try {
    const monitorPath = path.join(__dirname, 'data', 'monitor.json');
    if (!fs.existsSync(monitorPath)) {
      console.error('Monitor data not found');
      return;
    }

    const monitorData = JSON.parse(fs.readFileSync(monitorPath, 'utf8'));
    const allResults = [];

    // Extract all results from all backends
    if (monitorData.backends) {
      Object.keys(monitorData.backends).forEach(backend => {
        if (monitorData.backends[backend] && monitorData.backends[backend].results) {
          monitorData.backends[backend].results.forEach(result => {
            allResults.push({ ...result, backend });
          });
        }
      });
    }

    // Filter results
    let filteredResults = allResults.filter(result => {
      // Keyword search in available text fields
      const searchableText = [
        result.description,
        result.taskType,
        result.task,
        result.command,
        result.id
      ].filter(Boolean).join(' ').toLowerCase();
      
      if (!searchableText.includes(keyword.toLowerCase())) {
        return false;
      }

      // Backend filter
      if (flags.backend && result.backend !== flags.backend) {
        return false;
      }

      // Date filters
      if (flags.from || flags.to) {
        const resultDate = new Date(result.timestamp);
        if (flags.from && resultDate < new Date(flags.from + 'T00:00:00.000Z')) {
          return false;
        }
        if (flags.to && resultDate > new Date(flags.to + 'T23:59:59.999Z')) {
          return false;
        }
      }

      return true;
    });

    // Sort by timestamp (newest first)
    filteredResults.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    // Apply limit
    const limit = flags.limit || 20;
    filteredResults = filteredResults.slice(0, limit);

    if (filteredResults.length === 0) {
      console.log('No matching tasks found.');
      return;
    }

    // Display results
    console.log(`Found ${filteredResults.length} matching tasks:\n`);
    filteredResults.forEach(result => {
      const timestamp = new Date(result.timestamp).toLocaleString();
      const description = result.description || result.task || result.taskType || 'No description';
      const truncatedDesc = truncateText(description, 60);
      const backend = result.backend || 'unknown';
      const duration = result.duration ? `${Math.round(result.duration)}ms` : (result.durationMs ? `${Math.round(result.durationMs)}ms` : 'n/a');
      const cost = result.costUsd ? `$${result.costUsd.toFixed(4)}` : 'n/a';
      const status = result.success ? '✅' : '❌';
      const tokens = result.tokens || 0;

      console.log(`${status} ${timestamp} | ${backend}`);
      console.log(`   ${truncatedDesc}`);
      console.log(`   Duration: ${duration} | Cost: ${cost} | Tokens: ${tokens}`);
      console.log('');
    });

    console.log(`Showing ${filteredResults.length} of ${allResults.length} total tasks`);
  } catch (error) {
    console.error('Error searching history:', error.message);
  }
}

function truncateText(text, maxLength) {
  if (!text) return '';
  return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
}

async function showDashboard() {
  try {
    const ledger = require('./ledger');
    const monitor = require('./monitor');
    const rateGovernor = require('./rate-governor');
    const queue = require('./queue');
    const config = require('./config.json');
    
    // ANSI colors
    const colors = {
      reset: '\x1b[0m',
      bright: '\x1b[1m',
      dim: '\x1b[2m',
      red: '\x1b[31m',
      green: '\x1b[32m',
      yellow: '\x1b[33m',
      blue: '\x1b[34m',
      magenta: '\x1b[35m',
      cyan: '\x1b[36m',
      white: '\x1b[37m'
    };

    // Load data
    if (!ledger.loaded) await ledger.load();
    if (!monitor.loaded) await monitor.load();
    if (!rateGovernor.loaded) await rateGovernor.load();
    if (!queue.loaded) await queue.load();

    console.log(`\n${colors.cyan}${colors.bright}━━━ OpenClaw Task Router Dashboard ━━━${colors.reset}\n`);

    // Backend Health
    console.log(`${colors.bright}Backend Health:${colors.reset}`);
    const backends = ['claudeCode', 'codex', 'api', 'local'];
    
    for (const backend of backends) {
      const enabled = config.backends[backend]?.enabled ?? false;
      const adaptive = monitor.getAdaptiveScore(backend, { type: 'code', urgency: 'normal' });
      const rateCheck = rateGovernor.canUse(backend);
      
      // Status determination
      let status = enabled ? 'UP' : 'DOWN';
      let statusColor = enabled ? colors.green : colors.red;
      
      if (!rateCheck.allowed) {
        status = 'RATE LIMITED';
        statusColor = colors.yellow;
      }

      // Calculate requests/hour from recent results  
      const recentResults = monitor.data.backends[backend]?.results || [];
      const lastHour = Date.now() - (60 * 60 * 1000);
      const hourlyReqs = recentResults.filter(r => new Date(r.timestamp).getTime() > lastHour).length;
      
      // Rate governor state
      const rgStatus = rateGovernor.getStatus().backends[backend];
      let rgState = 'OK';
      if (rgStatus?.throttled) rgState = 'THROTTLED';
      if (rgStatus?.backoffUntil && Date.now() < rgStatus.backoffUntil) rgState = 'BACKOFF';
      
      console.log(`  ${statusColor}${status.padEnd(12)}${colors.reset} ${backend.padEnd(12)} | Score: ${adaptive.toFixed(0).padStart(3)}% | Req/hr: ${hourlyReqs.toString().padStart(3)} | Rate: ${rgState}`);
    }

    // Queue Status
    console.log(`\n${colors.bright}Queue Status:${colors.reset}`);
    const queueStatus = await queue.getQueueStatus();
    console.log(`  Queued: ${colors.cyan}${queueStatus.queued}${colors.reset} | Active: ${colors.yellow}${queueStatus.active}${colors.reset} | Completed: ${colors.green}${queueStatus.completed}${colors.reset}`);

    // Costs
    console.log(`\n${colors.bright}Costs:${colors.reset}`);
    const ledgerReport = await ledger.getReport();
    const savings = ledger.getSavings();
    
    const dailySpent = parseFloat(ledgerReport.api.dailySpend.replace('$', ''));
    const monthlySpent = parseFloat(ledgerReport.api.monthlySpend.replace('$', ''));
    const todaySaved = savings.todaySaved;
    const monthSaved = savings.monthSaved;
    
    console.log(`  Today spent:  ${colors.red}$${dailySpent.toFixed(2)}${colors.reset}`);
    console.log(`  Today saved:  ${colors.green}$${todaySaved.toFixed(2)}${colors.reset}`);
    console.log(`  Monthly total: ${colors.cyan}$${monthlySpent.toFixed(2)}${colors.reset}`);

    // Recent Tasks
    console.log(`\n${colors.bright}Recent Tasks (Last 5):${colors.reset}`);
    const allResults = [];
    
    for (const [backendName, stats] of Object.entries(monitor.data.backends)) {
      for (const result of (stats.results || [])) {
        allResults.push({
          timestamp: result.timestamp,
          backend: backendName,
          duration: result.duration || 0,
          success: result.success,
          description: result.description || result.taskType || 'Unknown task'
        });
      }
    }
    
    // Sort by timestamp and take last 5
    allResults.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const recent5 = allResults.slice(0, 5);
    
    recent5.forEach(task => {
      const timestamp = new Date(task.timestamp).toLocaleString();
      const statusIcon = task.success ? colors.green + '✓' : colors.red + '✗';
      const duration = `${Math.round(task.duration / 1000)}s`;
      const desc = truncateText(task.description, 40);
      
      console.log(`  ${statusIcon}${colors.reset} ${task.backend.padEnd(10)} | ${duration.padStart(4)} | ${timestamp} | ${desc}`);
    });

    console.log(`\n${colors.dim}Last updated: ${new Date().toLocaleString()}${colors.reset}\n`);

  } catch (error) {
    console.error('Dashboard error:', error.message);
  }
}

async function main() {
  try {
    await router.initialize();

    switch (command) {
      case 'route': {
        const description = args[1];
        if (!description) { console.error('Usage: route "task description"'); process.exit(1); }
        const flags = parseFlags(args.slice(2));
        
        const task = {
          description,
          urgency: flags.urgency || 'normal',
          forceBackend: flags.force || null,
          outputPath: flags.outputPath || null
        };

        if (flags.planOnly) {
          // Just show the plan, don't execute
          const plan = await router.plan(task);
          console.log(JSON.stringify(plan, null, 2));
        } else {
          const result = await router.route(task);
          console.log(JSON.stringify(result, null, 2));
        }
        break;
      }

      case 'plan': {
        const description = args[1];
        if (!description) { console.error('Usage: plan "task description"'); process.exit(1); }
        const plan = await router.plan({ description });
        console.log(JSON.stringify(plan, null, 2));
        break;
      }

      case 'estimate': {
        const description = args[1];
        if (!description) { console.error('Usage: estimate "task description"'); process.exit(1); }
        const costPredictor = require('./cost-predictor');
        const estimate = await costPredictor.predict(description);
        console.log(JSON.stringify(estimate, null, 2));
        break;
      }

      case 'status': {
        const status = await router.getStatus();
        console.log(JSON.stringify(status, null, 2));
        break;
      }

      case 'queue': {
        const scheduler = require('./scheduler');
        await scheduler.load();
        const status = scheduler.getStatus();
        console.log(JSON.stringify(status, null, 2));
        break;
      }

      case 'history': {
        const keyword = args[1];
        if (!keyword) { console.error('Usage: history "keyword" [--backend X] [--from DATE] [--to DATE] [--limit N]'); process.exit(1); }
        const flags = parseFlags(args.slice(2));
        await searchHistory(keyword, flags);
        break;
      }

      case 'dashboard': {
        await showDashboard();
        break;
      }

      default:
        console.log(`OpenClaw Task Router CLI
Commands:
  route "description"    — Route and execute a task
  plan "description"     — Show execution plan without running
  estimate "description" — Predict task cost without execution
  status                 — Router and backend status
  queue                  — Queue status
  history "keyword"      — Search task history
  dashboard              — Show pretty terminal status display

Flags:
  --force <backend>    — Force a specific backend
  --urgency <level>    — high, normal, or low
  --plan-only          — Show plan without executing
  --output <path>      — Output file path
  --backend <name>     — Filter history by backend
  --from <date>        — Filter history from date (YYYY-MM-DD)
  --to <date>          — Filter history to date (YYYY-MM-DD)
  --limit <n>          — Limit history results (default: 20)`);
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
  process.exit(0);
}

main();
