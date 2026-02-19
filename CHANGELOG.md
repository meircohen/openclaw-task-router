# Changelog

All notable changes to the OpenClaw Task Router will be documented in this file.

## [1.0.0] - 2026-02-19

### Initial Release

The OpenClaw Task Router v1.0.0 — a smart routing system that distributes AI sub-agent work across multiple backends.

### Core Modules
- **index.js** — Main router with adaptive scoring, hybrid routing, and confidence-based self-handle
- **planner.js** — Task decomposition into steps with backend recommendations, cost estimates, dependency graphs, and parallelization
- **scheduler.js** — Persistent subscription queue for Claude Code & Codex with concurrency limits, cooldowns, and auto-retry
- **queue.js** — Task queue management with priority ordering
- **session.js** — Session context tracking for active tasks
- **cli.js** — Command-line interface for direct task routing

### Backend Integrations
- **claude-code.js** — Claude Code backend with session management and rate limiting
- **codex.js** — Codex parallel execution backend
- **local.js** — Local Ollama backend for fast, free tasks (phi3, llama3.2)
- **model-registry.js** — Multi-provider model selection with context-size routing and trust scoring

### Reliability & Observability
- **circuit-breaker.js** — Per-backend circuit breaker (failure threshold, cooldown, auto-recovery)
- **rate-governor.js** — Rate limiting and usage tracking across all backends
- **dedup.js** — Duplicate task detection with similarity scoring
- **watchdog.js** — Health monitoring and dead letter queue for failed tasks
- **monitor.js** — Performance metrics collection and reporting
- **warmup.js** — Backend health checks and pre-warming

### Cost & Ledger
- **ledger.js** — Token usage and cost tracking per backend/model
- **cost-predictor.js** — Pre-execution cost estimation for plans

### Notifications
- **notify.js** — Telegram notification integration for approvals and progress
- **slack-notify.js** — Slack webhook notifications (optional)

### Dashboard
- **dashboard-server.js** — Express server for web dashboard (port 3457)
- **dashboard.html** — Real-time dashboard UI with metrics, queue status, and backend health
- **index.html** — Landing page

### Integrations
- **github-webhook.js** — GitHub webhook handler for repo-triggered routing
- **shadow-bench.js** — Shadow benchmarking system for model comparison and trust building

### Test Suite
- **test.js** — Core unit tests
- **test-approval.js** — Approval flow tests
- **test-integration.js** — Integration tests
- **test-model-registry.js** — Model registry tests
- **test-rate-governor.js** — Rate governor tests
- **test-router-integration.js** — End-to-end router tests
- **test-api-endpoints.js** — API endpoint tests
- **test-api-endpoints-curl.js** — cURL-based API tests
- **test-api-model-selection.js** — Model selection API tests

### Tonight's Fixes (2026-02-19)
- Production/staging environment separation
- Version tagging and release management
- Promotion workflow scripts
