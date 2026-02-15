/**
 * Core types for the User Approval System
 *
 * Defines risk assessment, policy rules, and approval decision interfaces
 * used across the approval pipeline.
 */

/**
 * Risk level thresholds mapped to score ranges
 */
export enum RiskLevel {
  /** Score 0-10: No risk, always auto-approve */
  None = 'none',
  /** Score 11-30: Low risk, typically auto-approve */
  Low = 'low',
  /** Score 31-60: Medium risk, may require approval */
  Medium = 'medium',
  /** Score 61-85: High risk, typically requires approval */
  High = 'high',
  /** Score 86-100: Critical risk, typically denied */
  Critical = 'critical',
}

/**
 * Map a numeric risk score (0-100) to a RiskLevel
 */
export function scoreToRiskLevel(score: number): RiskLevel {
  const clamped = Math.max(0, Math.min(100, Number(score) || 0));
  if (clamped <= 10) return RiskLevel.None;
  if (clamped <= 30) return RiskLevel.Low;
  if (clamped <= 60) return RiskLevel.Medium;
  if (clamped <= 85) return RiskLevel.High;
  return RiskLevel.Critical;
}

/**
 * Final decision from the approval pipeline
 */
export type ApprovalDecision = 'auto_approve' | 'ask_user' | 'deny';

/**
 * Result of a risk assessment for a tool call
 */
export interface RiskAssessment {
  /** Numeric score 0-100 */
  score: number;
  /** Categorized risk level */
  level: RiskLevel;
  /** Human-readable factors that contributed to the score */
  factors: string[];
  /** Recommended action based on score */
  action: ApprovalDecision;
}

/**
 * Interface for tool-specific risk assessors
 */
export interface IRiskAssessor {
  /**
   * Assess the risk of a tool call
   * @param toolName - Name of the tool being called
   * @param parameters - Tool call parameters
   * @param context - Optional execution context
   * @returns Risk assessment result
   */
  assess(
    toolName: string,
    parameters: Record<string, any>,
    context?: ApprovalContext
  ): RiskAssessment;
}

/**
 * Interface for context enhancers that modify risk assessments
 */
export interface IContextEnhancer {
  /**
   * Enhance/modify a risk assessment based on contextual information
   * @param assessment - Current risk assessment
   * @param context - Execution context
   * @returns Modified risk assessment
   */
  enhance(assessment: RiskAssessment, context: ApprovalContext): RiskAssessment;
}

/**
 * Policy rule for the rules engine
 */
export interface PolicyRule {
  /** Rule type: deny rules checked first, then ask, then allow */
  type: 'allow' | 'ask' | 'deny';
  /** Matching criteria */
  match: {
    /** Tool name pattern (supports glob-like matching with *) */
    tool?: string;
    /** Parameter value pattern (regex string) to match against serialized parameters */
    pattern?: string;
    /** Match when risk score is above this threshold */
    riskAbove?: number;
  };
  /** Human-readable description of this rule */
  description: string;
}

/**
 * Context passed through the approval pipeline
 */
export interface ApprovalContext {
  /** Name of the tool being called */
  toolName: string;
  /** Tool parameters */
  parameters: Record<string, any>;
  /** Current session ID */
  sessionId?: string;
  /** Current turn ID */
  turnId?: string;
  /** Current page URL (extension) */
  currentUrl?: string;
  /** Current page domain (extracted from URL) */
  currentDomain?: string;
  /** Current working directory (desktop) */
  cwd?: string;
}

/**
 * Session memory entry for "remember this session" decisions
 */
export interface SessionMemoryEntry {
  /** Tool name */
  toolName: string;
  /** Parameter hash for matching similar calls */
  parameterHash: string;
  /** Remembered decision */
  decision: ApprovalDecision;
  /** When this decision was made */
  timestamp: number;
  /** Domain at time of decision (for web tools) */
  domain?: string;
  /** Risk score at time of decision (for risk ceiling guard) */
  approvedRiskScore?: number;
}

/**
 * Approval operating mode
 */
export type ApprovalMode = 'balanced' | 'high_speed' | 'yolo';

/**
 * Persistent approval configuration
 */
export interface IApprovalConfig {
  version: '1.0.0';
  mode: ApprovalMode;
  userRules: PolicyRule[];
  trustedDomains: string[];
  blockedDomains: string[];
  timeouts: {
    low: number;
    medium: number;
    high: number;
    critical: number;
  };
}

/**
 * Default approval configuration
 */
export const DEFAULT_APPROVAL_CONFIG: IApprovalConfig = {
  version: '1.0.0',
  mode: 'balanced',
  userRules: [],
  trustedDomains: [],
  blockedDomains: [],
  timeouts: {
    low: 600000,
    medium: 60000,
    high: 120000,
    critical: 120000,
  },
};

/**
 * Entry in the approval history log
 */
export interface ApprovalHistoryEntry {
  timestamp: number;
  toolName: string;
  riskScore: number;
  riskLevel: RiskLevel;
  decision: ApprovalDecision;
  source: 'auto' | 'user' | 'timeout';
  factors: string[];
}
