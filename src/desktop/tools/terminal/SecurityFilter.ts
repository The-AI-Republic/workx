/**
 * Security Filter
 *
 * Filters and validates terminal commands for safety.
 * Implements blocklist patterns to prevent dangerous operations.
 *
 * @module desktop/tools/terminal/SecurityFilter
 */

/**
 * Security filter result
 */
export interface FilterResult {
  /** Whether the command is allowed */
  allowed: boolean;
  /** Reason if blocked */
  reason?: string;
  /** Sanitized command if allowed */
  sanitizedCommand?: string;
  /** Risk level (0-10) */
  riskLevel: number;
}

/**
 * Security config
 */
export interface SecurityConfig {
  /** Blocked command patterns (regex strings) */
  blockedPatterns?: string[];
  /** Allowed command prefixes */
  allowedPrefixes?: string[];
  /** Maximum command length */
  maxCommandLength?: number;
  /** Allow shell operators (|, &&, ||, ;) */
  allowShellOperators?: boolean;
  /** Allow environment variable expansion */
  allowEnvExpansion?: boolean;
  /** Allow file redirects (>, <, >>) */
  allowRedirects?: boolean;
  /** Require explicit confirmation for certain commands */
  requireConfirmation?: string[];
}

/**
 * Default blocked patterns - commands that should never be executed
 */
const DEFAULT_BLOCKED_PATTERNS: string[] = [
  // Destructive file operations
  '^rm\\s+(-[rf]+\\s+)+/',           // rm -rf /
  '^rm\\s+(-[rf]+\\s+)+~',           // rm -rf ~
  '^rm\\s+(-[rf]+\\s+)+\\*',         // rm -rf *
  '^rm\\s+(-[rf]+\\s+)+\\.',         // rm -rf .
  '^rmdir\\s+/',                      // rmdir /
  '^dd\\s+.*of=/dev/',               // dd to device
  '^mkfs\\.',                         // Format filesystem

  // System modification
  '^chmod\\s+(-R\\s+)?[0-7]{3,4}\\s+/', // chmod on root
  '^chown\\s+(-R\\s+)?.*\\s+/',      // chown on root
  '^chgrp\\s+(-R\\s+)?.*\\s+/',      // chgrp on root

  // Network attacks
  ':(){ :|:& };:',                    // Fork bomb
  '\\.\\s*/dev/(sd|hd)',              // Direct disk access

  // Privilege escalation
  '^sudo\\s+.*rm\\s+(-[rf]+\\s+)+/', // sudo rm -rf /

  // Dangerous downloads
  'curl.*\\|.*sh',                    // Pipe curl to shell
  'wget.*\\|.*sh',                    // Pipe wget to shell
  'curl.*\\|.*bash',
  'wget.*\\|.*bash',

  // Crypto mining indicators
  'xmrig',
  'minerd',
  'cpuminer',
  'cryptonight',

  // Reverse shells
  '/dev/tcp/',
  'nc\\s+-e',
  'ncat\\s+-e',
  'bash\\s+-i\\s+>&',

  // System shutdown/reboot
  '^shutdown',
  '^reboot',
  '^poweroff',
  '^halt',
  '^init\\s+[0156]',
];

/**
 * Default security config
 */
const DEFAULT_CONFIG: SecurityConfig = {
  blockedPatterns: DEFAULT_BLOCKED_PATTERNS,
  maxCommandLength: 10000,
  allowShellOperators: true,
  allowEnvExpansion: true,
  allowRedirects: true,
  requireConfirmation: ['sudo', 'rm', 'mv', 'chmod', 'chown'],
};

/**
 * SecurityFilter validates and filters terminal commands
 *
 * @example
 * ```typescript
 * const filter = new SecurityFilter();
 *
 * // Check a safe command
 * const result1 = filter.check('ls -la');
 * // { allowed: true, riskLevel: 0 }
 *
 * // Check a dangerous command
 * const result2 = filter.check('rm -rf /');
 * // { allowed: false, reason: 'Destructive operation blocked', riskLevel: 10 }
 * ```
 */
export class SecurityFilter {
  private config: SecurityConfig;
  private blockedRegexes: RegExp[];

  constructor(config?: Partial<SecurityConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Compile blocked patterns
    this.blockedRegexes = (this.config.blockedPatterns || []).map(
      (pattern) => new RegExp(pattern, 'i')
    );
  }

  /**
   * Check if a command is allowed
   *
   * @param command - Command to check
   * @returns Filter result
   */
  check(command: string): FilterResult {
    // Empty command
    if (!command || !command.trim()) {
      return { allowed: false, reason: 'Empty command', riskLevel: 0 };
    }

    const trimmedCommand = command.trim();

    // Check length
    if (trimmedCommand.length > (this.config.maxCommandLength || 10000)) {
      return {
        allowed: false,
        reason: 'Command exceeds maximum length',
        riskLevel: 3,
      };
    }

    // Check against blocked patterns
    for (const regex of this.blockedRegexes) {
      if (regex.test(trimmedCommand)) {
        return {
          allowed: false,
          reason: 'Command matches blocked pattern',
          riskLevel: 10,
        };
      }
    }

    // Check shell operators
    if (!this.config.allowShellOperators) {
      if (/[|;&]/.test(trimmedCommand)) {
        return {
          allowed: false,
          reason: 'Shell operators not allowed',
          riskLevel: 5,
        };
      }
    }

    // Check redirects
    if (!this.config.allowRedirects) {
      if (/[><]/.test(trimmedCommand)) {
        return {
          allowed: false,
          reason: 'File redirects not allowed',
          riskLevel: 4,
        };
      }
    }

    // Check environment expansion
    if (!this.config.allowEnvExpansion) {
      if (/\$[\w{]/.test(trimmedCommand)) {
        return {
          allowed: false,
          reason: 'Environment variable expansion not allowed',
          riskLevel: 3,
        };
      }
    }

    // Calculate risk level
    const riskLevel = this.calculateRiskLevel(trimmedCommand);

    // Check if confirmation required
    const needsConfirmation = this.needsConfirmation(trimmedCommand);

    return {
      allowed: true,
      sanitizedCommand: trimmedCommand,
      riskLevel,
      reason: needsConfirmation ? 'Requires user confirmation' : undefined,
    };
  }

  /**
   * Check if a command requires user confirmation
   */
  needsConfirmation(command: string): boolean {
    if (!this.config.requireConfirmation) {
      return false;
    }

    const firstWord = command.trim().split(/\s+/)[0];
    return this.config.requireConfirmation.includes(firstWord);
  }

  /**
   * Calculate risk level (0-10)
   */
  private calculateRiskLevel(command: string): number {
    let risk = 0;

    // Elevated commands
    if (command.startsWith('sudo ')) {
      risk += 3;
    }

    // File operations
    if (/\b(rm|mv|cp|chmod|chown)\b/.test(command)) {
      risk += 2;
    }

    // Network operations
    if (/\b(curl|wget|nc|ssh|scp)\b/.test(command)) {
      risk += 2;
    }

    // Package management
    if (/\b(apt|yum|dnf|pacman|brew|npm|pip)\b/.test(command)) {
      risk += 2;
    }

    // Shell operators increase risk
    if (/[|;&]/.test(command)) {
      risk += 1;
    }

    // Redirects
    if (/[><]/.test(command)) {
      risk += 1;
    }

    return Math.min(risk, 10);
  }

  /**
   * Add a blocked pattern
   */
  addBlockedPattern(pattern: string): void {
    this.config.blockedPatterns = this.config.blockedPatterns || [];
    this.config.blockedPatterns.push(pattern);
    this.blockedRegexes.push(new RegExp(pattern, 'i'));
  }

  /**
   * Remove a blocked pattern
   */
  removeBlockedPattern(pattern: string): void {
    if (!this.config.blockedPatterns) {
      return;
    }

    const index = this.config.blockedPatterns.indexOf(pattern);
    if (index !== -1) {
      this.config.blockedPatterns.splice(index, 1);
      this.blockedRegexes.splice(index, 1);
    }
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<SecurityConfig>): void {
    this.config = { ...this.config, ...config };

    // Recompile patterns if they changed
    if (config.blockedPatterns) {
      this.blockedRegexes = config.blockedPatterns.map(
        (pattern) => new RegExp(pattern, 'i')
      );
    }
  }

  /**
   * Get current configuration
   */
  getConfig(): SecurityConfig {
    return { ...this.config };
  }
}
