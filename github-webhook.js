/**
 * OpenClaw Task Router - GitHub Webhook Handler
 * Handles GitHub PR events and creates review tasks
 */

const crypto = require('crypto');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

class GitHubWebhookHandler {
  constructor() {
    this.config = null;
  }

  /**
   * Load configuration
   */
  loadConfig() {
    if (!this.config) {
      this.config = require('./config.json');
    }
    return this.config;
  }

  /**
   * Verify GitHub webhook signature
   * @param {string} payload - Raw request body
   * @param {string} signature - X-Hub-Signature-256 header
   * @param {string} secret - Webhook secret
   * @returns {boolean} - Whether signature is valid
   */
  verifySignature(payload, signature, secret) {
    if (!signature || !secret) {
      return false;
    }

    const expectedSignature = 'sha256=' + crypto
      .createHmac('sha256', secret)
      .update(payload, 'utf8')
      .digest('hex');

    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  }

  /**
   * Check if repository is allowed
   * @param {string} repoFullName - Full repository name (owner/repo)
   * @returns {boolean} - Whether repo is in allowed list
   */
  isRepoAllowed(repoFullName) {
    const config = this.loadConfig();
    const allowedRepos = config.github?.repos || [];
    
    // If no repos specified, allow all
    if (allowedRepos.length === 0) {
      return true;
    }
    
    return allowedRepos.includes(repoFullName);
  }

  /**
   * Create a review task description from PR data
   * @param {Object} pullRequest - GitHub PR object
   * @returns {string} - Task description
   */
  createReviewTask(pullRequest) {
    const title = pullRequest.title || 'Untitled PR';
    const body = pullRequest.body || '';
    const author = pullRequest.user?.login || 'unknown';
    const repoName = pullRequest.base?.repo?.name || 'unknown';
    const prNumber = pullRequest.number;
    const changedFiles = pullRequest.changed_files || 0;
    const additions = pullRequest.additions || 0;
    const deletions = pullRequest.deletions || 0;

    let taskDescription = `Code review for PR #${prNumber} in ${repoName}
Title: ${title}
Author: ${author}
Changes: +${additions}/-${deletions} lines across ${changedFiles} files

`;

    if (body.trim()) {
      taskDescription += `Description:
${body.trim()}

`;
    }

    taskDescription += `Please review this pull request and provide:
1. Code quality assessment
2. Potential issues or bugs
3. Security considerations
4. Performance implications
5. Suggestions for improvement
6. Overall recommendation (approve/request changes/comment)

Focus on maintainability, security, and following best practices.`;

    return taskDescription;
  }

  /**
   * Post review comment on GitHub PR
   * @param {string} repoFullName - Repository name (owner/repo)
   * @param {number} prNumber - PR number
   * @param {string} comment - Review comment
   * @returns {Promise<Object>} - Result of posting comment
   */
  async postPRComment(repoFullName, prNumber, comment) {
    try {
      // Use GitHub CLI to post comment
      const command = `gh pr comment ${prNumber} --repo ${repoFullName} --body "${comment.replace(/"/g, '\\"')}"`;
      
      const { stdout, stderr } = await execAsync(command);
      
      return {
        success: true,
        stdout,
        stderr
      };
    } catch (error) {
      console.error('[GITHUB-WEBHOOK] Failed to post PR comment:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Format review result as GitHub comment
   * @param {Object} result - Router result
   * @param {Object} pullRequest - GitHub PR object
   * @returns {string} - Formatted comment
   */
  formatReviewComment(result, pullRequest) {
    if (!result.success) {
      return `🤖 **OpenClaw Code Review Failed**

Sorry, I encountered an error while reviewing PR #${pullRequest.number}:
\`\`\`
${result.error || 'Unknown error'}
\`\`\`

Please try again later or request a manual review.`;
    }

    const output = result.output || result.result || '';
    const backend = result.backend || 'unknown';
    const tokens = result.tokens || 0;
    const duration = result.duration ? Math.round(result.duration / 1000) : 0;

    let comment = `🤖 **OpenClaw Code Review** (via ${backend})

${output}

---
*Review completed in ${duration}s using ${tokens} tokens*`;

    return comment;
  }

  /**
   * Handle GitHub webhook payload
   * @param {Object} payload - GitHub webhook payload
   * @param {Function} routerFunction - Router function to call
   * @returns {Promise<Object>} - Processing result
   */
  async handleWebhook(payload, routerFunction) {
    const config = this.loadConfig();
    
    if (!config.github?.enabled) {
      throw new Error('GitHub integration is disabled');
    }

    const eventType = payload.action;
    const pullRequest = payload.pull_request;
    const repository = payload.repository;

    if (!pullRequest || !repository) {
      throw new Error('Invalid payload: missing pull_request or repository');
    }

    const repoFullName = repository.full_name;

    // Check if repo is allowed
    if (!this.isRepoAllowed(repoFullName)) {
      throw new Error(`Repository ${repoFullName} is not in the allowed list`);
    }

    // Only handle PR opened events for now
    if (eventType !== 'opened') {
      return {
        success: true,
        message: `Ignored event type: ${eventType}`,
        processed: false
      };
    }

    console.log(`[GITHUB-WEBHOOK] Processing PR #${pullRequest.number} in ${repoFullName}`);

    try {
      // Create review task
      const taskDescription = this.createReviewTask(pullRequest);
      
      const routerTask = {
        description: taskDescription,
        urgency: 'normal',
        source: 'github-webhook',
        metadata: {
          repoFullName,
          prNumber: pullRequest.number,
          prTitle: pullRequest.title,
          author: pullRequest.user?.login
        }
      };

      // Route the task
      const result = await routerFunction(routerTask);
      
      // Post result as PR comment
      const comment = this.formatReviewComment(result, pullRequest);
      const commentResult = await this.postPRComment(repoFullName, pullRequest.number, comment);
      
      return {
        success: true,
        processed: true,
        taskResult: result,
        commentResult,
        prNumber: pullRequest.number,
        repoFullName
      };
    } catch (error) {
      console.error('[GITHUB-WEBHOOK] Error processing PR:', error);
      
      // Try to post error comment
      try {
        const errorComment = `🤖 **OpenClaw Code Review Error**

I encountered an error while trying to review PR #${pullRequest.number}:
\`\`\`
${error.message}
\`\`\`

Please check the OpenClaw configuration and try again.`;

        await this.postPRComment(repoFullName, pullRequest.number, errorComment);
      } catch (commentError) {
        console.error('[GITHUB-WEBHOOK] Failed to post error comment:', commentError);
      }

      throw error;
    }
  }

  /**
   * Get webhook configuration status
   * @returns {Object} - Configuration status
   */
  getStatus() {
    const config = this.loadConfig();
    const githubConfig = config.github || {};

    return {
      enabled: githubConfig.enabled || false,
      hasSecret: !!(githubConfig.webhookSecret),
      allowedRepos: githubConfig.repos || [],
      repoCount: (githubConfig.repos || []).length
    };
  }
}

module.exports = new GitHubWebhookHandler();