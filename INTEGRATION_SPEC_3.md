# Agent 3: Session Continuity + Warm Standby

## Context
The router at `/Users/meircohen/.openclaw/workspace/router/` needs cross-channel session continuity and warm standby for fast cold starts.

## Task 1: Session Continuity (session.js)

Create `session.js` — shared context across Telegram, Slack, Voice, Dashboard.

### Problem:
Meir starts a task on Voice ("analyze the trust docs"), then switches to Telegram to check progress, then opens Dashboard to approve modifications. Each channel should know what's happening without re-explaining.

### Solution: Active Context File
- Maintain `data/active-context.json` — the "working memory" of what Oz is doing
- Updated on every significant action (task started, plan created, step completed, task done)

### Schema:
```json
{
  "lastUpdated": "ISO timestamp",
  "activeTasks": [
    {
      "taskId": "route_xxx",
      "description": "Analyze trust documents",
      "status": "running|queued|pending-approval|complete|failed",
      "plan": { /* plan object */ },
      "currentStep": 2,
      "totalSteps": 4,
      "startedFrom": "voice|telegram|slack|dashboard|cli",
      "startedAt": "ISO timestamp",
      "eta": "ISO timestamp",
      "lastUpdate": "step 2 started",
      "outputPath": "artifacts/trust-analysis.md"
    }
  ],
  "recentCompleted": [ /* last 10 completed tasks */ ],
  "channelHistory": {
    "voice": { "lastActive": "ISO", "lastTaskId": "xxx" },
    "telegram": { "lastActive": "ISO", "lastTaskId": "xxx" }
  }
}
```

### Integration:
- Router writes to active-context.json on every state change
- Any channel can read it to know current state
- Voice can say "Your OCR task is 60% done, about 12 minutes left" without checking anything
- Telegram can show status without re-querying
- Dashboard reads it for the live queue view

### Exports:
- `getContext()` → full active context
- `getActiveTask(taskId)` → single task status
- `updateTask(taskId, updates)` → update a task's state
- `addTask(task)` → register new task
- `completeTask(taskId, result)` → mark done, move to recentCompleted
- `getChannelState(channel)` → what's the last thing this channel was working on
- `setChannelActive(channel)` → update channel's last active time

## Task 2: Warm Standby (warmup.js)

Create `warmup.js` — keeps Claude Code and Codex ready for fast starts.

### Problem:
Cold-starting Claude Code or Codex takes 5-10 seconds (process spawn, auth check, model load). For time-sensitive tasks, this adds friction.

### Solution: Periodic health pings
- Every 15 minutes, do a lightweight check on each subscription backend
- Claude Code: run `claude --version` (confirms binary + auth)
- Codex: run `codex --version` (confirms binary + auth)
- Ollama: hit `http://localhost:11434/api/tags` (confirms server running)
- Track last successful ping time per backend

### Pre-warming (optional, configurable):
- If a task is queued for a backend, start a "warm" session 30 seconds before estimated dispatch
- For Claude Code: spawn process, don't send task yet, just have it ready
- This shaves ~5s off task start time

### Health status:
- Each backend gets a health score: 'healthy' (pinged in last 15 min), 'warm' (pinged in last 5 min), 'cold' (no recent ping), 'dead' (last ping failed)
- Router uses health status in backend selection (prefer warm/healthy over cold)

### Integration with router:
- warmup.js runs on a setInterval (15 min default)
- Results written to data/backend-health.json
- Router reads health status when scoring backends
- Dashboard shows health indicators

### Exports:
- `startWarmup()` — begin periodic health checks
- `stopWarmup()` — stop checks
- `getHealth()` → all backend health states
- `getHealth(backend)` → single backend health
- `pingNow(backend)` → force immediate health check
- `preWarm(backend)` → start a pre-warm session

## Files to create/modify:
- CREATE: `session.js` (~250 lines)
- CREATE: `warmup.js` (~200 lines)
- MODIFY: `index.js` — update active context on task lifecycle, read health for scoring
- MODIFY: `config.json` — add session and warmup config
- MODIFY: `dashboard-server.js` — add /api/context and /api/health endpoints

Run tests after. When done, run: openclaw system event --text "Done: Agent 3 — Session continuity + warm standby" --mode now
