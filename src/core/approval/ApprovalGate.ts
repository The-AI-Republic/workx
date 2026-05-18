/**
 * Approval Gate
 *
 * Main orchestrator for the approval pipeline. Injected into ToolRegistry
 * to intercept tool calls with risk assessment and policy evaluation.
 *
 * Pipeline: domain check -> assess() -> enhance() -> PolicyRulesEngine.evaluate() -> decide
 */

import type {
  ApprovalDecision,
  ApprovalCheckResult,
  RiskAssessment,
  IRiskAssessor,
  IContextEnhancer,
  ApprovalContext,
  SessionMemoryEntry,
  ApprovalMode,
  ApprovalHistoryEntry,
} from './types';
import { RiskLevel, scoreToRiskLevel } from './types';
import type { PolicyRulesEngine } from './PolicyRulesEngine';
import type { ApprovalManager, ApprovalRequest } from '../ApprovalManager';
import type { ApprovalConfigStorage } from './ApprovalConfigStorage';
import type { HookDispatcher, HookExecutionSnapshot } from '../hooks/HookDispatcher';
import type { HookInput } from '../hooks/types';

export interface ApprovalCheckOptions {
  hookSnapshot?: HookExecutionSnapshot;
}

export class ApprovalGate {
  private approvalManager: ApprovalManager;
  private policyEngine: PolicyRulesEngine;
  private enhancers: IContextEnhancer[] = [];
  private sessionMemory: Map<string, SessionMemoryEntry> = new Map();
  private mode: ApprovalMode = 'balanced';
  private trustedDomains: string[] = [];
  private blockedDomains: string[] = [];
  private configStorage: ApprovalConfigStorage | null = null;
  private hookDispatcher: HookDispatcher | null = null;
  private inFlightApprovalChecks = new Map<string, Promise<ApprovalCheckResult>>();

  constructor(approvalManager: ApprovalManager, policyEngine: PolicyRulesEngine) {
    this.approvalManager = approvalManager;
    this.policyEngine = policyEngine;
  }

  /**
   * Add a context enhancer to the pipeline
   */
  addEnhancer(enhancer: IContextEnhancer): void {
    this.enhancers.push(enhancer);
  }

  /**
   * Set the approval mode
   */
  setMode(mode: ApprovalMode): void {
    this.mode = mode;
  }

  /**
   * Get current approval mode
   */
  getMode(): ApprovalMode {
    return this.mode;
  }

  /**
   * Set trusted domains (auto-approve for these)
   */
  setTrustedDomains(domains: string[]): void {
    this.trustedDomains = domains;
  }

  /**
   * Set blocked domains (deny for these)
   */
  setBlockedDomains(domains: string[]): void {
    this.blockedDomains = domains;
  }

  /**
   * Set config storage for history tracking
   */
  setConfigStorage(storage: ApprovalConfigStorage): void {
    this.configStorage = storage;
  }

  /**
   * Set the hook dispatcher for PermissionRequest/PermissionDenied hooks.
   */
  setHookDispatcher(dispatcher: HookDispatcher): void {
    this.hookDispatcher = dispatcher;
  }

  /**
   * Check whether a tool call should be approved, denied, or sent to user.
   *
   * @param toolName - Name of the tool
   * @param parameters - Tool call parameters
   * @param assessor - Risk assessor for this tool (optional, defaults to score 20)
   * @param context - Partial context (toolName/parameters filled automatically)
   * @returns The final approval decision
   */
  async check(
    toolName: string,
    parameters: Record<string, any>,
    assessor?: IRiskAssessor,
    context?: Partial<ApprovalContext>,
    options?: ApprovalCheckOptions
  ): Promise<ApprovalCheckResult> {
    // Build full context
    const fullContext: ApprovalContext = {
      toolName,
      parameters,
      ...context,
    };

    // Fast path: check blocked domains
    const domain = fullContext.currentDomain;
    if (domain && this.blockedDomains.length > 0) {
      if (this.blockedDomains.some(d => this.matchesDomainPattern(domain, d))) {
        await this.recordHistory(toolName, 0, RiskLevel.Critical, 'deny', 'auto', ['Blocked domain']);
        return 'deny';
      }
    }

    // Fast path: check trusted domains
    if (domain && this.trustedDomains.length > 0) {
      if (this.trustedDomains.some(d => this.matchesDomainPattern(domain, d))) {
        await this.recordHistory(toolName, 0, RiskLevel.None, 'auto_approve', 'auto', ['Trusted domain']);
        return 'auto_approve';
      }
    }

    // 1. Assess risk
    let assessment: RiskAssessment;
    if (assessor) {
      assessment = assessor.assess(toolName, parameters, fullContext);
    } else {
      // Default: low risk for unknown tools
      assessment = {
        score: 20,
        level: scoreToRiskLevel(20),
        factors: ['No custom assessor registered'],
        action: 'auto_approve',
      };
    }

    // 2. Run enhancers
    for (const enhancer of this.enhancers) {
      assessment = enhancer.enhance(assessment, fullContext);
    }

    // Recalculate level after enhancement
    assessment.level = scoreToRiskLevel(assessment.score);

    // 3. Evaluate policy deny rules (enforced even in YOLO mode)
    const effectiveScore = assessment.score;
    const ruleDecision = this.policyEngine.evaluate(toolName, parameters, effectiveScore);

    if (ruleDecision === 'deny') {
      await this.recordHistory(toolName, assessment.score, assessment.level, 'deny', 'auto', assessment.factors);
      return 'deny';
    }

    // YOLO mode: auto-approve everything not denied by policy rules
    if (this.mode === 'yolo') {
      await this.recordHistory(toolName, assessment.score, assessment.level, 'auto_approve', 'auto', ['YOLO mode']);
      return 'auto_approve';
    }

    // 4. Check session memory with risk ceiling guard
    const RISK_CEILING_MARGIN = 25;
    const memoryKey = this.buildMemoryKey(toolName, parameters, domain);
    const remembered = this.sessionMemory.get(memoryKey);
    if (remembered) {
      const withinMargin = remembered.approvedRiskScore === undefined
        || assessment.score <= remembered.approvedRiskScore + RISK_CEILING_MARGIN;
      if (withinMargin) {
        await this.recordHistory(toolName, assessment.score, assessment.level, remembered.decision, 'auto', ['Remembered session decision']);
        return remembered.decision;
      }
      // Risk escalated beyond margin — fall through to normal policy evaluation
    }

    // 5. Apply mode-based threshold
    const askThreshold = this.getAskThreshold();

    // Use rule decision if available, otherwise apply mode-based threshold
    let decision: ApprovalDecision;
    if (ruleDecision !== undefined) {
      decision = ruleDecision;
    } else if (effectiveScore > askThreshold) {
      decision = 'ask_user';
    } else {
      // Score is within the mode's auto-approve threshold
      decision = 'auto_approve';
    }

    // 6. Handle the decision
    if (decision === 'auto_approve') {
      await this.recordHistory(toolName, assessment.score, assessment.level, 'auto_approve', 'auto', assessment.factors);
      return 'auto_approve';
    }

    const inFlight = this.inFlightApprovalChecks.get(memoryKey);
    if (inFlight) {
      const result = await inFlight;
      const rememberedAfterWait = this.sessionMemory.get(memoryKey);
      if (rememberedAfterWait) {
        const withinMargin = rememberedAfterWait.approvedRiskScore === undefined
          || assessment.score <= rememberedAfterWait.approvedRiskScore + RISK_CEILING_MARGIN;
        if (withinMargin) {
          await this.recordHistory(toolName, assessment.score, assessment.level, rememberedAfterWait.decision, 'auto', ['Remembered session decision']);
          return rememberedAfterWait.decision;
        }
      }
      return result;
    }

    const approvalCheck = this.runUserApprovalFlow(
      toolName,
      parameters,
      assessment,
      domain,
      fullContext,
      options,
    );
    this.inFlightApprovalChecks.set(memoryKey, approvalCheck);
    try {
      return await approvalCheck;
    } finally {
      if (this.inFlightApprovalChecks.get(memoryKey) === approvalCheck) {
        this.inFlightApprovalChecks.delete(memoryKey);
      }
    }
  }

  private async runUserApprovalFlow(
    toolName: string,
    parameters: Record<string, any>,
    assessment: RiskAssessment,
    domain: string | undefined,
    fullContext: ApprovalContext,
    options?: ApprovalCheckOptions,
  ): Promise<ApprovalCheckResult> {
    if (this.hookDispatcher) {
      const hookInput: HookInput = {
        hook_event_name: 'PermissionRequest',
        session_id: fullContext.sessionId ?? '',
        tool_name: toolName,
        tool_input: parameters,
        risk_score: assessment.score,
        risk_level: assessment.level,
        current_domain: domain,
      };
      try {
        const hookResult = await this.hookDispatcher.fire('PermissionRequest', hookInput, {
          snapshot: options?.hookSnapshot,
        });
        if (hookResult.permissionDecision === 'approve') {
          await this.recordHistory(toolName, assessment.score, assessment.level, 'auto_approve', 'auto', ['Approved by hook']);
          return 'auto_approve';
        }
        if (hookResult.permissionDecision === 'block') {
          await this.recordHistory(toolName, assessment.score, assessment.level, 'deny', 'auto', ['Blocked by hook']);
          this.firePermissionDeniedHook(toolName, parameters, 'Blocked by hook', fullContext.sessionId);
          return 'deny';
        }
      } catch {
        // Hook failure should not block the approval flow
      }
    }

    // Delegate to ApprovalManager
    // ('deny' is already handled by the early return after ruleDecision check above)
    const approvalRequest: ApprovalRequest = {
      id: `approval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: this.mapToolToApprovalType(toolName),
      title: `Approve ${toolName}`,
      description: `Risk score reasoning: ${assessment.score}/100 (${assessment.level}). ${assessment.factors.join('. ')}`,
      details: {
        action: toolName,
        parameters,
        riskLevel: this.mapRiskLevelToApproval(assessment.level),
        riskScore: assessment.score,
        impact: assessment.factors,
      },
      metadata: {
        sessionId: fullContext.sessionId || '',
        turnId: fullContext.turnId || '',
        toolName,
        timestamp: Date.now(),
        rollbackable: false,
        domain,
        riskScore: assessment.score,
      },
      timeout: this.getTimeoutForMode(),
    };

    const response = await this.approvalManager.requestApproval(approvalRequest);

    if (response.decision === 'approve') {
      await this.recordHistory(toolName, assessment.score, assessment.level, 'auto_approve', 'user', assessment.factors);
      return 'auto_approve';
    }

    await this.recordHistory(toolName, assessment.score, assessment.level, 'deny', 'user', assessment.factors);
    this.firePermissionDeniedHook(toolName, parameters, response.reason ?? 'Denied by user', fullContext.sessionId);
    // Return user's alternative text alongside denial when present
    if (response.reason && response.reason !== 'Denied by user') {
      return { decision: 'deny', reason: response.reason };
    }
    return 'deny';
  }

  /**
   * Remember a decision for this session
   */
  rememberDecision(
    toolName: string,
    parameters: Record<string, any>,
    decision: ApprovalDecision,
    domain?: string,
    riskScore?: number,
  ): void {
    const key = this.buildMemoryKey(toolName, parameters, domain);
    this.sessionMemory.set(key, {
      toolName,
      parameterHash: key,
      decision,
      timestamp: Date.now(),
      domain,
      approvedRiskScore: riskScore,
    });
  }

  /**
   * Clear session memory
   */
  clearMemory(): void {
    this.sessionMemory.clear();
  }

  /**
   * Get current session memory entries count
   */
  getMemorySize(): number {
    return this.sessionMemory.size;
  }

  /**
   * Get the ask threshold for the current mode
   */
  private getAskThreshold(): number {
    switch (this.mode) {
      case 'balanced': return 30;
      case 'high_speed': return 60;
      case 'yolo': return 100; // unreachable (yolo handled above)
      default: return 30;
    }
  }

  /**
   * Get the approval timeout for the current mode.
   * Returns 0 for modes that should wait indefinitely for user input.
   */
  private getTimeoutForMode(): number {
    switch (this.mode) {
      case 'balanced': return 0; // No timeout — always wait for user
      case 'high_speed': return 600000; // 10 minutes, auto-approve on expiry
      case 'yolo': return 600000; // unreachable (yolo handled above)
      default: return 0;
    }
  }

  /**
   * Record a decision to history via config storage
   */
  private async recordHistory(
    toolName: string,
    score: number,
    level: RiskLevel,
    decision: ApprovalDecision,
    source: 'auto' | 'user' | 'timeout',
    factors: string[]
  ): Promise<void> {
    if (!this.configStorage) return;

    const entry: ApprovalHistoryEntry = {
      timestamp: Date.now(),
      toolName,
      riskScore: score,
      riskLevel: level,
      decision,
      source,
      factors,
    };

    try {
      await this.configStorage.appendHistory(entry);
    } catch {
      // Non-critical: don't block tool execution on history save failure
    }
  }

  /**
   * Fire PermissionDenied hook (informational, fire-and-forget).
   */
  private firePermissionDeniedHook(
    toolName: string,
    parameters: Record<string, any>,
    reason: string,
    sessionId?: string,
  ): void {
    if (!this.hookDispatcher) return;
    const hookInput: HookInput = {
      hook_event_name: 'PermissionDenied',
      session_id: sessionId ?? '',
      tool_name: toolName,
      tool_input: parameters,
      approval_decision: 'deny',
    };
    this.hookDispatcher.fire('PermissionDenied', hookInput).catch(() => {});
  }

  /**
   * Check if a domain matches a pattern (exact match or subdomain)
   * Handles boundary correctly: "bank.com" matches "bank.com" and "my.bank.com"
   * but NOT "notabank.com"
   */
  private matchesDomainPattern(domain: string, pattern: string): boolean {
    return domain === pattern || domain.endsWith('.' + pattern);
  }

  /**
   * Build a tool-category-aware memory key.
   *
   * Key format by tool category:
   * - Web tools (browser_dom): `browser_dom||{action}||{domain}`
   * - Web tools (MCP browser__*): `browser__||{action}||{domain}`
   * - Terminal: `terminal||{command}` (full command string, like Claude Code)
   * - Other tools: `{toolName}` (broad tool-level trust)
   */
  private buildMemoryKey(toolName: string, parameters: Record<string, any>, domain?: string): string {
    // Web tools (extension DOM tool)
    if (toolName === 'browser_dom') {
      const action = parameters.action || 'unknown';
      return `browser_dom||${action}||${domain || '_unknown_'}`;
    }
    // Web tools (desktop MCP browser tools)
    if (toolName.startsWith('browser__')) {
      const action = toolName.split('__').pop() || 'unknown';
      return `browser__||${action}||${domain || '_unknown_'}`;
    }
    // Terminal: full command string (exact match, like Claude Code's per-command pattern)
    if (toolName === 'terminal') {
      const command = (parameters.command || '').trim() || 'unknown';
      return `terminal||${command}`;
    }
    // Other tools: broad tool-level trust
    return toolName;
  }

  /**
   * Map tool name to approval request type
   */
  private mapToolToApprovalType(
    toolName: string
  ): 'command' | 'file_operation' | 'network_access' | 'storage_access' | 'dangerous_action' {
    if (toolName === 'terminal') return 'command';
    if (toolName.includes('storage')) return 'storage_access';
    if (toolName.includes('network') || toolName.includes('web_scraping')) return 'network_access';
    return 'dangerous_action';
  }

  /**
   * Map RiskLevel to ApprovalDetails riskLevel
   */
  private mapRiskLevelToApproval(level: string): 'low' | 'medium' | 'high' | 'critical' {
    switch (level) {
      case 'none': return 'low';
      case 'low': return 'low';
      case 'medium': return 'medium';
      case 'high': return 'high';
      case 'critical': return 'critical';
      default: return 'medium';
    }
  }
}
