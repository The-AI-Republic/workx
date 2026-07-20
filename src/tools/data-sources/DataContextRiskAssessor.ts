import {
  scoreToRiskLevel,
  type ApprovalContext,
  type IRiskAssessor,
  type RiskAssessment,
} from '@/core/approval/types';
import {
  normalizeEvidence,
  type DataSourceRuntime,
  type LearnDataContextRequest,
} from '@/core/data-sources';

function assessment(
  score: number,
  action: RiskAssessment['action'],
  factor: string
): RiskAssessment {
  return { score, level: scoreToRiskLevel(score), factors: [factor], action };
}

export class DataContextRiskAssessor implements IRiskAssessor {
  constructor(private readonly runtime: DataSourceRuntime) {}

  assess(
    _toolName: string,
    parameters: Record<string, unknown>,
    context?: ApprovalContext
  ): RiskAssessment {
    const snapshot = context?.dataTurnSnapshot;
    if (
      !snapshot ||
      !snapshot.durableLearningEligible ||
      snapshot.origin.channel !== 'local' ||
      !snapshot.attended ||
      snapshot.origin.channelId !== 'desktop-runtime-main' ||
      snapshot.origin.channelType !== 'tauri'
    ) {
      return assessment(100, 'deny', 'Durable context requires an attended local user turn.');
    }
    try {
      const request = parameters as unknown as LearnDataContextRequest;
      const source = this.runtime.getSourceForAssessment(request.source_id);
      if (
        source.lifecycleState !== 'active' ||
        !source.enabled ||
        !source.policy.agentAccessEnabled
      )
        return assessment(100, 'deny', 'The source is unavailable for agent access.');
      if (source.policy.learningMode === 'off')
        return assessment(100, 'deny', 'Context learning is disabled.');
      const text = normalizeEvidence(context?.currentUserText ?? '');
      if (
        !request.facts?.length ||
        request.facts.some((fact) => !text.includes(normalizeEvidence(fact.evidence_quote)))
      ) {
        return assessment(
          100,
          'deny',
          'One or more evidence quotes are absent from the current user turn.'
        );
      }
      return source.policy.learningMode === 'ask'
        ? assessment(30, 'ask_user', 'This source asks before saving context.')
        : assessment(15, 'auto_approve', 'Additive user-asserted context with verified evidence.');
    } catch {
      return assessment(100, 'deny', 'The context update could not be validated.');
    }
  }
}
