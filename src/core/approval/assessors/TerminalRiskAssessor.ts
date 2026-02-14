/**
 * Terminal Risk Assessor
 *
 * Assesses risk for terminal tool calls (desktop only).
 * Wraps the existing SecurityFilter logic and maps its 0-10 scale to 0-100.
 */

import type { IRiskAssessor, RiskAssessment, ApprovalContext } from '../types';
import { scoreToRiskLevel } from '../types';

/** Safe read-only commands (score 0) */
const SAFE_COMMANDS = /^(ls|cat|head|tail|grep|rg|pwd|echo|find|wc|which|whoami|date|file|tree|du|df|uname|env|printenv)\b/;

/** Safe git read-only commands (score 5) */
const SAFE_GIT = /^git\s+(status|log|diff|branch|tag|show|remote|stash\s+list)\b/;

/** Modifying commands that need confirmation (score 35) */
const MODIFY_COMMANDS = /^(npm\s+install|yarn\s+add|pip\s+install|git\s+(commit|push|merge|rebase|checkout|stash)|mkdir|touch|cp)\b/;

/** Dangerous commands (score 65) */
const DANGEROUS_COMMANDS = /^(rm|sudo|chmod|chown|chgrp|mv|docker|kill|pkill|killall)\b/;

/** Critical/blocked patterns (score 95) - mapped from SecurityFilter */
const CRITICAL_PATTERNS = [
  /rm\s+(-[rf]+\s+)+\//i,              // rm -rf /
  /rm\s+(-[rf]+\s+)+~/i,              // rm -rf ~
  /rm\s+(-[rf]+\s+)+\*/i,             // rm -rf *
  /dd\s+.*of=\/dev\//i,               // dd to device
  /mkfs\./i,                           // Format filesystem
  /:\(\)\{\s*:\|:&\s*\};:/,           // Fork bomb
  /curl.*\|.*sh/i,                     // Pipe curl to shell
  /wget.*\|.*sh/i,                     // Pipe wget to shell
  /curl.*\|.*bash/i,
  /wget.*\|.*bash/i,
  /\/dev\/tcp\//i,                     // Reverse shell
  /nc\s+-e/i,                          // Netcat reverse shell
  /bash\s+-i\s+>&/i,                  // Bash reverse shell
  /^shutdown/i,
  /^reboot/i,
  /^poweroff/i,
  /^halt/i,
  /^init\s+[0156]/i,
  /xmrig|minerd|cpuminer|cryptonight/i, // Crypto mining
];

export class TerminalRiskAssessor implements IRiskAssessor {
  assess(
    _toolName: string,
    parameters: Record<string, any>,
    _context?: ApprovalContext
  ): RiskAssessment {
    const command = (parameters.command || '').trim();
    const factors: string[] = [];

    if (!command) {
      return {
        score: 0,
        level: scoreToRiskLevel(0),
        factors: ['Empty command'],
        action: 'auto_approve',
      };
    }

    // Check critical patterns first (deny)
    for (const pattern of CRITICAL_PATTERNS) {
      if (pattern.test(command)) {
        return {
          score: 95,
          level: scoreToRiskLevel(95),
          factors: ['Command matches critical blocked pattern'],
          action: 'deny',
        };
      }
    }

    let score = 20; // Default baseline

    // Safe read-only commands
    if (SAFE_COMMANDS.test(command)) {
      score = 0;
      factors.push('Read-only command');
    }
    // Safe git commands
    else if (SAFE_GIT.test(command)) {
      score = 5;
      factors.push('Read-only git command');
    }
    // Modifying commands
    else if (MODIFY_COMMANDS.test(command)) {
      score = 35;
      factors.push('Modifying command');
    }
    // Dangerous commands
    else if (DANGEROUS_COMMANDS.test(command)) {
      score = 65;
      factors.push('Potentially dangerous command');
    }

    // Additional risk modifiers
    if (/^sudo\s/.test(command)) {
      score = Math.min(score + 15, 85);
      factors.push('Uses sudo elevation');
    }

    // Strip quoted strings before checking for shell operators and redirects
    const unquoted = command.replace(/"[^"]*"|'[^']*'/g, '');

    if (/[|;&]/.test(unquoted)) {
      score = Math.min(score + 5, 85);
      factors.push('Uses shell operators');
    }

    if (/[><]/.test(unquoted)) {
      score = Math.min(score + 5, 85);
      factors.push('Uses file redirects');
    }

    const level = scoreToRiskLevel(score);
    const action = score <= 10 ? 'auto_approve' as const
      : score <= 30 ? 'auto_approve' as const
      : score <= 85 ? 'ask_user' as const
      : 'deny' as const;

    return { score, level, factors, action };
  }
}
