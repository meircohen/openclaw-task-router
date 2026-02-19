# OpenClaw Task Router v2

Smart routing system that distributes AI sub-agent work across multiple backends with **task decomposition**, **multi-route execution**, and **subscription queue management**.

## What's New in v2

- **Task Planner** (`planner.js`) — Decomposes complex tasks into steps with backend recommendations, cost estimates, dependency graphs, and parallelization hints
- **Subscription Scheduler** (`scheduler.js`) — Persistent queue for subscription backends (Claude Code, Codex) with concurrency limits, rate-limit awareness, auto-retry, and event-driven progress
- **Plan Mode** — `router.route(task, { plan: true })` returns a plan without executing
- **Multi-Route Execution** — `router.executePlan(plan)` runs steps in parallel waves, passing context between steps, with retry + fallback on failure

## Architecture

```
                         ┌──────────────────┐
                         │   Task Planner   │
                         │  (planner.js)    │
                         └────────┬─────────┘
                                  │ decompose()
                                  ▼
┌────────┐   route()    ┌──────────────────┐   executePlan()
│  Oz /  │ ───────────▶ │   Task Router    │ ──────────────▶ parallel waves
│  User  │              │   (index.js)     │
└────────┘              └────────┬─────────┘
                                 │
                    ┌────────────┼────────────┐
                    ▼            ▼            ▼
              ┌──────────┐ ┌──────────┐ ┌──────────┐
              │  Claude  │ │  Codex   │ │  Local   │
              │  Code    │ │ Parallel │ │  Ollama  │
              └──────────┘ └──────────┘ └──────────┘
                    │            │
                    └─────┬──────┘
                          ▼
                 ┌──────────────────┐
                 │   Subscription   │
                 │   Scheduler      │
                 │  (scheduler.js)  │
                 └──────────────────┘
```

## Quick Start

```bash
cd /Users/meircohen/.openclaw/workspace/router
npm install
node test.js        # run tests
node dashboard-server.js  # start dashboard on :3000
```

## Usage

### Plan Mode — Preview Before Executing

```javascript
const router = require('./index');

// Get a plan without executing
const result = await router.route({
  description: "OCR financial docs, analyze for tax optimization, generate report",
  type: "analysis",
  complexity: 8,
  files: ["doc1.pdf", "doc2.pdf"]
}, { plan: true });

console.log(result.formatted);   // human-readable plan
console.log(result.needsApproval); // true if API cost > $2

// Execute the plan after approval
const execution = await router.executePlan(result.plan);
console.log(execution.completedSteps, '/', execution.totalSteps);
```

### Direct Routing (Backward Compatible)

```javascript
const result = await router.route({
  description: "Write a Python fibonacci function",
  type: "code",
  urgency: "normal"
});
```

### Subscription Scheduler

```javascript
const { scheduler } = require('./index');

// Enqueue tasks for subscription backends
const taskId = await scheduler.enqueue(
  { description: "Refactor auth module" },
  'claude-code',
  'normal'
);

// Check status
console.log(scheduler.getStatus());
console.log(scheduler.getETA(taskId));

// Listen for progress
scheduler.on('progress', (id, step, total, msg) => {
  console.log(`${id}: ${msg}`);
});

scheduler.on('complete', (id, result) => {
  console.log(`${id} done!`);
});

// Control
scheduler.pause();
scheduler.resume();
await scheduler.cancel(taskId);
```

### Planner API

```javascript
const { planner } = require('./index');

const plan = planner.decompose({
  description: "Research competitors, analyze market, write strategy doc",
  complexity: 7
});

const cost = planner.estimateCost(plan);
console.log('API cost:', cost.totalApiCost);
console.log('Time:', cost.totalEstimatedMinutes, 'min');

const formatted = planner.formatPlanForUser(plan);
console.log(formatted);
```

## Decomposition Heuristics

| Pattern | Backend | Parallelizable |
|---------|---------|---------------|
| File ops (OCR, parse, extract) | codex | Yes |
| Complex reasoning (analyze, synthesize) | claude-code / api | No |
| Simple transforms (format, template) | local | No |
| Multi-file code changes | claude-code | No |
| Quick code generation | codex | Yes |
| Large context (>100K tokens) | api/Gemini or chunk | No |
| Research / investigation | codex | Yes |
| Testing | codex | Yes |
| Documentation | local | No |

## Cost Model

| Backend | Cost | Speed |
|---------|------|-------|
| Claude Code (subscription) | $0 marginal | ~8 min/task |
| Codex (subscription) | $0 marginal | ~5 min/task |
| API (Sonnet 4) | ~$3/MTok in, ~$15/MTok out | ~2 min/task |
| API (Haiku 4.5) | ~$0.25/MTok in, ~$1.25/MTok out | ~1 min/task |
| Local (Ollama) | $0 | ~4 min/task |

Plans with API cost > $2 require user approval before execution.

## Scheduler Configuration

```json
{
  "scheduler": {
    "enabled": true,
    "concurrency": {
      "claude-code": 1,
      "codex": 3
    },
    "cooldowns": {
      "claude-code": 1200000,
      "codex": 300000
    },
    "maxRetries": 2
  }
}
```

## Dashboard API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/api/status` | GET | Full router + scheduler status |
| `/api/route` | POST | Route a task |
| `/api/plan` | POST | Decompose task into plan |
| `/api/execute-plan` | POST | Execute an approved plan |
| `/api/scheduler` | GET | Scheduler queue status |
| `/api/scheduler/enqueue` | POST | Add task to scheduler |
| `/api/scheduler/eta/:id` | GET | Get ETA for queued task |
| `/api/scheduler/cancel/:id` | POST | Cancel a scheduled task |
| `/api/scheduler/pause` | POST | Pause scheduler |
| `/api/scheduler/resume` | POST | Resume scheduler |
| `/api/queue` | GET | Legacy queue status |
| `/api/performance` | GET | Performance analytics |
| `/api/usage` | GET | Budget/usage report |
| `/api/docs` | GET | API documentation |

## Cron Routing

OpenClaw cron jobs now route through the task router for intelligent backend selection, instead of always spawning API sub-agents.

### Old Way vs New Way

**Before (Old Way):**
```bash
# All cron jobs spawned API sub-agents directly
sessions_spawn --channel telegram --announce \
  --model anthropic/claude-sonnet-4-20250514 \
  "Check portfolio performance and alert on significant changes"
```

**Now (New Way):**
```bash
# Cron jobs route through the task router first
node /Users/meircohen/.openclaw/scripts/cron-router.js \
  "Check portfolio performance and alert on significant changes"
```

The cron router:
1. **Analyzes the task** — detects if it needs OpenClaw tools (memory, sessions, messaging)
2. **Routes intelligently** — uses subscription backends when possible to save API costs
3. **Returns execution results** — either completed work or spawn instructions for OpenClaw
4. **Logs all decisions** — maintains audit trail in `router/data/cron-routing-log.json`

### Routing Decision Tree

```
Cron Task
    │
    ├─ Needs OpenClaw tools? ──→ API spawn (sessions_spawn)
    │  (memory, sessions, telegram, email, etc.)
    │
    ├─ Router available? ──→ Route through task router
    │  │
    │  ├─ Subscription backend selected ──→ Execute directly
    │  │  (claude-code, codex, local)        Return JSON result
    │  │
    │  └─ API backend selected ──→ API spawn (sessions_spawn)
    │     (complex analysis, tools needed)
    │
    └─ Router error/unavailable ──→ Fallback API spawn
```

### Cron-Specific Behavior

- **Urgency**: All cron tasks get `urgency: 'low'` (crons are never urgent)
- **Cost optimization**: Prefers free subscription backends over paid API calls
- **OpenClaw-tool detection**: Automatically routes tasks requiring memory search, messaging, calendar access, etc. to API backend
- **Audit logging**: Every routing decision logged to `data/cron-routing-log.json` (last 500 entries)
- **Error handling**: Falls back to API spawn on any router error (never fails silently)

### Output Formats

The cron router returns JSON with different `action` values:

**Subscription backend completed:**
```json
{
  "action": "completed",
  "backend": "codex",
  "success": true,
  "response": "Analysis complete...",
  "duration": 45000,
  "tokens": 1250
}
```

**API backend required:**
```json
{
  "action": "api-spawn",
  "model": "anthropic/claude-sonnet-4-20250514",
  "urgency": "low",
  "reason": "Router selected API backend",
  "task": "..."
}
```

**Router self-handle:**
```json
{
  "action": "self-handle",
  "reason": "High confidence simple task",
  "confidence": 97
}
```

**Fallback to API:**
```json
{
  "action": "fallback-spawn",
  "model": "anthropic/claude-sonnet-4-20250514",
  "reason": "Task requires OpenClaw tools",
  "urgency": "low"
}
```

### Migration Path

Existing cron jobs can be gradually migrated:

1. **No change needed** — old `sessions_spawn` calls still work
2. **Opt-in migration** — replace `sessions_spawn` with `cron-router.js` call
3. **Handle both outputs** — check returned JSON `action` field:
   - `completed` = work is done, use the result
   - `api-spawn` / `fallback-spawn` = call `sessions_spawn` with returned model

### Benefits

- **Cost savings** — routes simple tasks to free subscription backends
- **Better performance** — subscription backends often faster than API calls
- **Audit trail** — all routing decisions logged for analysis
- **Smart detection** — automatically identifies tasks needing OpenClaw tools
- **Graceful fallback** — never breaks existing workflows

## Testing

```bash
node test.js
```

Tests cover:
1. Simple task — no decomposition, single-step plan
2. Complex task — multi-step decomposition with dependencies
3. Expensive task — cost estimation and approval flag
4. Queue management — enqueue, ordering, ETA, cancel
5. Multi-route context passing — step outputs flow to dependents
6. Failure recovery — retry on same backend, then fallback
7. Scheduler events — enqueue/cancel/pause/resume events fire
8. Dependency graph — all references valid, first steps have no deps
9. Parallel time estimation — wall-clock < sequential sum

## Design Principles

- Node.js modules, no external services
- JSON file persistence (no database)
- Event-driven progress reporting
- Graceful degradation — if planner can't decompose, falls back to single-route
- Cost-conservative — prefers subscription over API unless user says otherwise
- All estimates clearly labeled as estimates

---

**Version**: 2.0.0
**Author**: OpenClaw

## Slack Routing

Slack messages route through OpenClaw's gateway to the main agent (Oz), same as Telegram. There is no separate Slack spawn script to wire. To route Slack-originated tasks through the router:

1. Oz (main agent) calls `route-and-spawn.js` before spawning sub-agents
2. This applies regardless of whether the request came from Telegram, Slack, or Voice
3. The router's `metadata.channel` field tracks the originating channel for analytics

No additional wiring needed — the router is channel-agnostic by design.

## Development Workflow

All development and testing happens in the **staging** environment (`router-staging/`). Production (`router/`) is only updated via the promotion script.

### Workflow

1. **Develop** — Make changes in `router-staging/`
2. **Test** — Run `cd router-staging && node test.js && node test-approval.js`
3. **Promote** — Run `~/.openclaw/scripts/promote-to-prod.sh` to push staging → production
4. **Reset** — Run `~/.openclaw/scripts/staging-reset.sh` to reset staging from production

### Scripts

| Script | Purpose |
|--------|---------|
| `promote-to-prod.sh` | Run tests, diff, copy staging → prod, bump version, git tag |
| `staging-reset.sh` | Reset staging to match current production (clears staging data) |

### Promotion Flags

- `--patch` (default), `--minor`, `--major` — semver bump type
- `--yes` / `-y` — skip confirmation prompt

### Version Numbers

We follow [semver](https://semver.org/):
- **Patch** (1.0.x) — Bug fixes, minor tweaks
- **Minor** (1.x.0) — New features, backward-compatible
- **Major** (x.0.0) — Breaking changes

### Environment Separation

- **Production** (`router/`) — `config.json` has `ENVIRONMENT: "production"`
- **Staging** (`router-staging/`) — `config.json` has `ENVIRONMENT: "staging"`
- Each environment has its own `data/` directory — they never share state
