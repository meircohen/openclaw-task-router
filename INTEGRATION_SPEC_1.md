# Agent 1: Approval Flow + Progress Notifications

## Context
The router at `/Users/meircohen/.openclaw/workspace/router/` has a planner (planner.js) that decomposes tasks and estimates costs, and a scheduler (scheduler.js) that emits progress events. These need to be wired to Telegram notifications.

## Task 1: Telegram Approval Flow (notify.js)

Create `notify.js` — a module that bridges router events to OpenClaw messaging.

### How it works:
1. When planner generates a plan with API cost > $2, format it as a readable message
2. Send to Telegram via: `openclaw system event --text "message" --mode now`
3. For approval, create a pending-plans store (JSON file at data/pending-plans.json)
4. Dashboard API already has approve/cancel endpoints — wire those to actually execute/cancel plans

### Message formats:

**Plan approval request:**
```
📋 Task Plan — "OCR and analyze trust docs"

Step 1: OCR extraction → Codex (subscription, ~15 min)
Step 2: Parse to structured data → Claude Code (subscription, ~8 min)  
Step 3: Financial analysis → API/Sonnet ($1.20, ~3 min)
Step 4: Summary report → API/Sonnet ($0.40, ~1 min)

💰 Est. cost: $1.60 API + ~23 min subscription
⏱️ Total time: ~27 min

Reply "approve" or open dashboard to modify.
```

**Progress update:**
```
⚡ Task Progress — "OCR and analyze trust docs"
✅ Step 1/4: OCR extraction (Codex, 12 min)
🔄 Step 2/4: Parse to structured data (Claude Code, started)
◻ Step 3/4: Financial analysis
◻ Step 4/4: Summary report
⏱️ ETA: ~18 min remaining
```

**Completion:**
```
✅ Task Complete — "OCR and analyze trust docs"
⏱️ 24 min | 💰 $1.58 API + subscription
📄 Output: artifacts/trust-doc-analysis.md
```

### Implementation:
- `notify.js` exports: `sendPlanApproval(plan)`, `sendProgress(taskId, step, total, message)`, `sendCompletion(taskId, results)`, `sendError(taskId, error)`
- Uses `child_process.execSync` to call `openclaw system event`
- Listens to scheduler events: 'progress', 'complete', 'error'
- Stores pending plans in data/pending-plans.json with expiry (30 min)

## Task 2: Wire notifications into router

Update `index.js`:
- After planner.decompose(), if cost > autoApproveThreshold ($2), call notify.sendPlanApproval() and store plan as pending
- Add `router.approvePlan(planId)` and `router.cancelPlan(planId)` methods
- Hook scheduler events to notify.sendProgress/sendCompletion/sendError

Update `config.json`:
- Add `notifications` section: `{ enabled: true, autoApproveThresholdUsd: 2, progressUpdateInterval: 'per-step', telegramEnabled: true }`

## Files to create/modify:
- CREATE: `notify.js` (~200-300 lines)
- MODIFY: `index.js` — add approval flow + event hooks
- MODIFY: `config.json` — add notifications config
- MODIFY: `dashboard-server.js` — wire approve/cancel to router.approvePlan/cancelPlan

When done, run: openclaw system event --text "Done: Agent 1 — Approval flow + notifications wired" --mode now
