# Shadow Benchmarking System — shadow-bench.js

## Purpose
Run every task through cheap/free models in parallel with the primary backend. Compare results to build a trust model per task-type per model. Over time, confidently shift work to cheaper backends with data to prove it.

## Core Principle
Shadow runs are **data collection only** — they never affect the primary task result. The user always gets the primary backend's output. Shadow results are compared async and feed into the adaptive scoring system.

## Shadow Strategy

### Always shadow on Local (Ollama)
- Every single task, no exceptions
- Free, runs on our hardware, zero marginal cost
- Even if local can't fully complete the task, the attempt is data (we learn what local can/can't handle)
- Shadow can complete minutes after the primary — no time pressure

### Shadow on Codex/Claude Code — ONLY when idle
- Check rate-governor: if backend is below 50% of its hourly limit, shadow is OK
- Above 50%: skip shadow on that backend, preserve capacity for real work
- The idea: if it's been a quiet hour, we have free capacity sitting unused — use it to learn
- Never let shadow runs push us toward a throttle
- Rate governor integration: `rateGovernor.canUse(backend)` must return `allowed: true` AND current usage must be under 50% of limit
- If we're in a busy period (lots of real tasks), shadows only run on local (always free, no throttle risk)

## Data Model

```json
{
  "id": "shadow_xxx",
  "taskId": "route_xxx",
  "taskType": "code-generation",
  "description": "Build a REST API...",
  "timestamp": "ISO",
  "primary": {
    "backend": "claudeCode",
    "model": "opus-4.6",
    "duration": 8400,
    "tokens": 1200,
    "cost": 0,
    "outputLength": 3500,
    "outputHash": "sha256:abc...",
    "success": true,
    "outputPath": "/tmp/result.js"
  },
  "shadows": [
    {
      "backend": "local",
      "model": "llama3.2:latest",
      "duration": 45000,
      "tokens": 800,
      "cost": 0,
      "outputLength": 2100,
      "outputHash": "sha256:def...",
      "success": true,
      "qualityScore": null
    },
    {
      "backend": "codex",
      "model": "gpt-5.2-codex",
      "duration": 12000,
      "tokens": 1100,
      "cost": 0,
      "outputLength": 3200,
      "outputHash": "sha256:ghi...",
      "success": true,
      "qualityScore": null
    }
  ],
  "comparison": {
    "autoScore": 0.82,
    "userScore": null,
    "method": "auto",
    "details": {
      "lengthSimilarity": 0.85,
      "structureSimilarity": 0.78,
      "codeParses": true,
      "keyTermOverlap": 0.91
    }
  }
}
```

## Quality Comparison Methods

### Automatic (runs on every shadow)
1. **Output length ratio** — shadow output within 50-150% of primary = good signal
2. **Key term overlap** — extract important nouns/verbs from both, compute Jaccard similarity
3. **Structure similarity** — if code: count functions/classes/imports. If markdown: count headers/sections
4. **Code validity** — if output is code: does it parse? (AST parse for JS/Python, syntax check)
5. **File creation** — if task was "create file X": did shadow also create it? Does it exist and have content?
6. **Error detection** — did shadow output contain error messages, stack traces, "I can't" responses?
7. **Composite auto-score** — weighted average: terms(0.3) + structure(0.3) + length(0.2) + validity(0.2)

### User feedback (optional, via dashboard)
- Dashboard shows primary vs shadow outputs side-by-side
- User clicks: "Shadow is equivalent" / "Shadow is worse" / "Shadow is better"
- User scores override auto-scores and carry 3x weight in trust model
- Prompt in Telegram for high-value comparisons: "Local matched Claude Code 92% on this code task. Confirm? 👍/👎"

## Trust Model

### Per task-type per MODEL trust score
Trust is keyed on the **model**, not the backend/route. Opus 4.6 via Claude Code subscription and Opus 4.6 via API are the same model — learnings apply to both. This means:
- Shadow run on Claude Code (Opus 4.6) tells us about API (Opus 4.6) too
- Shadow run on Codex (GPT-5.2) tells us about that model regardless of route
- Local models (llama3.2, phi3) are unique to the local backend
- When routing, look up trust by model first, then fall back to backend-level trust

```json
{
  "code-generation": {
    "opus-4.6": { "score": 0.95, "samples": 20, "trend": "stable", "backends": ["claudeCode", "api"] },
    "gpt-5.2-codex": { "score": 0.88, "samples": 8, "trend": "stable", "backends": ["codex"] },
    "llama3.2": { "score": 0.45, "samples": 12, "trend": "improving", "backends": ["local"] }
  },
  "analysis": {
    "opus-4.6": { "score": 0.92, "samples": 15, "trend": "stable", "backends": ["claudeCode", "api"] },
    "llama3.2": { "score": 0.30, "samples": 5, "trend": "stable", "backends": ["local"] }
  }
}
```

### Model → Backend mapping
The router knows which models are available on which backends:
- `opus-4.6` → claudeCode (subscription, $0), api (Sonnet pricing)
- `gpt-5.2-codex` → codex (subscription, $0)
- `llama3.2` → local ($0)
- `sonnet-4` → api ($3/$15 per MTok)

When the trust model says "opus-4.6 handles code-gen at 0.95", the router knows it can get that via Claude Code for free OR via API for money. Obvious choice.

When trust says "llama3.2 handles file-ops at 0.87", the router routes file-ops to local — free AND trusted.
```

### Task types (auto-classified from description)
- `code-generation` — "write", "build", "create script", "implement"
- `code-review` — "review", "check", "audit code"
- `analysis` — "analyze", "compare", "evaluate", "assess"
- `writing` — "write doc", "draft", "summarize", "explain"
- `file-ops` — "create file", "move", "rename", "organize"
- `research` — "research", "find", "look up", "what is"
- `other` — fallback

### Trust thresholds
- **< 0.5 (10+ samples):** Backend is bad at this task type. Never route here.
- **0.5-0.7 (10+ samples):** Marginal. Route only if primary is unavailable.
- **0.7-0.85 (15+ samples):** Promising. Route here for non-critical tasks.
- **> 0.85 (20+ samples):** Trusted. Route here by default — proven equivalent.
- **Insufficient data (< 10 samples):** Keep shadowing, don't trust yet.

### Integration with adaptive scoring
- Trust scores feed directly into `index.js` adaptive scoring
- High trust → increase backend's adaptive score for that task type
- Low trust → decrease score
- This creates a feedback loop: shadow data → trust scores → better routing → more shadow data

## Persistence — SQLite Database

Use SQLite (`better-sqlite3` npm package) — single file at `data/shadow-bench.db`.

### Tables:

**shadow_results** — every shadow comparison
```sql
CREATE TABLE shadow_results (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  task_type TEXT NOT NULL,
  description TEXT,
  timestamp TEXT NOT NULL,
  primary_backend TEXT NOT NULL,
  primary_model TEXT NOT NULL,
  primary_duration_ms INTEGER,
  primary_tokens INTEGER,
  primary_cost REAL,
  primary_output_length INTEGER,
  primary_output_hash TEXT,
  primary_success INTEGER,
  shadow_backend TEXT NOT NULL,
  shadow_model TEXT NOT NULL,
  shadow_duration_ms INTEGER,
  shadow_tokens INTEGER,
  shadow_cost REAL,
  shadow_output_length INTEGER,
  shadow_output_hash TEXT,
  shadow_success INTEGER,
  auto_score REAL,
  user_score REAL,
  length_similarity REAL,
  structure_similarity REAL,
  key_term_overlap REAL,
  code_parses INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_task_type ON shadow_results(task_type);
CREATE INDEX idx_shadow_model ON shadow_results(shadow_model);
CREATE INDEX idx_timestamp ON shadow_results(timestamp);
```

**trust_scores** — computed trust per model per task type
```sql
CREATE TABLE trust_scores (
  model TEXT NOT NULL,
  task_type TEXT NOT NULL,
  score REAL NOT NULL,
  samples INTEGER NOT NULL,
  trend TEXT,
  backends TEXT,  -- JSON array of backends this model is available on
  last_updated TEXT,
  PRIMARY KEY (model, task_type)
);
```

**user_feedback** — explicit user quality ratings
```sql
CREATE TABLE user_feedback (
  shadow_id TEXT PRIMARY KEY,
  score REAL NOT NULL,  -- 0.0 to 1.0
  comment TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (shadow_id) REFERENCES shadow_results(id)
);
```

### Why SQLite over JSON:
- Query shadow results by task type, model, date range, score threshold
- Aggregate: AVG(auto_score) GROUP BY model, task_type — instant trust recalculation
- No memory issues: 100K results = ~50MB on disk, queries stay fast
- Single file, zero config, survives restarts, easy to backup
- Dashboard can query directly for charts and tables
- `better-sqlite3` is synchronous — no callback hell, just fast reads/writes

### Cleanup:
- DELETE FROM shadow_results WHERE timestamp < date('now', '-90 days') — quarterly cleanup
- No archiving needed, SQLite handles large tables fine
- VACUUM periodically to reclaim space

## API Endpoints (dashboard-server.js)
- `GET /api/shadow/results?limit=50` — recent shadow comparisons
- `GET /api/shadow/trust` — current trust model (all task types × backends)
- `POST /api/shadow/:id/feedback` — user quality feedback
- `GET /api/shadow/insights` — summary: "Local handles 85% of file-ops", "Codex matches Claude Code on code-gen"

## Dashboard View
Add a "Benchmarks" tab (7th view) to dashboard.html:
- **Trust Matrix** — heatmap grid: task types (rows) × backends (columns), colored by trust score
- **Recent Comparisons** — list of shadow runs with auto-score, expandable to see side-by-side output
- **Insights** — "You could save $X/month by routing [task type] to [backend]" based on trust data
- **Feedback Queue** — shadow comparisons awaiting user review, sorted by potential savings

## Module Exports
```javascript
module.exports = {
  shadowTask(taskId, description, primaryResult) → Promise<void>,  // Fire-and-forget
  getResults(options) → Promise<ShadowResult[]>,
  getTrust() → TrustModel,
  getTrustForTask(taskType, backend) → TrustScore,
  recordFeedback(shadowId, score) → void,
  getInsights() → Insight[],
  classifyTask(description) → string,  // Returns task type
  cleanup() → void  // Archive old results
}
```

## Integration Points
- `index.js` → after `router.route()` completes, call `shadowBench.shadowTask()` (fire-and-forget)
- `index.js` → in backend scoring, read `shadowBench.getTrustForTask()` to adjust scores
- `dashboard-server.js` → add shadow API endpoints
- `dashboard.html` → add Benchmarks tab
- `planner.js` → use `classifyTask()` for consistent task type labels

## Execution Flow
1. Primary task completes via router → result returned to user immediately
2. `shadowTask()` fires async — does NOT block
3. Shadow dispatches to local (always) + codex/claude-code (if applicable and not rate-limited)
4. Each shadow runs independently, writes result when done
5. When shadow completes, auto-comparison runs
6. Trust model updated
7. If high-value comparison, optional Telegram notification for user feedback
8. Next routing decision uses updated trust scores

## Advanced Features

### Cost Projections
Dashboard shows per task-type: "If you routed [task-type] to [model] instead of [current], you'd save $X/month with Y% quality match." Based on actual shadow data, not estimates. Updated daily.

### Regression Detection
Track model versions (Ollama model hash, Claude Code version, Codex version). When a version changes:
- Flag all trust scores for that model as "needs revalidation"
- Temporarily increase shadow frequency to 100% for that model
- After 10 new samples, recalculate trust
- If trust dropped >10%, send Telegram alert: "⚠️ llama3.2 quality dropped after update. Reverting routing."

### Auto-Scorer Calibration
Track drift between auto-scores and user feedback. If auto-scorer consistently over/under-rates a model:
- Calculate correction factor: `corrected = auto_score * calibration_factor`
- Store calibration per model: `{ "llama3.2": 0.85 }` means auto-scorer overrates by 15%
- Recalibrate monthly or after 50 user feedback entries, whichever comes first

```sql
CREATE TABLE scorer_calibration (
  model TEXT PRIMARY KEY,
  factor REAL NOT NULL DEFAULT 1.0,
  sample_count INTEGER,
  last_calibrated TEXT
);
```

### Difficulty Bands
Tasks within a type vary wildly. Use planner's complexity score (1-10) to create bands:
- **Easy (1-3):** "create a file", "write hello world", "simple lookup"
- **Medium (4-6):** "build a script with error handling", "analyze a document"
- **Hard (7-10):** "architect a multi-file system", "complex financial analysis"

Trust scores tracked per model × task-type × difficulty band. Local might be trusted for easy code-gen but not hard code-gen.

```sql
ALTER TABLE shadow_results ADD COLUMN difficulty_band TEXT; -- easy, medium, hard
ALTER TABLE trust_scores ADD COLUMN difficulty_band TEXT DEFAULT 'all';
```

### Promotion Events
When a model crosses the trust threshold with sufficient samples:
1. Send Telegram notification: "🎓 [model] is now trusted for [task-type] ([difficulty]). Projected savings: $X/month. Promote? 👍/👎"
2. User approves → router automatically prefers that model for that task type
3. User declines → keep shadowing, raise threshold
4. Track promotions in DB:

```sql
CREATE TABLE promotions (
  id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  task_type TEXT NOT NULL,
  difficulty_band TEXT,
  trust_score REAL,
  projected_monthly_savings REAL,
  status TEXT, -- pending, approved, declined, reverted
  promoted_at TEXT,
  reverted_at TEXT
);
```

### Auto-Revert
If a promoted model's rolling 7-day trust score drops below 0.7:
- Automatically revert to previous routing
- Send alert: "⚠️ [model] quality dropped for [task-type]. Reverted to [previous model]."
- Resume heavy shadowing to re-evaluate

## Config (config.json)
```json
{
  "shadowBench": {
    "enabled": true,
    "alwaysShadowLocal": true,
    "shadowCodexWhenIdle": true,
    "shadowClaudeCodeWhenIdle": true,
    "idleThresholdPercent": 50,
    "maxConcurrentShadows": 3,
    "autoCompare": true,
    "telegramFeedback": true,
    "telegramFeedbackThreshold": 0.7,
    "retentionDays": 30,
    "maxResults": 1000,
    "trustThresholds": {
      "bad": 0.5,
      "marginal": 0.7,
      "promising": 0.85,
      "trusted": 0.85,
      "minSamples": 10,
      "trustedMinSamples": 20
    }
  }
}
```
