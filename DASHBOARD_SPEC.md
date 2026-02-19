# Router Dashboard — Full Build Spec

## Overview
Production web dashboard for the OpenClaw Task Router, exposed via Cloudflare tunnel on a permanent URL.

## Pages / Views

### 1. Live Queue
- Real-time view of all queued, running, and completed tasks
- Each task shows: description, backend, status, ETA, cost (est vs actual)
- Drag to reprioritize (urgent/normal/background)
- Cancel button per task
- Auto-refreshes via WebSocket or SSE

### 2. Task History
- Searchable/filterable table of all past tasks
- Columns: timestamp, description, backend used, duration, tokens, cost, success/fail
- Click to expand: full plan decomposition, step-by-step results, error details
- Date range filter, backend filter, cost filter
- Export to CSV

### 3. Cost Dashboard
- Daily/weekly/monthly spend charts (bar + line)
- Subscription vs API split (pie chart)
- Running total with daily budget line ($100)
- Cost per backend breakdown
- Projected monthly spend based on trailing 7 days
- "Money saved by subscription" counter (what it would have cost on API)

### 4. Backend Health
- Card per backend (Claude Code, Codex, Local, API)
- Status: online/offline/cooldown/throttled
- Adaptive score (current + 7-day trend sparkline)
- Success rate, avg duration, last used
- Cooldown timer (Claude Code)
- Concurrency slots (Codex: X/3 in use)
- Circuit breaker status

### 5. Plan Viewer
- When a task is decomposed, show the DAG (dependency graph)
- Each node = step, colored by backend
- Click step to see details, output, cost
- Approve/modify/cancel buttons for pending plans
- This could double as the approval UI from Telegram ("open dashboard to review plan")

### 6. Settings
- Edit config.json values from UI (thresholds, backend toggles, budget limits)
- Save writes back to config.json
- Show current config as read-only JSON for debugging

## Tech Stack
- **Backend**: Express.js (extend existing dashboard-server.js)
- **Frontend**: Single HTML file with embedded CSS/JS (like current index.html pattern)
- **Real-time**: Server-Sent Events (SSE) for live updates (simpler than WebSocket)
- **Charts**: Chart.js (CDN, no build step)
- **Styling**: Clean dark theme, responsive, looks good on mobile too
- **No build tools**: Pure HTML/CSS/JS, no React/Vue/webpack. Keep it simple.

## API Endpoints (Express)
- `GET /api/queue` — current queue state
- `GET /api/history?from=&to=&backend=&limit=` — task history
- `GET /api/costs?period=day|week|month` — cost aggregations
- `GET /api/backends` — backend health status
- `GET /api/plan/:taskId` — plan details for a specific task
- `POST /api/plan/:taskId/approve` — approve a pending plan
- `POST /api/plan/:taskId/cancel` — cancel a pending plan
- `POST /api/queue/:taskId/cancel` — cancel a queued task
- `POST /api/queue/:taskId/priority` — change priority
- `PUT /api/config` — update config
- `GET /api/events` — SSE stream for real-time updates
- `GET /api/stats` — summary stats (total tasks, success rate, total spend, saved)

## Cloudflare Tunnel
- Use `cloudflared` quick tunnel (same pattern as oz-voice)
- pm2 managed: `pm2 start` with auto-restart
- Auto-update script that logs current URL
- Dashboard port: 3457
- Auth: simple token-based auth (bearer token in config.json, checked on all API routes)
- The token gets set once and included in the bookmarked URL as query param

## Security
- Auth token required for all routes (except health check)
- Token stored in config.json under `dashboard.authToken`
- Rate limiting on write endpoints
- No sensitive data exposed (no API keys, no memory contents)
- CORS restricted to tunnel domain

## Files to create/modify
- `dashboard-server.js` — full rewrite with all API endpoints + SSE
- `dashboard.html` — new file, full dashboard UI (replaces index.html for dashboard)
- `config.json` — add dashboard section (port, authToken)
- `package.json` — add chart.js if needed (or use CDN)

## Design notes
- Dark theme (#1a1a2e background, cards with subtle borders)
- Monospace fonts for data, clean sans-serif for labels
- Green/yellow/red status indicators
- Subtle animations on updates (fade in new tasks)
- Mobile-friendly (cards stack vertically)
- Fast — no framework overhead, loads in <1s
