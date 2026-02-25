const EventEmitter = require('events');

/**
 * OpenClaw Task Planner - Decomposition + Cost Estimation Engine
 * Breaks complex tasks into discrete steps with backend recommendations,
 * cost estimates, dependency graphs, and parallelization hints.
 */
class TaskPlanner extends EventEmitter {
  constructor() {
    super();
    this.config = null;
    this.initialized = false;

    // Model pricing (per million tokens)
    this.pricing = {
      'sonnet-4':   { input: 3.00, output: 15.00 },
      'haiku-4.5':  { input: 0.25, output: 1.25 },
      'opus-4.6':   { input: 15.00, output: 75.00 },
      'gemini':     { input: 1.25, output: 5.00 },
      'default':    { input: 3.00, output: 15.00 }
    };

    // Average minutes per step by backend
    this.timeEstimates = {
      'claude-code': 8,
      'codex':       5,
      'api':         2,
      'local':       4
    };

    // Keyword patterns for heuristic decomposition
    this.patterns = {
      fileOps:    /\b(ocr|pars[ei]|extract|scan|ingest|convert|transform file|read file|write file)/i,
      reasoning:  /\b(analy[sz]e|synthe[sz]i|recommend|evaluat|assess|reason|compar[ei]|review|audit|strateg)/i,
      simpleTx:   /\b(format|template|render|prettif|reformat|stringify|serialize|markdown)/i,
      multiCode:  /\b(refactor|implement across|multi.?file|codebase.?wide|full system|architect)/i,
      quickCode:  /\b(generate|write a function|write a script|create a class|stub|scaffold|boilerplate)/i,
      largeCtx:   /\b(entire codebase|all files|100k|large context|massive|comprehensive scan)/i,
      research:   /\b(research|investigat|survey|benchmark|compar.*options|explore alternatives)/i,
      testing:    /\b(test|spec|unit test|integration test|e2e|coverage)\b/i,
      docs:       /\b(document|readme|guide|tutorial|api docs|changelog)/i
    };
  }

  /**
   * Lazy-load config
   */
  loadConfig() {
    if (!this.config) {
      this.config = require('./config.json');
    }
  }

  // ─── Public API ────────────────────────────────────────────────

  /**
   * Decompose a task into an execution plan
   * @param {Object} task - { description, type, urgency, complexity, files, toolsNeeded, outputPath, metadata }
   * @returns {Object} Plan - { id, task, steps[], totalCost, totalTime, needsApproval }
   */
  decompose(task) {
    this.loadConfig();

    const planId = `plan_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const desc   = (task.description || '').trim();
    const complexity = task.complexity || this._inferComplexity(desc);

    // Simple tasks: no decomposition needed
    if (complexity <= 3 && desc.length < 200 && !(task.files && task.files.length > 2)) {
      const backend = this._pickSingleBackend(task);
      const tokens  = this._estimateTokens(desc, task.files);
      const step = {
        id: `${planId}_s1`,
        index: 0,
        description: desc,
        backend,
        estimatedTokens: tokens,
        estimatedCost: this._tokenCost(tokens, backend),
        estimatedMinutes: this.timeEstimates[backend] || 4,
        dependencies: [],
        parallelizable: false,
        critical: true,
        type: task.type || 'other'
      };

      return this._buildPlan(planId, task, [step]);
    }

    // Complex tasks: heuristic decomposition
    const steps = this._heuristicDecompose(planId, task, desc, complexity);
    return this._buildPlan(planId, task, steps);
  }

  /**
   * Estimate cost breakdown for a plan
   * @param {Object} plan - Plan object from decompose()
   * @returns {Object} CostBreakdown
   */
  estimateCost(plan) {
    let apiCost = 0;
    let subscriptionMinutes = 0;
    let localMinutes = 0;
    const perStep = [];

    for (const step of plan.steps) {
      const isSubscription = ['claude-code', 'codex'].includes(step.backend);
      const isLocal = step.backend === 'local';

      const entry = {
        stepId: step.id,
        description: step.description.substring(0, 80),
        backend: step.backend,
        estimatedTokens: step.estimatedTokens,
        estimatedCost: step.estimatedCost,
        estimatedMinutes: step.estimatedMinutes,
        isFree: isSubscription || isLocal
      };

      if (isSubscription) {
        subscriptionMinutes += step.estimatedMinutes;
      } else if (isLocal) {
        localMinutes += step.estimatedMinutes;
      } else {
        apiCost += step.estimatedCost;
      }

      perStep.push(entry);
    }

    // Calculate parallel time estimate
    const parallelTime = this._estimateParallelTime(plan.steps);

    return {
      planId: plan.id,
      totalApiCost: Math.round(apiCost * 10000) / 10000,
      totalSubscriptionMinutes: subscriptionMinutes,
      totalLocalMinutes: localMinutes,
      totalEstimatedMinutes: parallelTime,
      stepCount: plan.steps.length,
      needsApproval: apiCost > 2,
      perStep
    };
  }

  /**
   * Format plan for human-readable display
   * @param {Object} plan - Plan from decompose()
   * @returns {string} Formatted plan summary
   */
  formatPlanForUser(plan) {
    const cost = this.estimateCost(plan);
    const lines = [];

    lines.push(`═══ Task Plan: ${plan.id} ═══`);
    lines.push(`Task: ${plan.task.description.substring(0, 120)}`);
    lines.push(`Steps: ${plan.steps.length} | Est. time: ~${cost.totalEstimatedMinutes} min`);
    lines.push('');

    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      const costInfo = cost.perStep[i];
      const depStr = step.dependencies.length > 0
        ? ` (after step ${step.dependencies.map(d => plan.steps.findIndex(s => s.id === d) + 1).join(', ')})`
        : '';
      const parallelTag = step.parallelizable ? ' [parallel]' : '';
      const criticalTag = step.critical ? '' : ' [optional]';

      lines.push(`  ${i + 1}. ${step.description}`);
      lines.push(`     Backend: ${step.backend} | ~${step.estimatedMinutes} min | ${costInfo.isFree ? '$0 (subscription)' : '$' + step.estimatedCost.toFixed(4)}${depStr}${parallelTag}${criticalTag}`);
    }

    lines.push('');
    lines.push(`─── Cost Summary ───`);
    lines.push(`  API cost:          $${cost.totalApiCost.toFixed(4)}`);
    lines.push(`  Subscription time: ~${cost.totalSubscriptionMinutes} min`);
    lines.push(`  Local time:        ~${cost.totalLocalMinutes} min`);
    lines.push(`  Total wall-clock:  ~${cost.totalEstimatedMinutes} min`);

    if (cost.needsApproval) {
      lines.push('');
      lines.push(`⚠  API cost exceeds $2 — approval required before execution.`);
    }

    lines.push(`═══════════════════════════`);
    return lines.join('\n');
  }

  // ─── Heuristic Decomposition ──────────────────────────────────

  /**
   * @private Break task into steps using keyword heuristics
   */
  _heuristicDecompose(planId, task, desc, complexity) {
    const steps = [];
    let idx = 0;

    const hasFiles     = task.files && task.files.length > 0;
    const hasFileOps   = this.patterns.fileOps.test(desc);
    const hasReasoning = this.patterns.reasoning.test(desc);
    const hasSimpleTx  = this.patterns.simpleTx.test(desc);
    const hasMultiCode = this.patterns.multiCode.test(desc);
    const hasQuickCode = this.patterns.quickCode.test(desc);
    const hasLargeCtx  = this.patterns.largeCtx.test(desc);
    const hasResearch  = this.patterns.research.test(desc);
    const hasTesting   = this.patterns.testing.test(desc);
    const hasDocs      = this.patterns.docs.test(desc);

    // Step: File operations (OCR, parsing, extraction)
    if (hasFileOps || (hasFiles && task.files.length > 2)) {
      const fileStep = this._makeStep(planId, idx++, {
        description: `Process/extract data from files: ${(task.files || []).slice(0, 5).join(', ') || 'input files'}`,
        backend: 'codex',
        tokens: (task.files || []).length * 3000,
        minutes: Math.max(3, (task.files || []).length * 2),
        dependencies: [],
        parallelizable: true,
        critical: true,
        type: 'file-ops'
      });
      steps.push(fileStep);
    }

    // Step: Research / investigation
    if (hasResearch) {
      const researchStep = this._makeStep(planId, idx++, {
        description: `Research and gather information: ${desc.substring(0, 80)}`,
        backend: 'codex',
        tokens: 8000,
        minutes: 6,
        dependencies: [],
        parallelizable: true,
        critical: true,
        type: 'research'
      });
      steps.push(researchStep);
    }

    // Step: Large context handling
    if (hasLargeCtx) {
      const chunkStep = this._makeStep(planId, idx++, {
        description: 'Chunk large context and prepare summaries for downstream steps',
        backend: 'local',
        tokens: 12000,
        minutes: 5,
        dependencies: [],
        parallelizable: false,
        critical: true,
        type: 'preprocessing'
      });
      steps.push(chunkStep);
    }

    // Step: Multi-file code changes
    if (hasMultiCode) {
      const priorIds = steps.map(s => s.id);
      const codeStep = this._makeStep(planId, idx++, {
        description: `Implement multi-file code changes: ${desc.substring(0, 80)}`,
        backend: 'claude-code',
        tokens: complexity * 2000,
        minutes: Math.max(5, complexity * 1.5),
        dependencies: priorIds,
        parallelizable: false,
        critical: true,
        type: 'code'
      });
      steps.push(codeStep);
    }

    // Step: Quick code generation
    if (hasQuickCode && !hasMultiCode) {
      const priorIds = steps.filter(s => s.type === 'file-ops' || s.type === 'preprocessing').map(s => s.id);
      const quickStep = this._makeStep(planId, idx++, {
        description: `Generate code: ${desc.substring(0, 80)}`,
        backend: 'codex',
        tokens: 4000,
        minutes: 4,
        dependencies: priorIds,
        parallelizable: true,
        critical: true,
        type: 'code'
      });
      steps.push(quickStep);
    }

    // Step: Complex reasoning / analysis
    if (hasReasoning) {
      const priorIds = steps.map(s => s.id);
      const analysisStep = this._makeStep(planId, idx++, {
        description: `Analyze and synthesize findings: ${desc.substring(0, 80)}`,
        backend: complexity >= 7 ? 'api' : 'claude-code',
        tokens: complexity * 2500,
        minutes: Math.max(4, complexity),
        dependencies: priorIds,
        parallelizable: false,
        critical: true,
        type: 'analysis'
      });
      steps.push(analysisStep);
    }

    // Step: Testing
    if (hasTesting) {
      const codeSteps = steps.filter(s => s.type === 'code').map(s => s.id);
      const testStep = this._makeStep(planId, idx++, {
        description: 'Write and run tests for generated code',
        backend: 'codex',
        tokens: 4000,
        minutes: 5,
        dependencies: codeSteps.length > 0 ? codeSteps : steps.map(s => s.id),
        parallelizable: true,
        critical: false,
        type: 'testing'
      });
      steps.push(testStep);
    }

    // Step: Simple transforms / formatting
    if (hasSimpleTx) {
      const priorIds = steps.map(s => s.id);
      const txStep = this._makeStep(planId, idx++, {
        description: 'Format and template final output',
        backend: 'local',
        tokens: 2000,
        minutes: 2,
        dependencies: priorIds,
        parallelizable: false,
        critical: false,
        type: 'transform'
      });
      steps.push(txStep);
    }

    // Step: Documentation
    if (hasDocs) {
      const priorIds = steps.map(s => s.id);
      const docStep = this._makeStep(planId, idx++, {
        description: 'Generate documentation',
        backend: 'local',
        tokens: 3000,
        minutes: 3,
        dependencies: priorIds,
        parallelizable: false,
        critical: false,
        type: 'docs'
      });
      steps.push(docStep);
    }

    // If heuristics didn't produce steps, create a single catch-all
    if (steps.length === 0) {
      const backend = this._pickSingleBackend(task);
      const tokens  = this._estimateTokens(desc, task.files);
      steps.push(this._makeStep(planId, idx++, {
        description: desc,
        backend,
        tokens,
        minutes: this.timeEstimates[backend] || 4,
        dependencies: [],
        parallelizable: false,
        critical: true,
        type: task.type || 'other'
      }));
    }

    // Final synthesis step (if we have 2+ steps)
    if (steps.length >= 2) {
      const allIds = steps.map(s => s.id);
      const synthStep = this._makeStep(planId, idx++, {
        description: 'Combine outputs and produce final deliverable',
        backend: 'local',
        tokens: 3000,
        minutes: 3,
        dependencies: allIds.filter(id => {
          const s = steps.find(st => st.id === id);
          return s && s.critical;
        }),
        parallelizable: false,
        critical: true,
        type: 'synthesis'
      });
      steps.push(synthStep);
    }

    return steps;
  }

  // ─── Confidence Assessment (Agent 2) ─────────────────────────

  /**
   * Assess confidence that Oz can handle a task directly without routing.
   * @param {Object} task - { description, type?, toolsNeeded?, files?, outputPath? }
   * @returns {{ score: number, recommendation: 'self'|'offer'|'route', reason: string }}
   */
  assessConfidence(task) {
    const desc = (task.description || '').toLowerCase().trim();
    let score = 50; // start neutral
    const reasons = [];

    // ── Low-confidence signals (always route) ──────────────────

    const lowKeywords = /\b(build|create|write|refactor|analyze|implement|deploy|architect|migrate|generate|scaffold|redesign)\b/;
    if (lowKeywords.test(desc)) {
      score -= 30;
      reasons.push('action keyword requires deep work');
    }

    // Needs file creation
    if (task.outputPath || /\b(create file|new file|write to|save as|generate report)\b/.test(desc)) {
      score -= 20;
      reasons.push('file creation needed');
    }

    // Needs tools (shell, git, npm, etc.)
    if (task.toolsNeeded && task.toolsNeeded.length > 0) {
      score -= 25;
      reasons.push(`tools required: ${task.toolsNeeded.join(', ')}`);
    }
    if (/\b(run|execute|install|deploy|git |npm |pip |shell|terminal|command)\b/.test(desc)) {
      score -= 15;
      reasons.push('likely needs shell/tool access');
    }

    // Estimated long output
    const estimatedTokens = this._estimateTokens(desc, task.files);
    if (estimatedTokens > 10000) {
      score -= 20;
      reasons.push('estimated output >10K tokens');
    }

    // Multi-file tasks
    if (task.files && task.files.length > 2) {
      score -= 15;
      reasons.push('multi-file task');
    }

    // Complex task indicators
    if (this.patterns.multiCode.test(desc) || this.patterns.largeCtx.test(desc)) {
      score -= 20;
      reasons.push('complex/large-context task');
    }

    // ── High-confidence signals (self-handle) ──────────────────

    const highKeywords = /\b(what is|when is|who is|where is|how much|check|status|look up|remind me|what time|weather|define|meaning of)\b/;
    if (highKeywords.test(desc)) {
      score += 30;
      reasons.push('simple lookup/status question');
    }

    // Question with expected short answer
    if (desc.includes('?') && desc.length < 100) {
      score += 15;
      reasons.push('short question');
    }

    // Simple math / conversion
    if (/\b(calculate|convert|how many|sum|total|percentage|average)\b/.test(desc) && desc.length < 150) {
      score += 20;
      reasons.push('simple math/conversion');
    }

    // Calendar/schedule check
    if (/\b(calendar|schedule|meeting|appointment|agenda|next event)\b/.test(desc)) {
      score += 15;
      reasons.push('calendar/schedule lookup');
    }

    // Memory/recall
    if (/\b(remember|recall|last time|did i|what did)\b/.test(desc)) {
      score += 15;
      reasons.push('memory recall');
    }

    // Clamp score
    score = Math.max(0, Math.min(100, score));

    // Determine recommendation
    let recommendation;
    if (score > 95) {
      recommendation = 'self';
    } else if (score >= 50) {
      recommendation = 'offer';
    } else {
      recommendation = 'route';
    }

    const reason = reasons.length > 0 ? reasons.join('; ') : 'default assessment';

    return { score, recommendation, reason };
  }

  // ─── Helpers ──────────────────────────────────────────────────

  /**
   * @private Build a step object
   */
  _makeStep(planId, index, opts) {
    const backend = opts.backend || 'local';
    const tokens  = opts.tokens  || 2000;
    return {
      id: `${planId}_s${index + 1}`,
      index,
      description: opts.description,
      backend,
      estimatedTokens: tokens,
      estimatedCost: this._tokenCost(tokens, backend),
      estimatedMinutes: opts.minutes || this.timeEstimates[backend] || 4,
      dependencies: opts.dependencies || [],
      parallelizable: opts.parallelizable || false,
      critical: opts.critical !== undefined ? opts.critical : true,
      type: opts.type || 'other'
    };
  }

  /**
   * @private Build the full plan object
   */
  _buildPlan(planId, task, steps) {
    const cost = this._totalCost(steps);
    const time = this._estimateParallelTime(steps);

    return {
      id: planId,
      task: {
        description: task.description,
        type: task.type,
        urgency: task.urgency,
        complexity: task.complexity,
        files: task.files,
        outputPath: task.outputPath
      },
      steps,
      totalCost: Math.round(cost * 10000) / 10000,
      totalEstimatedMinutes: time,
      needsApproval: cost > 2,
      allSubscription: steps.every(s => ['claude-code', 'codex', 'local'].includes(s.backend)),
      createdAt: new Date().toISOString()
    };
  }

  /**
   * @private Calculate cost for tokens on a backend
   */
  _tokenCost(tokens, backend) {
    if (['claude-code', 'codex', 'local'].includes(backend)) {
      return 0; // Subscription / local = $0 marginal
    }
    const pricing = this.pricing['sonnet-4']; // default API model
    const inputTokens  = tokens * 0.7;
    const outputTokens = tokens * 0.3;
    return (inputTokens * pricing.input / 1_000_000) + (outputTokens * pricing.output / 1_000_000);
  }

  /**
   * @private Sum total cost
   */
  _totalCost(steps) {
    return steps.reduce((sum, s) => sum + s.estimatedCost, 0);
  }

  /**
   * @private Estimate wall-clock time considering parallelism
   */
  _estimateParallelTime(steps) {
    if (steps.length === 0) return 0;
    if (steps.length === 1) return steps[0].estimatedMinutes;

    // Build dependency graph and compute critical path
    const memo = {};
    const finish = (step) => {
      if (memo[step.id] !== undefined) return memo[step.id];
      if (step.dependencies.length === 0) {
        memo[step.id] = step.estimatedMinutes;
        return memo[step.id];
      }
      const maxDepFinish = Math.max(
        ...step.dependencies.map(depId => {
          const dep = steps.find(s => s.id === depId);
          return dep ? finish(dep) : 0;
        })
      );
      memo[step.id] = maxDepFinish + step.estimatedMinutes;
      return memo[step.id];
    };

    return Math.max(...steps.map(s => finish(s)));
  }

  /**
   * @private Pick a single backend for simple tasks
   */
  _pickSingleBackend(task) {
    const desc = (task.description || '').toLowerCase();
    const tools = task.toolsNeeded || [];

    if (tools.length > 0) return 'api';
    if (this.patterns.multiCode.test(desc)) return 'claude-code';
    if (this.patterns.quickCode.test(desc)) return 'codex';
    if (this.patterns.reasoning.test(desc)) return 'claude-code';
    if (this.patterns.fileOps.test(desc)) return 'codex';
    if (this.patterns.simpleTx.test(desc)) return 'local';
    if (this.patterns.docs.test(desc)) return 'local';

    const complexity = task.complexity || this._inferComplexity(desc);
    if (complexity >= 7) return 'claude-code';
    if (complexity >= 4) return 'codex';
    return 'local';
  }

  /**
   * @private Estimate token count
   */
  _estimateTokens(description, files) {
    let tokens = (description || '').length / 4;
    tokens *= 1.3; // overhead
    if (files && files.length > 0) {
      tokens += files.length * 2000;
    }
    return Math.max(500, Math.ceil(tokens));
  }

  /**
   * @private Infer complexity from description
   */
  _inferComplexity(desc) {
    let c = 5;
    const d = desc.toLowerCase();
    const words = d.split(/\s+/);
    const wordCount = words.length;
    
    // Simple indicators (reduce complexity)
    const simplePatterns = [
      /\b(rename|typo|fix typo|add comment|one.line|trivial)\b/,
      /\b(alias|lint|delete|remove)\b/,
      /\b(change .* to|swap|replace .* with|capitalize|update .* to|set .* to)\b/,
      /\b(semicolon|whitespace|trailing|flag|version|order|const|var|let)\b/,
    ];
    // "simple" and "basic" only reduce by 1 (they appear in medium tasks too)
    const softSimple = /\b(simple|basic|convert|format|sort)\b/.test(d) ? 1 : 0;
    const simpleHits = simplePatterns.filter(p => p.test(d)).length;
    c -= simpleHits * 1.5;
    c -= softSimple;
    
    // Short tasks are usually simple
    if (wordCount <= 12) c -= 1;
    if (wordCount <= 8) c -= 1;
    if (wordCount <= 5) c -= 1;
    
    // Medium indicators
    const mediumPatterns = [
      /\b(unit test|endpoint|middleware|migration|handler|validator)\b/,
      /\b(refactor|implement|create|build)\b/,
      /\b(caching|queue|webhook|api)\b/,
    ];
    const mediumHits = mediumPatterns.filter(p => p.test(d)).length;
    if (mediumHits >= 2) c += 1;
    
    // Complex indicators (increase complexity)
    const complexPatterns = [
      /\b(comprehensive|complete|entire|full system|end.to.end)\b/,
      /\b(pipeline|architecture|platform|stack|infrastructure)\b/,
      /\b(multiple|multi.tenant|distributed|cross.service)\b/,
      /\b(oauth|rbac|role.based|access control|pci compliance)\b/,
      /\b(anomaly detection|machine learning|escalation|failover)\b/,
      /\b(design and (build|implement)|redesign|rewrite|architect)\b/,
      /\b(provisioning|orchestration|exactly.once|leader election)\b/,
      /\b(billing|compliance|isolation|retraining|drift)\b/,
    ];
    const complexHits = complexPatterns.filter(p => p.test(d)).length;
    c += complexHits * 1.5;
    
    // Long descriptions usually mean complex tasks
    if (wordCount > 20) c += 1;
    if (wordCount > 35) c += 2;
    if (wordCount > 60) c += 2;
    if (d.length > 200) c += 1;
    if (d.length > 400) c += 1;
    
    // Multiple conjunctions / feature lists suggest multi-part work
    const andCount = (d.match(/\band\b/g) || []).length;
    if (andCount >= 2) c += 1;
    if (andCount >= 4) c += 1;
    if (andCount >= 6) c += 1;
    
    // Count technical nouns as complexity signal
    const techTerms = d.match(/\b(api|database|service|model|queue|cache|auth|token|webhook|migration|deployment|monitoring|testing|scaling|replication|sharding)\b/g) || [];
    if (techTerms.length >= 4) c += 1;
    if (techTerms.length >= 7) c += 1;
    
    return Math.min(10, Math.max(1, Math.round(c)));
  }
}

module.exports = new TaskPlanner();
