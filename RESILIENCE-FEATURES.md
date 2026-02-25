# OpenClaw Router Resilience Features

This document describes the infrastructure resilience features implemented for the OpenClaw Task Router.

## 🛡️ Auto-Failover Watchdog

**File:** `watchdog.js`

A standalone process that monitors backend health and automatically manages routing scores for resilient operation.

### Features

- **Automatic Health Monitoring**: Checks all backends every 60 seconds
- **Smart Failover**: Sets adaptive scores to 0 when backends fail, restores to seed values on recovery  
- **Comprehensive Backend Support**:
  - **Claude Code**: `which claude && claude --version`
  - **Codex**: `which codex && codex --version`  
  - **Ollama**: HTTP GET to `http://localhost:11434/api/tags`
  - **API**: Validates configuration settings
- **Alert System**: Sends notifications via `openclaw system event` on failures/recoveries
- **Uptime Tracking**: Maintains detailed uptime statistics per backend
- **Event Logging**: Comprehensive event stream in `data/watchdog-events.json`
- **State Persistence**: Maintains state across restarts in `data/watchdog-log.json`

### Usage

```bash
# Start as PM2 process (recommended)
pm2 start watchdog.js --name router-watchdog

# Run manually
node watchdog.js

# View logs
pm2 logs router-watchdog

# Check status
curl "http://localhost:3457/api/watchdog?token=YOUR_TOKEN"
```

### Integration Points

- **Monitor Integration**: Updates adaptive scores in `data/monitor.json`
- **Dashboard API**: New `/api/watchdog` endpoint shows uptime stats
- **Alert System**: Integrates with OpenClaw system events
- **Router Integration**: Works with existing warmup and monitoring infrastructure

### Data Structures

```json
{
  "backends": {
    "claudeCode": {
      "isHealthy": true,
      "lastHealthy": "2026-02-19T06:56:13.723Z",
      "uptimePercentage": "99.95",
      "totalChecks": 1440,
      "healthyChecks": 1439,
      "consecutiveFailures": 0
    }
  }
}
```

## 🌐 Cloudflare Tunnel Setup

**File:** `/Users/meircohen/.openclaw/scripts/setup-dashboard-tunnel.sh`

Automated script to create a permanent, named Cloudflare tunnel for secure dashboard access.

### Features

- **Named Tunnel Creation**: Creates `oz-dashboard` tunnel (not quick tunnel)
- **Automatic DNS Setup**: Configures `dashboard.DOMAIN` subdomain
- **PM2 Integration**: Sets up tunnel as managed PM2 process
- **Complete Automation**: Handles authentication checks, cleanup, configuration
- **Rollback Instructions**: Provides complete removal instructions
- **Cross-Platform**: Supports macOS (with auto-install via Homebrew) and Linux

### Usage

```bash
# Setup tunnel for your domain
~/.openclaw/scripts/setup-dashboard-tunnel.sh example.com

# This creates: https://dashboard.example.com -> localhost:3457
```

### Configuration Generated

```yaml
# ~/.cloudflared/config-dashboard.yml
tunnel: [UUID]
credentials-file: ~/.cloudflared/[UUID].json

ingress:
  - hostname: dashboard.example.com
    service: http://localhost:3457
  - service: http_status:404

metrics: 127.0.0.1:2000
```

### PM2 Process

The script creates a PM2 ecosystem configuration for the tunnel:

```bash
pm2 start ~/.cloudflared/pm2.config.js
pm2 logs oz-dashboard
pm2 restart oz-dashboard
```

## 🔗 Dashboard Integration

The watchdog system integrates seamlessly with the existing dashboard:

### New API Endpoint

**GET** `/api/watchdog`
- Returns comprehensive uptime statistics
- Shows current health status of all backends
- Provides failure/recovery event history
- Includes uptime percentages and check counts

### Existing Integration Points

- **Health Monitoring**: Builds on existing `warmup.js` infrastructure
- **Adaptive Scoring**: Uses existing `monitor.js` scoring system
- **Event System**: Leverages OpenClaw system events
- **Dashboard Server**: Extends existing API structure

## 🚀 Deployment Guide

### 1. Start the Watchdog

```bash
cd ~/.openclaw/workspace/router
pm2 start watchdog.js --name router-watchdog
pm2 save
```

### 2. Verify Dashboard Integration

```bash
# Get auth token from config.json
TOKEN=$(cat config.json | jq -r '.dashboard.authToken')

# Test watchdog endpoint
curl "http://localhost:3457/api/watchdog?token=$TOKEN" | jq .
```

### 3. Set Up Cloudflare Tunnel

```bash
# Replace with your domain
~/.openclaw/scripts/setup-dashboard-tunnel.sh yourdomain.com
```

### 4. Access Dashboard Remotely

Visit `https://dashboard.yourdomain.com` to access the router dashboard with watchdog uptime statistics.

## 📊 Monitoring & Alerts

### Alert Types

- **Backend Down**: `⚠️ [backend] is DOWN: [error]`
- **Backend Recovery**: `✅ [backend] backend has RECOVERED`

### Log Files

- **Watchdog State**: `data/watchdog-log.json`
- **Event Stream**: `data/watchdog-events.json`  
- **Monitor Integration**: `data/monitor.json` (watchdogScore field)
- **PM2 Logs**: `~/.openclaw/logs/tunnel-*.log`

### Metrics Tracked

- Uptime percentage per backend
- Total health checks performed  
- Consecutive failure counts
- Recovery times
- Downtime minutes
- Last healthy/down timestamps

## 🛠️ Testing

Test the complete system:

```bash
cd ~/.openclaw/workspace/router
node test-watchdog.js
```

This verifies:
- Configuration loading
- Health check functionality  
- State management
- Integration points
- Backend monitoring for all supported systems

## 🔄 Recovery Scenarios

The watchdog handles various failure scenarios:

1. **CLI Tool Missing**: Detects when `claude` or `codex` commands fail
2. **Ollama Down**: Monitors HTTP endpoint availability
3. **API Configuration**: Validates API backend settings  
4. **Network Issues**: Handles timeouts and connection failures
5. **Process Crashes**: PM2 automatically restarts the watchdog
6. **State Recovery**: Persists state across restarts

## 🎯 Benefits

- **Zero-Touch Failover**: Automatic backend management without manual intervention
- **Improved Reliability**: Failed backends automatically excluded from routing
- **Quick Recovery**: Immediate restoration when backends come back online
- **Comprehensive Monitoring**: Detailed health and uptime tracking
- **Secure Remote Access**: Production-ready Cloudflare tunnel setup
- **Operational Visibility**: Dashboard integration with real-time status

The system provides enterprise-grade resilience for the OpenClaw Task Router with minimal operational overhead.