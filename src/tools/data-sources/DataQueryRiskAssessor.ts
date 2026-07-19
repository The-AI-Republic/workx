import {
  scoreToRiskLevel,
  type ApprovalContext,
  type IRiskAssessor,
  type RiskAssessment,
} from '@/core/approval/types';
import type { DataQueryRequest, DataSourceRuntime } from '@/core/data-sources';

function assessment(
  score: number,
  action: RiskAssessment['action'],
  factor: string
): RiskAssessment {
  return { score, level: scoreToRiskLevel(score), factors: [factor], action };
}

export class DataQueryRiskAssessor implements IRiskAssessor {
  constructor(private readonly runtime: DataSourceRuntime) {}

  assess(
    _toolName: string,
    parameters: Record<string, unknown>,
    context?: ApprovalContext
  ): RiskAssessment {
    const snapshot = context?.dataTurnSnapshot;
    if (
      !snapshot ||
      snapshot.origin.channel !== 'local' ||
      !snapshot.attended ||
      snapshot.origin.channelId !== 'desktop-runtime-main' ||
      snapshot.origin.channelType !== 'tauri'
    ) {
      return assessment(100, 'deny', 'Data queries require an attended local desktop turn.');
    }
    try {
      const request = parameters as unknown as DataQueryRequest;
      const source = this.runtime.getSourceForAssessment(request.source_id);
      if (
        source.lifecycleState !== 'active' ||
        !source.enabled ||
        !source.policy.agentAccessEnabled ||
        source.lastTest?.status !== 'reachable' ||
        source.lastTest.connectionRevision !== source.connectionRevision ||
        (source.lastTest.readOnlyAssessment.userAcknowledgementRequired &&
          source.policy.leastPrivilegeAcknowledgement?.connectionRevision !==
            source.connectionRevision)
      ) {
        return assessment(
          100,
          'deny',
          'The source is disabled, stale, or not approved for agent access.'
        );
      }
      const validation = this.runtime.validateQueryForAssessment(request);
      if (!validation.valid) return assessment(100, 'deny', validation.message);
      return source.policy.queryApproval === 'ask_each_query'
        ? assessment(25, 'ask_user', 'This source requires approval for every query.')
        : assessment(15, 'auto_approve', 'Validated bounded read-only query.');
    } catch {
      return assessment(100, 'deny', 'The data query could not be validated.');
    }
  }
}
