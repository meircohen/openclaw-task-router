const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

let Database;
try {
  // eslint-disable-next-line global-require
  Database = require('better-sqlite3');
} catch (error) {
  Database = null;
}

const DEFAULT_CONFIG = {
  enabled: true,
  alwaysShadowLocal: true,
  shadowCodexWhenIdle: true,
  shadowClaudeCodeWhenIdle: true,
  idleThresholdPercent: 50,
  maxConcurrentShadows: 3,
  autoCompare: true,
  telegramFeedback: true,
  telegramFeedbackThreshold: 0.7,
  retentionDays: 30,
  maxResults: 1000,
  trustThresholds: {
    bad: 0.5,
    marginal: 0.7,
    promising: 0.85,
    trusted: 0.85,
    minSamples: 10,
    trustedMinSamples: 20
  }
};

let db = null;

function getConfig() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_CONFIG,
      ...(parsed.shadowBench || {})
    };
  } catch (_) {
    return { ...DEFAULT_CONFIG };
  }
}

function ensureDatabase() {
  if (db) return db;
  if (!Database) {
    throw new Error('better-sqlite3 not installed. Run: npm install better-sqlite3');
  }

  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const dbPath = path.join(dataDir, 'shadow-bench.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS shadow_results (
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
    CREATE INDEX IF NOT EXISTS idx_task_type ON shadow_results(task_type);
    CREATE INDEX IF NOT EXISTS idx_shadow_model ON shadow_results(shadow_model);
    CREATE INDEX IF NOT EXISTS idx_timestamp ON shadow_results(timestamp);

    CREATE TABLE IF NOT EXISTS trust_scores (
      model TEXT NOT NULL,
      task_type TEXT NOT NULL,
      score REAL NOT NULL,
      samples INTEGER NOT NULL,
      trend TEXT,
      backends TEXT,
      last_updated TEXT,
      PRIMARY KEY (model, task_type)
    );

    CREATE TABLE IF NOT EXISTS user_feedback (
      shadow_id TEXT PRIMARY KEY,
      score REAL NOT NULL,
      comment TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (shadow_id) REFERENCES shadow_results(id)
    );

    CREATE TABLE IF NOT EXISTS scorer_calibration (
      model TEXT PRIMARY KEY,
      factor REAL NOT NULL DEFAULT 1.0,
      sample_count INTEGER,
      last_calibrated TEXT
    );

    CREATE TABLE IF NOT EXISTS promotions (
      id TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      task_type TEXT NOT NULL,
      difficulty_band TEXT,
      trust_score REAL,
      projected_monthly_savings REAL,
      status TEXT,
      promoted_at TEXT,
      reverted_at TEXT
    );
  `);

  ensureColumn('shadow_results', 'difficulty_band', "TEXT");
  ensureColumn('trust_scores', 'difficulty_band', "TEXT DEFAULT 'all'");

  return db;
}

function ensureColumn(table, column, definition) {
  const info = db.prepare(`PRAGMA table_info(${table})`).all();
  const exists = info.some(col => col.name === column);
  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function safeHash(value) {
  if (!value) return null;
  const hash = crypto.createHash('sha256').update(value).digest('hex');
  return `sha256:${hash}`;
}

function normalizeText(value) {
  return (value || '').toString();
}

function wordSet(text) {
  const stop = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'have', 'will', 'should', 'your', 'you', 'are', 'was', 'were', 'into', 'been', 'over', 'under', 'about', 'after', 'before', 'they', 'their', 'there', 'them', 'then', 'than', 'but', 'not', 'can', 'could', 'would', 'must', 'may', 'might', 'such', 'also', 'only', 'when', 'where', 'what', 'which']);
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 4 && !stop.has(t));
  return new Set(tokens);
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function lengthSimilarity(primary, shadow) {
  const a = primary.length;
  const b = shadow.length;
  if (a === 0 || b === 0) return 0;
  const ratio = Math.min(a, b) / Math.max(a, b);
  return Math.max(0, Math.min(1, ratio));
}

function structureSimilarity(primary, shadow) {
  const primaryLines = primary.split(/\n/);
  const shadowLines = shadow.split(/\n/);

  const primaryHeaders = primaryLines.filter(l => l.trim().startsWith('#')).length;
  const shadowHeaders = shadowLines.filter(l => l.trim().startsWith('#')).length;

  const primaryCodeMarkers = primaryLines.filter(l => /\b(function|class|const|let|import|def|module|export)\b/.test(l)).length;
  const shadowCodeMarkers = shadowLines.filter(l => /\b(function|class|const|let|import|def|module|export)\b/.test(l)).length;

  const primarySignal = primaryHeaders + primaryCodeMarkers;
  const shadowSignal = shadowHeaders + shadowCodeMarkers;

  if (primarySignal === 0 || shadowSignal === 0) {
    return lengthSimilarity(primary, shadow);
  }

  const ratio = Math.min(primarySignal, shadowSignal) / Math.max(primarySignal, shadowSignal);
  return Math.max(0, Math.min(1, ratio));
}

function codeParses(primaryResult, shadowOutput) {
  const primaryPath = primaryResult?.outputPath || '';
  const looksLikeJs = primaryPath.endsWith('.js') || /\b(function|const|let|class|module\.exports|export)\b/.test(shadowOutput);
  if (!looksLikeJs) return 1;

  try {
    // eslint-disable-next-line no-new-func
    new Function(shadowOutput);
    return 1;
  } catch (_) {
    return 0;
  }
}

function errorDetected(text) {
  return /\b(error|stack trace|traceback|cannot|can't|failed|exception)\b/i.test(text);
}

function classifyTask(description) {
  const desc = (description || '').toLowerCase();
  if (/\b(review|audit|check)\b/.test(desc)) return 'code-review';
  if (/\b(analy[sz]e|compare|evaluate|assess)\b/.test(desc)) return 'analysis';
  if (/\b(write|build|create|implement|generate|scaffold)\b/.test(desc)) return 'code-generation';
  if (/\b(draft|summarize|explain|doc|documentation|write doc)\b/.test(desc)) return 'writing';
  if (/\b(create file|move|rename|organize|delete file|file ops)\b/.test(desc)) return 'file-ops';
  if (/\b(research|find|look up|investigate)\b/.test(desc)) return 'research';
  return 'other';
}

function difficultyBand(description, primaryResult) {
  if (primaryResult?.complexity) {
    if (primaryResult.complexity <= 3) return 'easy';
    if (primaryResult.complexity <= 6) return 'medium';
    return 'hard';
  }

  const desc = description || '';
  if (desc.length < 120) return 'easy';
  if (desc.length < 280) return 'medium';
  return 'hard';
}

function buildShadowTask(baseTask, backend, taskType) {
  const tmpDir = path.join(os.tmpdir(), 'openclaw-shadow');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const outputPath = path.join(tmpDir, `shadow-${backend}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);

  return {
    description: baseTask.description,
    type: taskType,
    urgency: baseTask.urgency || 'background',
    complexity: baseTask.complexity || 5,
    files: baseTask.files || [],
    toolsNeeded: baseTask.toolsNeeded || [],
    outputPath,
    metadata: {
      ...(baseTask.metadata || {}),
      shadow: true,
      shadowBackend: backend
    }
  };
}

async function canShadowBackend(backend, config) {
  let rateGovernor = null;
  try {
    // eslint-disable-next-line global-require
    rateGovernor = require('./rate-governor');
  } catch (_) {
    rateGovernor = null;
  }

  if (rateGovernor && typeof rateGovernor.canUse === 'function') {
    const status = await rateGovernor.canUse(backend);
    if (!status?.allowed) return false;
    if (typeof status.usagePercent === 'number' && status.usagePercent >= config.idleThresholdPercent) {
      return false;
    }
  }

  if (backend === 'codex') {
    const codex = require('./codex');
    if (!await codex.isAvailable()) return false;
    const status = await codex.getSessionStatus();
    return status.usagePercentage < config.idleThresholdPercent && status.availableSlots > 0;
  }

  if (backend === 'claudeCode') {
    const claude = require('./claude-code');
    if (!await claude.isAvailable()) return false;
    const status = await claude.getSessionStatus();
    return status.usagePercentage < config.idleThresholdPercent;
  }

  return false;
}

function compareOutputs(primaryOutput, shadowOutput, primaryResult) {
  const primaryText = normalizeText(primaryOutput);
  const shadowText = normalizeText(shadowOutput);

  const lengthSim = lengthSimilarity(primaryText, shadowText);
  const keyOverlap = jaccard(wordSet(primaryText), wordSet(shadowText));
  const structureSim = structureSimilarity(primaryText, shadowText);
  const parses = codeParses(primaryResult, shadowText);

  let autoScore = (keyOverlap * 0.3) + (structureSim * 0.3) + (lengthSim * 0.2) + (parses * 0.2);
  if (errorDetected(shadowText)) {
    autoScore *= 0.6;
  }

  return {
    autoScore: Math.max(0, Math.min(1, autoScore)),
    lengthSim,
    structureSim,
    keyOverlap,
    parses
  };
}

function updateTrustScores(model, taskType, band) {
  const database = ensureDatabase();
  const bands = [band, 'all'];

  for (const currentBand of bands) {
    const rows = database.prepare(`
      SELECT auto_score, user_score
      FROM shadow_results
      WHERE shadow_model = ? AND task_type = ? AND (difficulty_band = ? OR ? = 'all')
    `).all(model, taskType, currentBand, currentBand);

    if (rows.length === 0) continue;

    let total = 0;
    let weightSum = 0;
    for (const row of rows) {
      const score = row.user_score !== null && row.user_score !== undefined ? row.user_score : row.auto_score;
      const weight = row.user_score !== null && row.user_score !== undefined ? 3 : 1;
      if (typeof score === 'number') {
        total += score * weight;
        weightSum += weight;
      }
    }

    const score = weightSum === 0 ? 0 : total / weightSum;
    const backends = database.prepare(`
      SELECT DISTINCT shadow_backend
      FROM shadow_results
      WHERE shadow_model = ? AND task_type = ? AND (difficulty_band = ? OR ? = 'all')
    `).all(model, taskType, currentBand, currentBand).map(r => r.shadow_backend);

    database.prepare(`
      INSERT INTO trust_scores (model, task_type, score, samples, trend, backends, last_updated, difficulty_band)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(model, task_type) DO UPDATE SET
        score = excluded.score,
        samples = excluded.samples,
        trend = excluded.trend,
        backends = excluded.backends,
        last_updated = excluded.last_updated,
        difficulty_band = excluded.difficulty_band
    `).run(
      model,
      taskType,
      Math.round(score * 1000) / 1000,
      rows.length,
      'stable',
      JSON.stringify(backends),
      new Date().toISOString(),
      currentBand
    );
  }
}

async function shadowTask(taskId, description, primaryResult) {
  const config = getConfig();
  if (!config.enabled) return;

  const database = ensureDatabase();
  const taskType = classifyTask(description);
  const band = difficultyBand(description, primaryResult);

  const primaryOutput = primaryResult?.response || '';
  const primaryRecord = {
    backend: primaryResult?.backend || 'unknown',
    model: primaryResult?.model || 'unknown',
    duration: primaryResult?.duration || null,
    tokens: primaryResult?.tokens || null,
    cost: primaryResult?.cost || null,
    outputLength: primaryOutput.length,
    outputHash: safeHash(primaryOutput),
    success: primaryResult?.success ? 1 : 0
  };

  const baseTask = {
    description,
    urgency: 'background',
    complexity: primaryResult?.complexity || 5,
    files: primaryResult?.files || [],
    toolsNeeded: primaryResult?.toolsNeeded || [],
    metadata: { shadowOf: taskId }
  };

  const backends = [];
  if (config.alwaysShadowLocal) {
    backends.push('local');
  }

  if (config.shadowCodexWhenIdle && await canShadowBackend('codex', config)) {
    backends.push('codex');
  }

  if (config.shadowClaudeCodeWhenIdle && await canShadowBackend('claudeCode', config)) {
    backends.push('claudeCode');
  }

  const concurrency = Math.max(1, config.maxConcurrentShadows || 1);

  async function runShadow(backend) {
    const shadowId = `shadow_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    let shadowResult = null;
    let error = null;

    try {
      const task = buildShadowTask(baseTask, backend, taskType);
      if (backend === 'local') {
        const local = require('./local');
        shadowResult = await local.executeTask(task);
      } else if (backend === 'codex') {
        const codex = require('./codex');
        shadowResult = await codex.executeTask(task);
      } else if (backend === 'claudeCode') {
        const claude = require('./claude-code');
        shadowResult = await claude.executeTask(task);
      } else {
        throw new Error(`Unsupported shadow backend: ${backend}`);
      }
    } catch (err) {
      error = err;
    }

    const shadowOutput = shadowResult?.response || error?.message || '';
    const comparison = compareOutputs(primaryOutput, shadowOutput, primaryResult);

    database.prepare(`
      INSERT INTO shadow_results (
        id, task_id, task_type, description, timestamp,
        primary_backend, primary_model, primary_duration_ms, primary_tokens, primary_cost,
        primary_output_length, primary_output_hash, primary_success,
        shadow_backend, shadow_model, shadow_duration_ms, shadow_tokens, shadow_cost,
        shadow_output_length, shadow_output_hash, shadow_success,
        auto_score, user_score, length_similarity, structure_similarity, key_term_overlap, code_parses,
        difficulty_band
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?
      )
    `).run(
      shadowId,
      taskId,
      taskType,
      description,
      new Date().toISOString(),
      primaryRecord.backend,
      primaryRecord.model,
      primaryRecord.duration,
      primaryRecord.tokens,
      primaryRecord.cost,
      primaryRecord.outputLength,
      primaryRecord.outputHash,
      primaryRecord.success,
      backend,
      shadowResult?.model || backend,
      shadowResult?.duration || null,
      shadowResult?.tokens || null,
      shadowResult?.cost || null,
      shadowOutput.length,
      safeHash(shadowOutput),
      shadowResult?.success ? 1 : 0,
      comparison.autoScore,
      null,
      comparison.lengthSim,
      comparison.structureSim,
      comparison.keyOverlap,
      comparison.parses,
      band
    );

    updateTrustScores(shadowResult?.model || backend, taskType, band);
  }

  const queue = [...backends];
  const active = [];

  while (queue.length > 0) {
    while (active.length < concurrency && queue.length > 0) {
      const backend = queue.shift();
      const promise = runShadow(backend).finally(() => {
        const idx = active.findIndex(p => p === promise);
        if (idx >= 0) active.splice(idx, 1);
      });
      active.push(promise);
    }
    if (active.length > 0) {
      await Promise.race(active);
    }
  }

  if (active.length > 0) {
    await Promise.allSettled(active);
  }
}

function getResults(options = {}) {
  const config = getConfig();
  const database = ensureDatabase();
  const limit = Math.min(parseInt(options.limit || config.maxResults, 10) || config.maxResults, config.maxResults);
  const rows = database.prepare(`
    SELECT * FROM shadow_results
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(limit);

  return rows;
}

function getTrust() {
  const database = ensureDatabase();
  const rows = database.prepare('SELECT * FROM trust_scores').all();
  const trust = {};

  for (const row of rows) {
    if (!trust[row.task_type]) trust[row.task_type] = {};
    trust[row.task_type][row.model] = {
      score: row.score,
      samples: row.samples,
      trend: row.trend,
      backends: row.backends ? JSON.parse(row.backends) : [],
      difficultyBand: row.difficulty_band || 'all',
      lastUpdated: row.last_updated
    };
  }

  return trust;
}

function getTrustForTask(taskType, backend) {
  const database = ensureDatabase();
  const rows = database.prepare(`
    SELECT * FROM trust_scores
    WHERE task_type = ?
  `).all(taskType);

  if (rows.length === 0) return null;

  const filtered = backend
    ? rows.filter(row => {
      try {
        const backends = row.backends ? JSON.parse(row.backends) : [];
        return backends.includes(backend);
      } catch (_) {
        return false;
      }
    })
    : rows;

  if (filtered.length === 0) return null;

  filtered.sort((a, b) => b.score - a.score);
  const best = filtered[0];
  return {
    model: best.model,
    taskType: best.task_type,
    score: best.score,
    samples: best.samples,
    trend: best.trend,
    backends: best.backends ? JSON.parse(best.backends) : [],
    difficultyBand: best.difficulty_band || 'all',
    lastUpdated: best.last_updated
  };
}

function recordFeedback(shadowId, score, comment = null) {
  const database = ensureDatabase();
  database.prepare(`
    INSERT OR REPLACE INTO user_feedback (shadow_id, score, comment, created_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(shadowId, score, comment);

  database.prepare(`
    UPDATE shadow_results
    SET user_score = ?
    WHERE id = ?
  `).run(score, shadowId);

  const row = database.prepare('SELECT shadow_model, task_type, difficulty_band FROM shadow_results WHERE id = ?').get(shadowId);
  if (row) {
    updateTrustScores(row.shadow_model, row.task_type, row.difficulty_band || 'all');
  }
}

function getInsights() {
  const config = getConfig();
  const database = ensureDatabase();
  const rows = database.prepare('SELECT * FROM trust_scores').all();
  const insights = [];

  const byTask = {};
  for (const row of rows) {
    if (!byTask[row.task_type]) byTask[row.task_type] = [];
    byTask[row.task_type].push(row);
  }

  for (const [taskType, models] of Object.entries(byTask)) {
    models.sort((a, b) => b.score - a.score);
    const best = models[0];
    if (!best) continue;

    if (best.score >= config.trustThresholds.promising && best.samples >= config.trustThresholds.minSamples) {
      insights.push({
        type: 'trust',
        taskType,
        model: best.model,
        score: best.score,
        samples: best.samples,
        message: `${best.model} is promising for ${taskType} (${best.score.toFixed(2)} over ${best.samples} samples).`
      });
    }

    const local = models.find(m => (m.backends || '').includes('local'));
    if (local && local.score >= config.trustThresholds.promising) {
      insights.push({
        type: 'local',
        taskType,
        model: local.model,
        score: local.score,
        samples: local.samples,
        message: `Local model ${local.model} handles ${taskType} well (${local.score.toFixed(2)}).`
      });
    }
  }

  return insights;
}

function cleanup() {
  const config = getConfig();
  const database = ensureDatabase();
  database.prepare(`
    DELETE FROM shadow_results
    WHERE timestamp < date('now', ?)
  `).run(`-${config.retentionDays} days`);
  database.exec('VACUUM');
}

module.exports = {
  shadowTask,
  getResults,
  getTrust,
  getTrustForTask,
  recordFeedback,
  getInsights,
  classifyTask,
  cleanup
};
