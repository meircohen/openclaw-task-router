# Router v2: Task Planner + Subscription Scheduler

## Context
The router at `/Users/meircohen/.openclaw/workspace/router/` currently routes whole tasks to a single backend. We need two new capabilities:

## Feature 1: Task Decomposition & Cost Estimation (`planner.js`)

### What it does
Takes a task description and breaks it into discrete steps, each with:
- Step description
- Recommended backend (claude-code, codex, local, api)
- Estimated token count / cost
- Dependencies (which steps must complete first)
- Whether it's parallelizable

### Cost estimation
- API costs: use model pricing (Sonnet 4 ~$3/MTok in, ~$15/MTok out, Haiku ~$0.25/$1.25)
- Subscription backends (claude-code, codex): $0 marginal cost, but time cost (estimate minutes)
- Local: $0 cost, slowest

### User approval flow
- If total API cost > $2, return a plan summary for user approval before executing
- Plan summary format: numbered steps, backend, cost estimate, time estimate
- User can approve, modify (e.g., "run step 3 through subscription instead"), or cancel
- If all subscription, just show time estimate and ask if they want to queue it

### Integration with existing router
- `planner.js` exports: `decompose(task) → Plan`, `estimateCost(plan) → CostBreakdown`, `formatPlanForUser(plan) → string`
- The main `index.js` calls planner.decompose() before routing
- Add a `plan` mode to router: `router.route(task, { plan: true })` returns the plan without executing
- Add `router.executePlan(plan)` to run an approved plan

### Decomposition heuristics
- File operations (OCR, parsing, extraction) → local or codex (parallelizable)
- Complex reasoning (analysis, synthesis, recommendations) → claude-code or api
- Simple transforms (formatting, templating) → local
- Multi-file code changes → claude-code
- Quick code generation → codex (parallel)
- Large context needed (>100K tokens) → api with Gemini, or chunk for subscription

## Feature 2: Subscription Queue Manager (`scheduler.js`)

### What it does
Manages a persistent queue of tasks destined for subscription backends (Claude Code, Codex).
These are "free" but rate-limited, so we schedule them intelligently.

### Queue features
- Priority levels: urgent (next slot), normal, background (run overnight/idle)
- Estimated completion time based on queue depth + average task duration
- Progress reporting: emit events that Oz can relay to user ("Step 2/4 complete, ~20 min remaining")
- Persistent queue (JSON file in router/data/) survives restarts
- Concurrency: respect backend limits (Claude Code = 1 at a time, Codex = up to 3 parallel)
- Auto-retry on failure (max 2 retries, then alert)

### Rate limiting awareness
- Claude Code: ~20 min cooldown between heavy sessions (configurable)
- Codex: can run 3 parallel, but subscription may throttle
- Track "subscription health" — if getting throttled, back off automatically

### Progress callback system
- `scheduler.on('progress', (taskId, step, total, message) => ...)`
- `scheduler.on('complete', (taskId, results) => ...)`  
- `scheduler.on('error', (taskId, error) => ...)`
- These events will be wired to Telegram/Slack/Voice notifications

### Integration
- `scheduler.js` exports: `enqueue(task, backend, priority)`, `getStatus()`, `getETA(taskId)`, `cancel(taskId)`, `pause()`, `resume()`
- Queue state persisted to `router/data/queue-state.json`
- Dashboard server should show queue status (add endpoint)

## Feature 3: Multi-Route Execution Engine (update `index.js`)

### What it does
Executes a decomposed plan, routing each step to its optimal backend.

### Execution flow
1. Planner decomposes task → ordered steps with dependencies
2. Steps with no dependencies start in parallel (respecting backend concurrency)
3. As steps complete, dependent steps are unblocked
4. Results from earlier steps are passed as context to later steps
5. Final synthesis step combines all outputs

### Context passing between steps
- Each step produces an output artifact (file path or text)
- Dependent steps receive predecessor outputs in their prompt
- Keep context minimal — pass summaries not full outputs where possible

### Error handling
- Step failure → retry once on same backend
- Second failure → try next backend in fallback chain
- If critical step fails after fallback → abort plan, report to user with partial results
- Non-critical step failure → skip, note in final report

## Files to create/modify

### New files:
- `planner.js` — Task decomposition + cost estimation (~400-500 lines)
- `scheduler.js` — Subscription queue manager (~400-500 lines)

### Modified files:
- `index.js` — Add plan mode, executePlan(), multi-route execution
- `config.json` — Add planner and scheduler config sections
- `dashboard-server.js` — Add queue status endpoint
- `test.js` — Add tests for planner and scheduler
- `README.md` — Update with new features
- `package.json` — Add any new deps if needed (probably just `eventemitter3` for typed events)

## Design principles
- Everything is a Node.js module, no external services
- JSON file persistence (no database)
- Event-driven progress reporting
- Graceful degradation — if planner can't decompose, fall back to single-route
- Cost-conservative defaults — prefer subscription over API unless user says otherwise
- All estimates are clearly labeled as estimates, not guarantees

## Test scenarios
1. Simple task → no decomposition, routes directly (backward compatible)
2. Complex task → decomposes into 3-4 steps, shows plan, executes after approval
3. Expensive task → flags cost, offers subscription alternative with ETA
4. Queue management → enqueue 5 tasks, verify ordering, check ETA accuracy
5. Multi-route → task with OCR + analysis, OCR goes to codex, analysis to claude-code
6. Failure recovery → step fails, retries on fallback backend
7. Context passing → step 2 receives step 1 output correctly
