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

export class ApprovalGate {
  private approvalManager: ApprovalManager;
  private policyEngine: PolicyRulesEngine;
  private enhancers: IContextEnhancer[] = [];
  private sessionMemory: Map<string, SessionMemoryEntry> = new Map();
  private mode: ApprovalMode = 'balanced';
  private trustedDomains: string[] = [];
  private blockedDomains: string[] = [];
  private configStorage: ApprovalConfigStorage | null = null;

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
    context?: Partial<ApprovalContext>
  ): Promise<ApprovalDecision> {
    // Build full context
    const fullContext: ApprovalContext = {
      toolName,
      parameters,
      ...context,
    };

    // Fast path: check blocked domains
    const domain = fullContext.currentDomain;
    if (domain && this.blockedDomains.length > 0) {
      if (this.blockedDomains.some(d => domain.endsWith(d))) {
        await this.recordHistory(toolName, 0, RiskLevel.Critical, 'deny', 'auto', ['Blocked domain']);
        return 'deny';
      }
    }

    // Fast path: check trusted domains
    if (domain && this.trustedDomains.length > 0) {
      if (this.trustedDomains.some(d => domain.endsWith(d))) {
        await this.recordHistory(toolName, 0, RiskLevel.None, 'auto_approve', 'auto', ['Trusted domain']);
        return 'auto_approve';
      }
    }

    // Check session memory for a remembered decision
    const memoryKey = this.buildMemoryKey(toolName, parameters);
    const remembered = this.sessionMemory.get(memoryKey);
    if (remembered) {
      return remembered.decision;
    }

    // YOLO mode: auto-approve everything (deny rules still checked above)
    if (this.mode === 'yolo') {
      await this.recordHistory(toolName, 0, RiskLevel.None, 'auto_approve', 'auto', ['YOLO mode']);
      return 'auto_approve';
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

    // 3. Apply mode-based threshold adjustment
    const effectiveScore = assessment.score;
    const askThreshold = this.getAskThreshold();

    // 4. Evaluate policy rules
    const ruleDecision = this.policyEngine.evaluate(toolName, parameters, effectiveScore);

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

    // 5. Handle the decision
    if (decision === 'auto_approve') {
      await this.recordHistory(toolName, assessment.score, assessment.level, 'auto_approve', 'auto', assessment.factors);
      return 'auto_approve';
    }

    if (decision === 'deny') {
      await this.recordHistory(toolName, assessment.score, assessment.level, 'deny', 'auto', assessment.factors);
      return 'deny';
    }

    // decision === 'ask_user': delegate to ApprovalManager
    const approvalRequest: ApprovalRequest = {
      id: `approval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: this.mapToolToApprovalType(toolName),
      title: `Approve ${toolName}`,
      description: `Risk score: ${assessment.score}/100 (${assessment.level}). ${assessment.factors.join('. ')}`,
      details: {
        action: toolName,
        parameters,
        riskLevel: this.mapRiskLevelToApproval(assessment.level),
        impact: assessment.factors,
      },
      metadata: {
        sessionId: fullContext.sessionId || '',
        turnId: fullContext.turnId || '',
        toolName,
        timestamp: Date.now(),
        rollbackable: false,
      },
    };

    const response = await this.approvalManager.requestApproval(approvalRequest);

    if (response.decision === 'approve') {
      await this.recordHistory(toolName, assessment.score, assessment.level, 'auto_approve', 'user', assessment.factors);
      return 'auto_approve';
    }

    await this.recordHistory(toolName, assessment.score, assessment.level, 'deny', 'user', assessment.factors);
    return 'deny';
  }

  /**
   * Remember a decision for this session
   */
  rememberDecision(toolName: string, parameters: Record<string, any>, decision: ApprovalDecision): void {
    const key = this.buildMemoryKey(toolName, parameters);
    this.sessionMemory.set(key, {
      toolName,
      parameterHash: key,
      decision,
      timestamp: Date.now(),
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
      case 'cautious': return 10;
      case 'balanced': return 30;
      case 'autonomous': return 60;
      case 'yolo': return 100; // unreachable (yolo handled above)
      default: return 30;
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
   * Build a memory key from tool name and parameters (keys + values)
   */
  private buildMemoryKey(toolName: string, parameters: Record<string, any>): string {
    const sorted = Object.keys(parameters).sort().reduce((obj, key) => {
      obj[key] = parameters[key];
      return obj;
    }, {} as Record<string, any>);
    return `${toolName}||${JSON.stringify(sorted)}`;
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
