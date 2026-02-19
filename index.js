const ledger = require('./ledger');
const monitor = require('./monitor');
const queue = require('./queue');
const claudeCode = require('./claude-code');
const codex = require('./codex');
const local = require('./local');
const planner = require('./planner');
const scheduler = require('./scheduler');
const notify = require('./notify');
// ── Agent 2: Circuit breaker + confidence + dedup + rate governor ──
const circuitBreaker = require('./circuit-breaker');
const dedup = require('./dedup');
const rateGovernor = require('./rate-governor');
// ── Agent 3: Session continuity + warm standby ──
const session = require('./session');
const warmup = require('./warmup');
const shadowBench = require('./shadow-bench');
// ── Model marketplace ──
const modelRegistry = require('./model-registry');

/**
 * OpenClaw Task Router v2 - Main Decision Engine
 * Smart routing system with task decomposition, multi-route execution,
 * and subscription queue management.
 */
class TaskRouter {
  constructor() {
    this.config = null;
    this.initialized = false;
    this.fallbackChain = ['api', 'local']; // Final fallback order
  }

  /**
   * Initialize the task router and all backends
   * @returns {Promise<void>}
   */
  async initialize() {
    if (this.initialized) {
      return;
    }

    console.log('[ROUTER] Initializing OpenClaw Task Router v2...');

    try {
      // Load configuration
      this.config = require('./config.json');

      // Initialize core systems
      await ledger.load();
      await monitor.load();
      await queue.load();
      await scheduler.load();

      // Initialize backends
      await claudeCode.initialize();
      await codex.initialize();
      await local.initialize();

      // Initialize model registry
      await modelRegistry.load();
      console.log('[ROUTER] Model registry initialized');

      // Start queue scheduler if enabled
      if (this.config.routing?.queueEnabled !== false) {
        await queue.startScheduler();
      }

      // Start subscription scheduler if enabled
      if (this.config.scheduler?.enabled !== false) {
        scheduler.start();
      }

      // Wire scheduler events to Telegram notifications
      if (this.config.notifications?.enabled !== false) {
        notify.wireSchedulerEvents(scheduler);
      }

      // ── Agent 2: Initialize circuit breaker + dedup + rate governor ──
      await circuitBreaker.load();
      if (this.config.circuitBreaker) {
        circuitBreaker.configure(this.config.circuitBreaker);
      }
      await dedup.load();
      if (this.config.dedup) {
        dedup.configure(this.config.dedup);
      }
      await rateGovernor.load();
      
      // Configure rate limits from backend config
      rateGovernor.configureRateLimits(this.config);
      
      if (this.config.rateGovernor) {
        // Apply any additional rate governor configuration if present
        console.log('[ROUTER] Rate governor loaded and configured from backend settings');
      } else {
        console.log('[ROUTER] Rate governor loaded with backend rate limit settings');
      }

      // ── Agent 3: Initialize session continuity + warm standby ──
      if (this.config.session?.enabled !== false) {
        await session.load();
        console.log('[ROUTER] Session continuity loaded');
      }
      if (this.config.warmup?.enabled !== false) {
        await warmup.startWarmup(this.config, this.config.warmup?.intervalMs);
        console.log('[ROUTER] Warm standby started');
      }

      this.initialized = true;
      console.log('[ROUTER] Initialization complete');

    } catch (error) {
      console.error('[ROUTER] Initialization failed:', error.message);
      throw new Error(`Router initialization failed: ${error.message}`);
    }
  }

  /**
   * Generate speakable result for voice interface
   * @param {string} backend - Selected backend
   * @param {Object} scoring - Task scoring
   * @param {Object} result - Execution result
   * @returns {string} Speakable description
   */
  generateSpeakableResult(backend, scoring, result) {
    const backendNames = {
      claudeCode: 'Claude Code',
      codex: 'Codex',
      api: 'API',
      local: 'Local'
    };

    const backendName = backendNames[backend] || backend;
    const duration = Math.round(scoring.estimatedTokens / 1000); // Rough time estimate in minutes
    const cost = scoring.estimatedCost;

    if (cost === 0) {
      return `Routing to ${backendName}. Estimated ${duration < 1 ? 'thirty seconds' : duration === 1 ? 'one minute' : `${duration} minutes`}, zero cost.`;
    } else if (cost < 0.10) {
      return `Routing to ${backendName}. Estimated ${duration < 1 ? 'thirty seconds' : duration === 1 ? 'one minute' : `${duration} minutes`}, under ten cents.`;
    } else if (cost < 1.00) {
      const cents = Math.round(cost * 100);
      return `Routing to ${backendName}. This will cost about ${cents} cents on API. Estimated ${duration < 1 ? 'thirty seconds' : duration === 1 ? 'one minute' : `${duration} minutes`}.`;
    } else {
      const dollars = cost < 2 ? cost.toFixed(2) : Math.round(cost * 100) / 100;
      const costText = dollars < 2 ? `${dollars} dollars` : 
                      dollars < 10 ? `${dollars.toFixed(0)} dollars` : 
                      `${dollars.toFixed(0)} dollars`;
      
      return `This will cost about ${costText} on API. Should I proceed?`;
    }
  }

  /**
   * Route a task to the optimal backend
   * @param {Object} task - Task object with description, type, urgency, complexity, toolsNeeded, files, outputPath
   * @param {Object} [options] - Routing options
   * @param {boolean} [options.plan] - If true, return a plan without executing
   * @returns {Promise<Object>} Routing result or Plan
   */
  async route(task, options = {}) {
    if (!this.initialized) {
      await this.initialize();
    }

    // ── Agent 2: Confidence-based self-handling ──
    if (this.config.confidence?.enabled !== false && !options.plan && !options.skipConfidence) {
      const confidence = planner.assessConfidence(task);
      if (confidence.recommendation === 'self') {
        console.log(`[ROUTER] Self-handle (confidence ${confidence.score}%): ${confidence.reason}`);
        return { selfHandle: true, confidence, reason: confidence.reason };
      }
      if (confidence.recommendation === 'offer') {
        options._confidenceOffer = confidence;
      }
    }

    // ── Agent 2: Dedup check ──
    if (this.config.dedup?.enabled !== false && !options.plan && !options.skipDedup) {
      const dedupResult = dedup.check(task);
      if (dedupResult.isDuplicate) {
        console.log(`[ROUTER] Duplicate detected (${(dedupResult.similarity * 100).toFixed(0)}% match with ${dedupResult.existingTaskId})`);
        return {
          success: false,
          duplicate: true,
          existingTaskId: dedupResult.existingTaskId,
          similarity: dedupResult.similarity,
          recommendation: dedupResult.recommendation,
          message: `Duplicate of ${dedupResult.existingTaskId} (${(dedupResult.similarity * 100).toFixed(0)}% match)`
        };
      }
      if (dedupResult.recommendation === 'warn') {
        console.log(`[ROUTER] Similar task warning (${(dedupResult.similarity * 100).toFixed(0)}% match)`);
        options._dedupWarning = dedupResult;
      }
    }

    // ── Plan mode: decompose and return plan without executing ──
    if (options.plan) {
      const plan = planner.decompose(task);
      const costBreakdown = planner.estimateCost(plan);
      const formatted = planner.formatPlanForUser(plan);

      const threshold = this.config.notifications?.autoApproveThresholdUsd
        ?? this.config.planner?.approvalThresholdUsd ?? 2;

      // If cost exceeds threshold, send approval notification and store as pending
      if (costBreakdown.totalApiCost > threshold) {
        if (this.config.notifications?.enabled !== false) {
          notify.sendPlanApproval(plan, costBreakdown);
        } else {
          notify.storePendingPlan(plan.id, plan, costBreakdown);
        }
      }

      return {
        mode: 'plan',
        plan,
        costBreakdown,
        formatted,
        needsApproval: costBreakdown.needsApproval
      };
    }

    const startTime = Date.now();
    const taskId = `route_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

    console.log(`[ROUTER] Routing task ${taskId}: ${task.description?.substring(0, 100)}...`);

    // ── Agent 3: Register task in active context ──
    if (this.config.session?.enabled !== false) {
      await session.addTask({
        taskId,
        description: task.description,
        status: 'running',
        startedFrom: task.metadata?.channel || 'cli',
        outputPath: task.outputPath || null
      });
      if (task.metadata?.channel) {
        await session.setChannelActive(task.metadata.channel, taskId);
      }
    }

    try {
      // Validate and normalize task
      const normalizedTask = this.normalizeTask(task);

      // Score task on multiple dimensions
      const scoring = await this.scoreTask(normalizedTask);

      // Determine optimal backend
      const backend = await this.selectBackend(normalizedTask, scoring);

      // Check if task should be queued instead of executed immediately
      if (this.shouldQueue(normalizedTask, backend)) {
        const queueResult = await this.enqueueTask(normalizedTask, backend);
        const queueSpeakable = `Task queued for ${backend} execution. I'll let you know when it's done.`;
        return {
          success: true,
          backend: 'queue',
          queued: true,
          taskId: queueResult,
          message: `Task queued for ${backend} execution`,
          duration: Date.now() - startTime,
          speakableResult: queueSpeakable,
          confirmationNeeded: false
        };
      }

      // Execute task with selected backend
      const result = await this.executeWithBackend(backend, normalizedTask, scoring);

      // Record success
      await monitor.recordResult(backend, normalizedTask, true, result.duration, result.tokens);

      // ── Agent 2: Register completed task in dedup tracker ──
      if (this.config.dedup?.enabled !== false) {
        dedup.register(taskId, normalizedTask);
        dedup.complete(taskId);
      }

      console.log(`[ROUTER] Task ${taskId} completed via ${backend} in ${(result.duration / 1000).toFixed(1)}s`);

      // ── Agent 3: Mark task complete in active context ──
      if (this.config.session?.enabled !== false) {
        await session.completeTask(taskId, {
          duration: result.duration,
          cost: result.cost,
          outputPath: result.outputPath
        });
      }

      // Generate speakable result for voice interface
      const speakableResult = this.generateSpeakableResult(backend, scoring, result);
      const confirmationNeeded = scoring.estimatedCost > 2;

      // ── Shadow benchmark: fire-and-forget (never blocks primary) ──
      setImmediate(() => {
        shadowBench.shadowTask(taskId, normalizedTask.description, {
          ...result,
          success: result.success !== false,
          complexity: normalizedTask.complexity,
          files: normalizedTask.files,
          toolsNeeded: normalizedTask.toolsNeeded
        }).catch(error => {
          console.warn('[SHADOW] Shadow task failed:', error.message);
        });
      });

      return {
        ...result,
        taskId,
        routing: {
          selectedBackend: backend,
          scoring,
          duration: Date.now() - startTime
        },
        speakableResult,
        confirmationNeeded
      };

    } catch (error) {
      const duration = Date.now() - startTime;
      console.error(`[ROUTER] Task ${taskId} failed:`, error.message);

      // Try fallback if not already on final fallback
      if (!error.message.includes('All fallbacks exhausted')) {
        try {
          const fallbackResult = await this.executeFallback(task, error.message);
          const fallbackSpeakable = `Had to use fallback routing, but task completed successfully.`;
          return {
            ...fallbackResult,
            taskId,
            fallback: true,
            originalError: error.message,
            duration,
            speakableResult: fallbackSpeakable,
            confirmationNeeded: false
          };
        } catch (fallbackError) {
          // Record final failure
          await monitor.recordResult('api', task, false, duration, 0);
          throw new Error(`All fallbacks exhausted: ${fallbackError.message}`);
        }
      }

      await monitor.recordResult('unknown', task, false, duration, 0);

      // ── Agent 2: Mark failed task in dedup (allows retries) ──
      if (this.config.dedup?.enabled !== false) {
        dedup.register(taskId, task);
        dedup.complete(taskId, { failed: true });
      }

      // ── Agent 3: Mark task failed in active context ──
      if (this.config.session?.enabled !== false) {
        await session.failTask(taskId, error.message);
      }

      throw error;
    }
  }

  /**
   * Execute a previously-approved plan (multi-route execution)
   * @param {Object} plan - Plan from planner.decompose() or route({plan:true})
   * @returns {Promise<Object>} Execution results
   */
  async executePlan(plan) {
    if (!this.initialized) {
      await this.initialize();
    }

    const startTime = Date.now();
    const steps = plan.steps || [];
    if (steps.length === 0) {
      throw new Error('Plan has no steps to execute');
    }

    console.log(`[ROUTER] Executing plan ${plan.id} with ${steps.length} steps`);

    const results = {};   // stepId → result
    const errors  = {};   // stepId → error
    const context = {};   // stepId → output (for passing between steps)

    // Build dependency lookup
    const dependents = {}; // stepId → [stepIds that depend on it]
    const remaining  = new Set(steps.map(s => s.id));
    const completed  = new Set();
    const failed     = new Set();

    for (const step of steps) {
      for (const depId of step.dependencies) {
        if (!dependents[depId]) dependents[depId] = [];
        dependents[depId].push(step.id);
      }
    }

    // Process steps in waves — all steps with satisfied dependencies run in parallel
    while (remaining.size > 0) {
      // Find steps whose dependencies are all satisfied
      const ready = steps.filter(s =>
        remaining.has(s.id) &&
        s.dependencies.every(d => completed.has(d))
      );

      if (ready.length === 0) {
        // Check if remaining steps are blocked by failed critical dependencies
        const blocked = steps.filter(s => remaining.has(s.id));
        const allBlockedByFailure = blocked.every(s =>
          s.dependencies.some(d => failed.has(d))
        );
        if (allBlockedByFailure) {
          console.log('[ROUTER] Remaining steps blocked by failed dependencies — aborting');
          for (const s of blocked) {
            errors[s.id] = 'Blocked by failed dependency';
            remaining.delete(s.id);
          }
          break;
        }
        // Shouldn't happen unless there's a cycle
        console.error('[ROUTER] Deadlock detected in plan — breaking');
        break;
      }

      // Execute ready steps in parallel
      const promises = ready.map(step => this._executeStep(step, context));
      const settled = await Promise.allSettled(promises);

      for (let i = 0; i < ready.length; i++) {
        const step = ready[i];
        const outcome = settled[i];

        if (outcome.status === 'fulfilled') {
          results[step.id] = outcome.value;
          context[step.id] = this._extractContext(outcome.value);
          completed.add(step.id);
          remaining.delete(step.id);

          console.log(`[ROUTER] Step ${step.index + 1}/${steps.length} completed: ${step.description.substring(0, 60)}`);
        } else {
          const errMsg = outcome.reason?.message || String(outcome.reason);

          // Retry once on same backend
          console.log(`[ROUTER] Step ${step.index + 1} failed, retrying: ${errMsg}`);
          try {
            const retryResult = await this._executeStep(step, context);
            results[step.id] = retryResult;
            context[step.id] = this._extractContext(retryResult);
            completed.add(step.id);
            remaining.delete(step.id);
          } catch (retryErr) {
            // Try fallback backend
            const fallbackBackend = this.getNextFallback(
              step.backend === 'claude-code' ? 'claudeCode' : step.backend
            );
            if (fallbackBackend) {
              console.log(`[ROUTER] Step ${step.index + 1} fallback → ${fallbackBackend}`);
              try {
                const fbResult = await this._executeStepOnBackend(step, context, fallbackBackend);
                results[step.id] = fbResult;
                context[step.id] = this._extractContext(fbResult);
                completed.add(step.id);
                remaining.delete(step.id);
              } catch (fbErr) {
                this._handleStepFailure(step, fbErr.message, errors, failed, remaining);
              }
            } else {
              this._handleStepFailure(step, retryErr.message, errors, failed, remaining);
            }
          }
        }
      }
    }

    const duration = Date.now() - startTime;
    const totalSteps = steps.length;
    const completedCount = completed.size;
    const failedCount = failed.size;

    console.log(`[ROUTER] Plan ${plan.id} finished: ${completedCount}/${totalSteps} steps completed in ${(duration / 1000).toFixed(1)}s`);

    return {
      planId: plan.id,
      success: failedCount === 0,
      totalSteps,
      completedSteps: completedCount,
      failedSteps: failedCount,
      results,
      errors: Object.keys(errors).length > 0 ? errors : undefined,
      context,
      duration
    };
  }

  /**
   * Approve a pending plan and execute it
   * @param {string} planId - Plan ID to approve
   * @returns {Promise<Object>} Execution results
   */
  async approvePlan(planId) {
    const pending = notify.getPendingPlan(planId);
    if (!pending) {
      throw new Error(`Plan ${planId} not found or expired`);
    }

    notify.removePendingPlan(planId);

    console.log(`[ROUTER] Plan ${planId} approved — executing`);
    const result = await this.executePlan(pending.plan);

    // Send completion or error notification
    if (result.success) {
      notify.sendCompletion(planId, {
        taskDescription: pending.plan.task?.description,
        duration: result.duration,
        totalCost: pending.costBreakdown?.totalApiCost,
        completedSteps: result.completedSteps,
        totalSteps: result.totalSteps,
        outputPath: pending.plan.task?.outputPath
      });
    } else {
      notify.sendError(planId, `Plan execution failed: ${result.failedSteps} step(s) failed`);
    }

    return result;
  }

  /**
   * Cancel a pending plan
   * @param {string} planId - Plan ID to cancel
   * @returns {boolean} Whether the plan was found and cancelled
   */
  cancelPlan(planId) {
    const removed = notify.removePendingPlan(planId);
    if (removed) {
      console.log(`[ROUTER] Plan ${planId} cancelled`);
    }
    return removed;
  }

  /**
   * Get all pending plans awaiting approval
   * @returns {Object} Map of planId → pending plan data
   */
  getPendingPlans() {
    return notify.getAllPendingPlans();
  }

  /**
   * @private Execute a single plan step
   */
  async _executeStep(step, priorContext) {
    const backendKey = this._backendKey(step.backend);
    const task = this._stepToTask(step, priorContext);
    const scoring = await this.scoreTask(task);
    return await this.executeWithBackend(backendKey, task, scoring);
  }

  /**
   * @private Execute a step on a specific backend (for fallback)
   */
  async _executeStepOnBackend(step, priorContext, backendKey) {
    const task = this._stepToTask(step, priorContext);
    const scoring = await this.scoreTask(task);
    return await this.executeWithBackend(backendKey, task, scoring);
  }

  /**
   * @private Handle a step failure
   */
  _handleStepFailure(step, errMsg, errors, failed, remaining) {
    if (step.critical) {
      console.error(`[ROUTER] Critical step ${step.index + 1} failed permanently: ${errMsg}`);
      errors[step.id] = errMsg;
      failed.add(step.id);
      remaining.delete(step.id);
    } else {
      console.warn(`[ROUTER] Optional step ${step.index + 1} failed, skipping: ${errMsg}`);
      errors[step.id] = `Skipped (non-critical): ${errMsg}`;
      remaining.delete(step.id);
    }
  }

  /**
   * @private Convert planner backend name to router backend key
   */
  _backendKey(plannerBackend) {
    const map = { 'claude-code': 'claudeCode', 'codex': 'codex', 'api': 'api', 'local': 'local' };
    return map[plannerBackend] || plannerBackend;
  }

  /**
   * @private Convert a plan step + prior context into a task object
   */
  _stepToTask(step, priorContext) {
    let description = step.description;

    // Inject context from prior steps (summaries, not full outputs)
    if (step.dependencies.length > 0) {
      const contextSnippets = step.dependencies
        .filter(depId => priorContext[depId])
        .map(depId => {
          const ctx = priorContext[depId];
          return typeof ctx === 'string' ? ctx.substring(0, 500) : JSON.stringify(ctx).substring(0, 500);
        });
      if (contextSnippets.length > 0) {
        description += '\n\nContext from prior steps:\n' + contextSnippets.join('\n---\n');
      }
    }

    return {
      description,
      type: step.type || 'other',
      urgency: 'normal',
      complexity: Math.min(10, Math.max(1, Math.ceil(step.estimatedTokens / 2000))),
      toolsNeeded: [],
      files: [],
      outputPath: null,
      metadata: { planStepId: step.id }
    };
  }

  /**
   * @private Extract context from a step result for downstream consumption
   */
  _extractContext(result) {
    if (!result) return '';
    if (result.response) return result.response.substring(0, 1000);
    if (result.output) return result.output.substring(0, 1000);
    return JSON.stringify(result).substring(0, 500);
  }

  /**
   * Force route a task to a specific backend (admin function)
   * @param {Object} task - Task object
   * @param {string} backend - Backend to force ('claudeCode', 'codex', 'api', 'local')
   * @returns {Promise<Object>} Execution result
   */
  async forceRoute(task, backend) {
    if (!this.initialized) {
      await this.initialize();
    }

    console.log(`[ROUTER] Force routing to ${backend}`);

    const normalizedTask = this.normalizeTask(task);
    const scoring = await this.scoreTask(normalizedTask);

    return await this.executeWithBackend(backend, normalizedTask, scoring);
  }

  /**
   * Normalize and validate task object
   * @param {Object} task - Raw task object
   * @returns {Object} Normalized task
   */
  normalizeTask(task) {
    if (!task || typeof task !== 'object') {
      throw new Error('Task must be a valid object');
    }

    if (!task.description || typeof task.description !== 'string') {
      throw new Error('Task must have a description string');
    }

    return {
      description: task.description.trim(),
      type: task.type || this.inferTaskType(task.description),
      urgency: task.urgency || 'normal',
      complexity: Math.min(10, Math.max(1, task.complexity || this.inferComplexity(task.description))),
      toolsNeeded: Array.isArray(task.toolsNeeded) ? task.toolsNeeded : [],
      files: Array.isArray(task.files) ? task.files : [],
      outputPath: task.outputPath || null,
      forceBackend: task.forceBackend || null,
      metadata: task.metadata || {}
    };
  }

  /**
   * Infer task type from description
   * @param {string} description - Task description
   * @returns {string} Inferred task type
   */
  inferTaskType(description) {
    const desc = description.toLowerCase();

    if (desc.includes('code') || desc.includes('implement') || desc.includes('program')) {
      return 'code';
    }
    if (desc.includes('review') || desc.includes('analyze code') || desc.includes('debug')) {
      return 'review';
    }
    if (desc.includes('document') || desc.includes('readme') || desc.includes('guide')) {
      return 'docs';
    }
    if (desc.includes('research') || desc.includes('investigate') || desc.includes('analyze')) {
      return 'research';
    }
    if (desc.includes('analyze') || desc.includes('evaluate') || desc.includes('assess')) {
      return 'analysis';
    }

    return 'other';
  }

  /**
   * Infer task complexity from description
   * @param {string} description - Task description
   * @returns {number} Complexity score 1-10
   */
  inferComplexity(description) {
    let complexity = 5; // Base complexity
    const desc = description.toLowerCase();

    // Complexity indicators
    if (desc.includes('simple') || desc.includes('basic')) complexity -= 2;
    if (desc.includes('complex') || desc.includes('advanced')) complexity += 3;
    if (desc.includes('multiple files') || desc.includes('full system')) complexity += 2;
    if (desc.includes('integration') || desc.includes('architecture')) complexity += 2;
    if (desc.includes('optimization') || desc.includes('performance')) complexity += 1;
    if (desc.length > 500) complexity += 1; // Long descriptions tend to be more complex

    // Word count complexity
    const wordCount = desc.split(/\s+/).length;
    if (wordCount > 100) complexity += 1;
    if (wordCount > 200) complexity += 1;

    return Math.min(10, Math.max(1, complexity));
  }

  /**
   * Score task on multiple dimensions for routing decisions
   * @param {Object} task - Normalized task object
   * @returns {Promise<Object>} Scoring object
   */
  async scoreTask(task) {
    const scoring = {
      complexity: task.complexity,
      urgency: this.getUrgencyScore(task.urgency),
      toolRequirement: this.getToolScore(task.toolsNeeded),
      estimatedTokens: this.estimateTokens(task),
      estimatedCost: 0,
      fileCount: task.files.length,
      adaptiveScores: {}
    };

    // Calculate estimated cost
    scoring.estimatedCost = ledger.estimateApiCost(scoring.estimatedTokens);

    // Get adaptive scores for each backend if enabled
    if (this.config.routing.adaptiveScoringEnabled) {
      const initialScores = this.config.routing.initialScores || {};
      const fastThreshold = this.config.routing.fastLearningThreshold || 20;
      const fastMultiplier = this.config.routing.fastLearningMultiplier || 2;
      
      for (const backend of ['claudeCode', 'codex', 'api', 'local']) {
        let score = monitor.getAdaptiveScore(backend, task);
        
        // Use initial seeds if monitor has insufficient data
        const taskCount = monitor.getTaskCount ? monitor.getTaskCount(backend) : 0;
        if (taskCount < 5 && initialScores[backend]) {
          score = initialScores[backend];
        } else if (taskCount < fastThreshold && initialScores[backend]) {
          // Blend initial score with learned score, weighted by sample count
          const learnedWeight = (taskCount / fastThreshold) * fastMultiplier;
          const seedWeight = 1 - Math.min(learnedWeight, 0.9);
          score = (score * learnedWeight + initialScores[backend] * seedWeight) / (learnedWeight + seedWeight);
        }
        
        scoring.adaptiveScores[backend] = Math.round(score * 100) / 100;
      }
    }

    return scoring;
  }

  /**
   * Get urgency score (higher = more urgent)
   * @param {string} urgency - Urgency level
   * @returns {number} Urgency score
   */
  getUrgencyScore(urgency) {
    const scores = {
      immediate: 100,
      high: 75,
      normal: 50,
      low: 25,
      background: 10
    };
    return scores[urgency] || 50;
  }

  /**
   * Get tool requirement score (higher = more tools needed)
   * @param {Array} toolsNeeded - Array of required tools
   * @returns {number} Tool score
   */
  getToolScore(toolsNeeded) {
    if (!Array.isArray(toolsNeeded)) return 0;

    // Tools that require API sub-agents
    const apiTools = ['web', 'email', 'shell', 'memory', 'calendar', 'files'];
    const apiToolCount = toolsNeeded.filter(tool => apiTools.includes(tool.toLowerCase())).length;

    return apiToolCount * 25; // 25 points per API tool
  }

  /**
   * Estimate token usage for a task
   * @param {Object} task - Task object
   * @returns {number} Estimated tokens
   */
  estimateTokens(task) {
    let tokens = task.description.length / 4; // Base from description

    // Add complexity multiplier
    tokens *= (1 + (task.complexity - 5) * 0.2);

    // Add file context
    tokens += task.files.length * 2000; // Assume 2K tokens per file

    // Add output overhead
    if (task.outputPath) {
      tokens += 1000; // Output formatting overhead
    }

    // Task type multipliers
    const typeMultipliers = {
      code: 1.5,
      review: 1.2,
      docs: 1.3,
      research: 2.0,
      analysis: 1.8,
      other: 1.0
    };

    tokens *= (typeMultipliers[task.type] || 1.0);

    return Math.ceil(tokens);
  }

  /**
   * Select the optimal backend for a task
   * @param {Object} task - Normalized task
   * @param {Object} scoring - Task scoring
   * @returns {Promise<string>} Selected backend
   */
  async selectBackend(task, scoring) {
    // Force backend if specified
    if (task.forceBackend) {
      console.log(`[ROUTER] Force backend: ${task.forceBackend}`);
      return task.forceBackend;
    }

    // Rule 1: Tools required → API sub-agent
    if (scoring.toolRequirement > 0) {
      console.log(`[ROUTER] Tools required (${task.toolsNeeded.join(', ')}) → API`);
      return 'api';
    }

    // Rule 2: Check budget constraints
    const budgetChecks = await Promise.all([
      ledger.checkBudget('claudeCode', scoring.estimatedTokens),
      ledger.checkBudget('codex', scoring.estimatedTokens),
      ledger.checkBudget('api', scoring.estimatedTokens)
    ]);

    const availableBackends = {
      claudeCode: budgetChecks[0].allowed,
      codex: budgetChecks[1].allowed,
      api: budgetChecks[2].allowed,
      local: true // Always available
    };

    // Rule 2.5: Rate limiting checks - apply rate governor filters
    for (const backend of Object.keys(availableBackends)) {
      if (availableBackends[backend]) { // Only check available backends
        const rateCheck = rateGovernor.canUse(backend);
        if (!rateCheck.allowed) {
          console.log(`[ROUTER] ${backend} rate limited: ${rateCheck.reason}`);
          availableBackends[backend] = false; // Mark as unavailable
          
          // If suggested fallback is available, prefer it
          if (rateCheck.suggestedBackend && availableBackends[rateCheck.suggestedBackend]) {
            console.log(`[ROUTER] Rate governor suggests fallback: ${backend} → ${rateCheck.suggestedBackend}`);
          }
        } else if (rateCheck.delayMs) {
          // Store delay info for soft-limited backend
          console.log(`[ROUTER] ${backend} soft rate limit: ${rateCheck.delayMs}ms delay (${rateCheck.reason})`);
          // Don't store delay on task yet - will be applied when backend is selected
        }
      }
    }

    // Rule 3: Urgency-based routing
    if (scoring.urgency >= 100) { // Immediate
      if (availableBackends.api) {
        console.log('[ROUTER] Immediate urgency → API');
        return 'api';
      }
    }

    // Rule 4: Code builds (>1 file, no tools) → Claude Code
    if (task.type === 'code' && scoring.fileCount > 1 && availableBackends.claudeCode) {
      console.log('[ROUTER] Multi-file code build → Claude Code');
      return 'claudeCode';
    }

    // Rule 5: Parallel research tasks → Codex
    if (task.type === 'research' && scoring.complexity >= 7 && availableBackends.codex) {
      console.log('[ROUTER] Complex research → Codex (parallel)');
      return 'codex';
    }

    // Rule 6: Code review, linting, docs, comments → Local
    if (['review', 'docs'].includes(task.type) && scoring.complexity <= 6) {
      console.log(`[ROUTER] ${task.type} task → Local`);
      return 'local';
    }

    // Rule 7: Low priority → Queue or Local
    if (scoring.urgency <= 25) {
      console.log('[ROUTER] Low priority → Local');
      return 'local';
    }

    // Rule 8: Hybrid routing consideration
    if (this.config.routing.hybridEnabled && scoring.complexity >= 8) {
      console.log('[ROUTER] High complexity → Hybrid (starting with local)');
      return 'local';
    }

    // Rule 9: Adaptive scoring (if enabled)
    if (this.config.routing.adaptiveScoringEnabled) {
      const bestBackend = this.selectBestAdaptiveBackend(scoring.adaptiveScores, availableBackends);
      if (bestBackend) {
        console.log(`[ROUTER] Adaptive scoring → ${bestBackend}`);
        return bestBackend;
      }
    }

    // ── Agent 3: Health-aware tie-breaking (prefer warm/healthy over cold/dead) ──
    if (this.config.warmup?.enabled !== false) {
      const health = warmup.getHealth();
      const healthOrder = ['claudeCode', 'codex', 'local'].filter(b => availableBackends[b]);
      const warmBackends = healthOrder.filter(b => health[b]?.status === 'warm' || health[b]?.status === 'healthy');
      if (warmBackends.length > 0) {
        console.log(`[ROUTER] Health-aware selection → ${warmBackends[0]} (${health[warmBackends[0]]?.status})`);
        return warmBackends[0];
      }
    }

    // Rule 10: Default fallback chain
    const defaults = ['claudeCode', 'codex', 'api', 'local'];
    for (const backend of defaults) {
      if (availableBackends[backend]) {
        console.log(`[ROUTER] Default selection → ${backend}`);
        return backend;
      }
    }

    // Should never reach here, but safety fallback
    return 'local';
  }

  /**
   * Select best backend based on adaptive scores
   * @param {Object} adaptiveScores - Scores for each backend
   * @param {Object} availableBackends - Backend availability
   * @returns {string|null} Best backend or null
   */
  selectBestAdaptiveBackend(adaptiveScores, availableBackends) {
    let bestBackend = null;
    let bestScore = 0;

    for (const [backend, score] of Object.entries(adaptiveScores)) {
      if (availableBackends[backend] && score > bestScore) {
        bestScore = score;
        bestBackend = backend;
      }
    }

    // Only use adaptive if confidence is high
    return bestScore >= 70 ? bestBackend : null;
  }

  /**
   * Check if task should be queued instead of executed immediately
   * @param {Object} task - Task object
   * @param {string} backend - Selected backend
   * @returns {boolean} Whether to queue
   */
  shouldQueue(task, backend) {
    // Never queue immediate tasks
    if (task.urgency === 'immediate') {
      return false;
    }

    // Queue low priority tasks
    if (task.urgency === 'low' || task.urgency === 'background') {
      return true;
    }

    // Queue if backend is overloaded (check active sessions)
    if (backend === 'claudeCode' && claudeCode.activeSessions?.size >= 2) {
      return true;
    }

    if (backend === 'codex' && codex.activeSessions?.size >= codex.parallelLimit) {
      return true;
    }

    return false;
  }

  /**
   * Enqueue a task for later execution
   * @param {Object} task - Task object
   * @param {string} preferredBackend - Preferred backend
   * @returns {Promise<string>} Queue task ID
   */
  async enqueueTask(task, preferredBackend) {
    const priority = this.urgencyToPriority(task.urgency);

    // Add preferred backend hint to task
    task.preferredBackend = preferredBackend;

    return await queue.enqueue(task, priority);
  }

  /**
   * Convert urgency to queue priority
   * @param {string} urgency - Task urgency
   * @returns {string} Queue priority
   */
  urgencyToPriority(urgency) {
    const mapping = {
      immediate: 'critical',
      high: 'high',
      normal: 'normal',
      low: 'low',
      background: 'background'
    };
    return mapping[urgency] || 'normal';
  }

  /**
   * Execute task with the specified backend
   * @param {string} backend - Backend to use
   * @param {Object} task - Task object
   * @param {Object} scoring - Task scoring
   * @returns {Promise<Object>} Execution result
   */
  async executeWithBackend(backend, task, scoring) {
    // ── Agent 2: Circuit breaker check ──
    if (this.config.circuitBreaker?.enabled !== false && !circuitBreaker.canExecute(backend)) {
      console.log(`[ROUTER] Circuit breaker OPEN for ${backend} — skipping to fallback`);
      const fallbackBackend = this.getNextFallback(backend);
      if (fallbackBackend) {
        console.log(`[ROUTER] Breaker fallback: ${backend} → ${fallbackBackend}`);
        return await this.executeWithBackend(fallbackBackend, task, scoring);
      }
      throw new Error(`Backend ${backend} circuit breaker is OPEN and no fallback available`);
    }

    try {
      // Check rate governor again just before execution (fresh check)
      const rateCheck = rateGovernor.canUse(backend);
      if (!rateCheck.allowed) {
        console.log(`[ROUTER] ${backend} rate limited at execution time: ${rateCheck.reason}`);
        const fallbackBackend = this.getNextFallback(backend);
        if (fallbackBackend) {
          console.log(`[ROUTER] Rate limit fallback: ${backend} → ${fallbackBackend}`);
          return await this.executeWithBackend(fallbackBackend, task, scoring);
        }
        throw new Error(`Backend ${backend} rate limited: ${rateCheck.reason}`);
      }

      // Handle rate limiting delays (soft limits)
      if (rateCheck.delayMs) {
        console.log(`[ROUTER] Rate limit soft delay: ${rateCheck.delayMs}ms for ${backend} - ${rateCheck.reason}`);
        await new Promise(resolve => setTimeout(resolve, rateCheck.delayMs));
      }

      let result;
      switch (backend) {
        case 'claudeCode':
          result = await claudeCode.executeTask(task);
          break;
        case 'codex':
          result = await codex.executeTask(task);
          break;
        case 'local':
          result = await local.executeTask(task);
          break;
        case 'api':
          result = await this.executeWithApiSubagent(task, scoring);
          break;
        default:
          throw new Error(`Unknown backend: ${backend}`);
      }

      // ── Agent 2: Record success in circuit breaker ──
      if (this.config.circuitBreaker?.enabled !== false) {
        circuitBreaker.recordSuccess(backend);
      }

      // Record successful request in rate governor
      rateGovernor.recordRequest(backend, true);
      console.log(`[ROUTER] Success recorded for ${backend} in rate governor`);

      return result;
    } catch (error) {
      console.error(`[ROUTER] Backend ${backend} failed:`, error.message);

      // Determine if this is a timeout or rate limit error
      const isTimeout = error.code && (error.code.includes('TIMEOUT') || error.shouldFallback);
      const isRateLimit = error.message && (
        error.message.toLowerCase().includes('rate limit') ||
        error.message.toLowerCase().includes('throttle') ||
        error.message.toLowerCase().includes('quota') ||
        error.message.includes('429')
      );

      // ── Agent 2: Record failure in circuit breaker ──
      if (this.config.circuitBreaker?.enabled !== false) {
        circuitBreaker.recordFailure(backend, {
          rateLimited: isRateLimit,
          timeout: isTimeout,
          error: error.message
        });
      }

      // Record failed request in rate governor
      rateGovernor.recordRequest(backend, false);

      // Record throttle event if rate limited
      if (isRateLimit) {
        rateGovernor.recordThrottle(backend, {
          errorMessage: error.message,
          errorCode: error.code,
          timestamp: Date.now()
        });
        console.log(`[ROUTER] Rate limit throttle recorded for ${backend}`);
      }

      // Try fallback if backend failed with a fallback-eligible error
      if (isTimeout || isRateLimit || error.shouldFallback) {
        const fallbackBackend = this.getNextFallback(backend);
        if (fallbackBackend) {
          console.log(`[ROUTER] Trying fallback (${isTimeout ? 'timeout' : isRateLimit ? 'rate-limit' : 'error'}): ${backend} → ${fallbackBackend}`);
          console.log(`[ROUTER] Original failure attributed to ${backend}, fallback execution on ${fallbackBackend}`);
          return await this.executeWithBackend(fallbackBackend, task, scoring);
        }
      }

      throw error;
    }
  }

  /**
   * Execute task using API sub-agent with intelligent model selection
   * @param {Object} task - Task object
   * @param {Object} scoring - Task scoring object
   * @returns {Promise<Object>} Execution result
   */
  async executeWithApiSubagent(task, scoring = null) {
    const startTime = Date.now();

    try {
      // Get task complexity and context size for model selection
      const complexity = scoring?.complexity || planner._inferComplexity(task.description);
      const contextSize = scoring?.estimatedTokens || this.estimateTokens(task);

      // Select optimal model using the registry
      const modelSelection = await modelRegistry.selectModel(task, complexity, contextSize);
      
      console.log(`[ROUTER] Selected ${modelSelection.model} on ${modelSelection.provider} (${modelSelection.reason})`);
      console.log(`[ROUTER] Estimated cost: $${modelSelection.estimatedCost.toFixed(4)}`);

      // This would integrate with OpenClaw's subagent system
      // For now, simulate the API call with the selected model
      console.log(`[ROUTER] Executing with ${modelSelection.fullModelId}`);

      // Simulate processing time based on model tier
      const processingTime = modelSelection.config.tier === 'fast' ? 1500 : 
                             modelSelection.config.tier === 'standard' ? 2500 : 3500;
      await new Promise(resolve => setTimeout(resolve, processingTime));

      const duration = Date.now() - startTime;
      const actualTokens = contextSize; // In real implementation, would get from API response

      // Record usage with actual model information
      const userId = task.metadata?.userId || 'meir';
      await ledger.recordUsage('api', task, actualTokens, modelSelection.fullModelId, userId);

      // Create enhanced speakable result
      const providerName = modelSelection.provider.charAt(0).toUpperCase() + modelSelection.provider.slice(1);
      const modelDisplayName = this._getModelDisplayName(modelSelection.model);
      const speakableResult = `Routing to ${modelDisplayName} on ${providerName}, estimated cost $${modelSelection.estimatedCost.toFixed(2)}`;

      return {
        success: true,
        backend: 'api',
        model: modelSelection.fullModelId,
        modelSelection,
        response: `API Sub-agent completed: ${task.description}`,
        speakableResult,
        duration,
        tokens: actualTokens,
        cost: modelSelection.estimatedCost,
        outputPath: task.outputPath
      };
    } catch (error) {
      console.error('[ROUTER] Model selection failed:', error.message);
      
      // Fallback to default model if selection fails
      const duration = Date.now() - startTime;
      const estimatedTokens = this.estimateTokens(task);
      const cost = ledger.estimateApiCost(estimatedTokens);
      const userId = task.metadata?.userId || 'meir';
      
      await ledger.recordUsage('api', task, estimatedTokens, this.config.backends.api.defaultModel, userId);

      return {
        success: true,
        backend: 'api',
        model: this.config.backends.api.defaultModel,
        response: `API Sub-agent completed: ${task.description} (fallback model)`,
        speakableResult: `Routing to default model (selection failed)`,
        duration,
        tokens: estimatedTokens,
        cost,
        outputPath: task.outputPath
      };
    }
  }

  /**
   * Get human-readable display name for model
   * @param {string} modelId - Model identifier
   * @returns {string} Display name
   * @private
   */
  _getModelDisplayName(modelId) {
    const displayNames = {
      'opus-4.6': 'Opus 4.6',
      'sonnet-4': 'Sonnet 4',
      'haiku-4.5': 'Haiku 4.5',
      'gpt-4.1': 'GPT-4.1',
      'gpt-4.1-mini': 'GPT-4.1 Mini',
      'grok-3': 'Grok 3',
      'gemini-2.5-pro': 'Gemini 2.5 Pro',
      'deepseek-r1': 'DeepSeek R1',
      'llama-4-maverick': 'Llama 4 Maverick'
    };
    return displayNames[modelId] || modelId;
  }

  /**
   * Get next fallback backend
   * @param {string} failedBackend - Backend that failed
   * @returns {string|null} Next fallback backend
   */
  getNextFallback(failedBackend) {
    const index = this.fallbackChain.indexOf(failedBackend);
    if (index !== -1 && index < this.fallbackChain.length - 1) {
      return this.fallbackChain[index + 1];
    }

    // If not in chain or last in chain, use default fallback
    if (failedBackend !== 'local') {
      return 'local';
    }

    return null; // No more fallbacks
  }

  /**
   * Execute fallback routing
   * @param {Object} task - Original task
   * @param {string} originalError - Error from first attempt
   * @returns {Promise<Object>} Fallback result
   */
  async executeFallback(task, originalError) {
    console.log('[ROUTER] Executing fallback chain');

    for (const backend of this.fallbackChain) {
      try {
        const budgetCheck = await ledger.checkBudget(backend, this.estimateTokens(task));
        if (!budgetCheck.allowed) {
          console.log(`[ROUTER] Fallback ${backend} not available: ${budgetCheck.reason}`);
          continue;
        }

        console.log(`[ROUTER] Trying fallback backend: ${backend}`);
        const result = await this.executeWithBackend(backend, task, await this.scoreTask(task));

        return {
          ...result,
          fallbackUsed: backend,
          originalError
        };

      } catch (error) {
        console.error(`[ROUTER] Fallback ${backend} failed:`, error.message);
        continue;
      }
    }

    throw new Error(`All fallbacks exhausted. Original error: ${originalError}`);
  }

  /**
   * Get comprehensive router status
   * @returns {Promise<Object>} Router status
   */
  async getStatus() {
    if (!this.initialized) {
      return { initialized: false, message: 'Router not initialized' };
    }

    const [
      ledgerReport,
      performanceReport,
      queueStatus,
      claudeStatus,
      codexStatus,
      localStatus
    ] = await Promise.all([
      ledger.getReport(),
      monitor.getPerformanceReport(),
      queue.getQueueStatus(),
      claudeCode.getDetailedStatus(),
      codex.getDetailedStatus(),
      local.getStatus()
    ]);

    const schedulerStatus = scheduler.getStatus();

    return {
      initialized: true,
      version: require('./package.json').version,
      config: {
        hybridEnabled: this.config.routing.hybridEnabled,
        adaptiveScoringEnabled: this.config.routing.adaptiveScoringEnabled,
        performanceWindowDays: this.config.routing.performanceWindowDays
      },
      backends: {
        claudeCode: claudeStatus,
        codex: codexStatus,
        api: {
          enabled: this.config.backends.api.enabled,
          model: this.config.backends.api.defaultModel,
          budget: {
            daily: ledgerReport.api.dailySpend + ' / $' + this.config.backends.api.dailyBudgetUsd,
            monthly: ledgerReport.api.monthlySpend + ' / $' + this.config.backends.api.monthlyBudgetUsd
          }
        },
        local: localStatus
      },
      queue: queueStatus,
      scheduler: schedulerStatus,
      performance: {
        overallSuccessRate: performanceReport.summary.overallSuccessRate,
        totalTasks: performanceReport.summary.totalTasks,
        recentAlerts: performanceReport.recentAlerts.length
      },
      // ── Agent 2: Circuit breaker + dedup status ──
      circuitBreakers: circuitBreaker.getAll(),
      recentTasks: dedup.getRecent(),
      usage: ledgerReport,
      uptime: process.uptime(),
      lastUpdated: new Date().toISOString()
    };
  }

  /**
   * Gracefully shutdown the router
   * @returns {Promise<void>}
   */
  async shutdown() {
    console.log('[ROUTER] Shutting down...');

    try {
      // Stop schedulers
      await queue.stopScheduler();
      scheduler.stop();

      // Kill active sessions
      await claudeCode.killAllSessions();
      await codex.killAllSessions();

      // ── Agent 3: Stop warmup + save session ──
      warmup.stopWarmup();
      await session.save();

      // ── Agent 2: Save circuit breaker + dedup + rate governor state ──
      await circuitBreaker.save();
      await dedup.save();
      await rateGovernor.save();

      // Save final state
      await ledger.save();
      await monitor.save();
      await queue.save();
      await scheduler.save();

      console.log('[ROUTER] Shutdown complete');
    } catch (error) {
      console.error('[ROUTER] Error during shutdown:', error.message);
    }
  }
}

// Create singleton instance
const router = new TaskRouter();

// Export main functions
module.exports = {
  route: (task, options) => router.route(task, options),
  executePlan: (plan) => router.executePlan(plan),
  approvePlan: (planId) => router.approvePlan(planId),
  cancelPlan: (planId) => router.cancelPlan(planId),
  getPendingPlans: () => router.getPendingPlans(),
  forceRoute: (task, backend) => router.forceRoute(task, backend),
  getStatus: () => router.getStatus(),
  initialize: () => router.initialize(),
  shutdown: () => router.shutdown(),
  planner,
  scheduler,
  notify,
  // ── Agent 2 exports ──
  circuitBreaker,
  dedup,
  rateGovernor,
  // ── Agent 3 exports ──
  session,
  warmup
};

// Auto-initialize on first import (only once via global flag)
if (!global.__openclawRouterInitialized) {
  global.__openclawRouterInitialized = true;
  router.initialize().catch(error => {
    console.error('[ROUTER] Auto-initialization failed:', error.message);
  });
}
