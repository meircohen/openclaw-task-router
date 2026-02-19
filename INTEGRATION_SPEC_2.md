# Agent 2: Circuit Breaker + Confidence Routing + Dedup

## Context
The router at `/Users/meircohen/.openclaw/workspace/router/` needs three resilience features.

## Task 1: Circuit Breaker Pattern (circuit-breaker.js)

Create `circuit-breaker.js` — protects backends from cascading failures.

### States per backend:
- **CLOSED** (normal): requests flow through
- **OPEN** (broken): all requests rejected, returns fallback immediately
- **HALF-OPEN** (testing): allows 1 probe request to test recovery

### Triggers:
- 5 failures in 15 minutes → OPEN for 10 minutes
- After 10 min cooldown → HALF-OPEN
- 1 success in HALF-OPEN → CLOSED
- 1 failure in HALF-OPEN → OPEN again (reset cooldown)

### Integration:
- Wrap each backend call in circuit breaker check
- If breaker is OPEN, skip to next backend in fallback chain
- Emit events: 'breaker-open', 'breaker-closed', 'breaker-half-open'
- Persist state to data/circuit-breaker-state.json (survive restarts)
- Dashboard should show breaker state per backend

### Exports:
- `canExecute(backend)` → boolean
- `recordSuccess(backend)`
- `recordFailure(backend)`  
- `getState(backend)` → { state, failures, lastFailure, cooldownEnds }
- `getAll()` → all breaker states

## Task 2: Confidence-Based Self-Handling

Update `index.js` routing logic:

### Rules:
- **>95% confidence** Oz can answer directly → don't route, return `{ selfHandle: true, reason }` 
  - Simple lookups, memory search, calendar check, weather
  - Pattern: question mark + short expected answer + no file creation needed
- **50-95% confidence** → route but offer: "I can take a quick stab, or route this for a thorough job"
- **<50% confidence** → always route, no option to self-handle

### Confidence scoring heuristics (add to planner.js):
- Contains "build", "create", "write", "refactor", "analyze" → low confidence (always route)
- Contains "what is", "when is", "check", "status" → high confidence (self-handle)
- Estimated tokens > 10K → low confidence
- Needs file creation → low confidence
- Needs tools (shell, git, npm) → low confidence
- Simple math/lookup → high confidence

### Exports (add to planner):
- `assessConfidence(task)` → { score: 0-100, recommendation: 'self'|'offer'|'route', reason }

## Task 3: Smart Dedup (dedup.js)

Create `dedup.js` — prevents duplicate agent spawns.

### How it works:
- Maintain a rolling window of recent tasks (last 30 min)
- Before routing, check if a similar task is already running or queued
- Similarity check: normalize description (lowercase, strip punctuation), compute word overlap
- If overlap > 70%, flag as potential duplicate
- Return: `{ isDuplicate: boolean, existingTaskId, similarity, recommendation: 'skip'|'warn'|'proceed' }`

### Edge cases:
- Same task from different channels (voice + telegram) → dedup
- Retry of failed task → allow (check if previous failed)
- Similar but different scope ("analyze page 1-10" vs "analyze page 11-20") → allow

### Persistence:
- Keep recent tasks in memory + data/recent-tasks.json
- Auto-expire entries older than 30 min

### Exports:
- `check(task)` → { isDuplicate, existingTaskId, similarity, recommendation }
- `register(taskId, task)` — add task to tracking
- `complete(taskId)` — mark as done
- `getRecent()` — list recent tasks

## Files to create/modify:
- CREATE: `circuit-breaker.js` (~200 lines)
- CREATE: `dedup.js` (~150 lines)
- MODIFY: `index.js` — integrate breaker checks before backend calls, confidence check before routing, dedup check before spawning
- MODIFY: `planner.js` — add assessConfidence()
- MODIFY: `config.json` — add circuitBreaker and dedup sections
- MODIFY: `dashboard-server.js` — add /api/breakers and /api/dedup endpoints

Run tests after. When done, run: openclaw system event --text "Done: Agent 2 — Circuit breaker + confidence + dedup" --mode now
