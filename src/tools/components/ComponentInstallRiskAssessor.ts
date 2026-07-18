import type { ApprovalContext, IRiskAssessor, RiskAssessment } from '@/core/approval/types';
import { RiskLevel } from '@/core/approval/types';

export class ComponentInstallRiskAssessor implements IRiskAssessor {
  assess(
    _toolName: string,
    parameters: Record<string, unknown>,
    _context?: ApprovalContext
  ): RiskAssessment {
    const snapshot = _context?.dataTurnSnapshot;
    const localDesktopTurn = Boolean(
      snapshot?.attended &&
      snapshot.origin.channel === 'local' &&
      snapshot.origin.channelId === 'desktop-runtime-main' &&
      snapshot.origin.channelType === 'tauri'
    );
    if (!localDesktopTurn) {
      return {
        score: 100,
        level: RiskLevel.Critical,
        factors: ['Component installation is restricted to attended WorkX Desktop turns'],
        action: 'deny',
        hardDeny: true,
      };
    }
    const componentId =
      typeof parameters.component_id === 'string' ? parameters.component_id : 'unknown component';
    return {
      score: 70,
      level: RiskLevel.High,
      factors: [
        `Downloads and installs trusted executable code for ${componentId}`,
        'Installation is private to WorkX and does not modify the system PATH',
      ],
      action: 'ask_user',
      requiresExplicitUserApproval: true,
    };
  }
}
