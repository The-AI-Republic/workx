/**
 * Formatter Utilities for Event Display
 *
 * These functions transform raw data into human-readable strings
 * for display in the UI.
 */

/**
 * Format duration in milliseconds to human-readable string
 *
 * @param ms - Duration in milliseconds
 * @returns Formatted string (e.g., "45ms", "2.3s", "1m 30s", "1h 5m")
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }

  if (ms < 60000) {
    // Less than 60 seconds
    const seconds = ms / 1000;
    return `${seconds.toFixed(1)}s`;
  }

  if (ms < 3600000) {
    // Less than 60 minutes
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }

  // 1 hour or more
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

/**
 * Format number with thousands separators
 *
 * @param num - Number to format
 * @param locale - Locale for formatting (default: 'en-US')
 * @returns Formatted string with separators (e.g., "1,234", "1,234,567")
 */
export function formatNumber(num: number, locale: string = 'en-US'): string {
  return num.toLocaleString(locale);
}

/**
 * Format token count with thousands separators and optional label
 *
 * @param tokens - Number of tokens
 * @param label - Optional label (e.g., "input", "output")
 * @returns Formatted string (e.g., "1,234", "1,234 input", "1 token")
 */
export function formatTokens(tokens: number, label?: string): string {
  const formattedNumber = formatNumber(tokens);

  if (!label) {
    return formattedNumber;
  }

  // Handle singular/plural
  const pluralLabel = tokens === 1 ? label.replace(/s$/, '') : label;
  return `${formattedNumber} ${pluralLabel}`;
}

/**
 * Format timestamp for display
 *
 * @param date - Date object
 * @param format - 'relative' | 'absolute' | 'timestamp'
 * @returns Formatted string
 */
export function formatTime(
  date: Date,
  format: 'relative' | 'absolute' | 'timestamp'
): string {
  if (format === 'absolute') {
    // "HH:MM:SS" in 24-hour format
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  }

  if (format === 'timestamp') {
    // "[YYYY-MM-DDTHH:MM:SS]"
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `[${year}-${month}-${day}T${hours}:${minutes}:${seconds}]`;
  }

  // Relative time
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);

  if (diffSeconds < 10) {
    return 'just now';
  }

  if (diffSeconds < 60) {
    return `${diffSeconds}s ago`;
  }

  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }

  // More than 24 hours, return date
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  });
}

/**
 * Format command for display (handles escaping and truncation)
 *
 * @param command - Command string or array of args
 * @param maxLength - Maximum length before truncation (default: no limit)
 * @returns Formatted command string
 */
export function formatCommand(
  command: string | string[],
  maxLength?: number
): string {
  let formatted: string;

  if (Array.isArray(command)) {
    // Join array with proper shell escaping
    formatted = command
      .map((arg) => {
        // Simple escaping: quote if contains spaces or special chars
        if (/[\s$"'`\\]/.test(arg)) {
          // Escape single quotes and wrap in single quotes
          return `'${arg.replace(/'/g, "'\\''")}'`;
        }
        return arg;
      })
      .join(' ');
  } else {
    formatted = command;
  }

  // Truncate if needed
  if (maxLength && formatted.length > maxLength) {
    return formatted.substring(0, maxLength - 3) + '...';
  }

  return formatted;
}

/**
 * Format exit code with status text
 *
 * @param exitCode - Command exit code
 * @returns Formatted string with semantic meaning
 */
export function formatExitCode(exitCode: number): string {
  switch (exitCode) {
    case 0:
      return 'success';
    case 127:
      return 'command not found (127)';
    case 130:
      return 'interrupted (130)';
    case 137:
      return 'killed (137)';
    default:
      return `exited ${exitCode}`;
  }
}

/**
 * Truncate text to maximum number of lines
 *
 * @param text - Text to truncate
 * @param maxLines - Maximum lines to include
 * @returns Truncated text with indicator if truncated
 */
export function truncateOutput(text: string, maxLines: number): string {
  const lines = text.split('\n');

  if (lines.length <= maxLines) {
    return text;
  }

  const visibleLines = lines.slice(0, maxLines);
  const remainingCount = lines.length - maxLines;
  const truncationMessage = `... (${remainingCount} more line${
    remainingCount === 1 ? '' : 's'
  })`;

  // Preserve trailing newline if original had one
  const result = visibleLines.join('\n');
  return text.endsWith('\n') ? result + '\n' + truncationMessage : result + '\n' + truncationMessage;
}

/**
 * Format file size in bytes to human-readable string
 *
 * @param bytes - Size in bytes
 * @returns Formatted string (e.g., "1.2 KB", "3.4 MB")
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(1)} KB`;
  }

  const mb = kb / 1024;
  if (mb < 1024) {
    return `${mb.toFixed(1)} MB`;
  }

  const gb = mb / 1024;
  return `${gb.toFixed(1)} GB`;
}

/**
 * Format percentage with specified decimals
 *
 * @param value - Value between 0 and 1
 * @param decimals - Number of decimal places (default: 0)
 * @returns Formatted percentage string
 */
export function formatPercent(value: number, decimals: number = 0): string {
  // Clamp to 0-1 range
  const clamped = Math.max(0, Math.min(1, value));
  const percentage = clamped * 100;
  return `${percentage.toFixed(decimals)}%`;
}

/**
 * Format diff summary showing additions/deletions
 *
 * @param additions - Number of lines added
 * @param deletions - Number of lines deleted
 * @returns Formatted string (e.g., "+12 -5", "+5", "-3", "no changes")
 */
export function formatDiffSummary(additions: number, deletions: number): string {
  if (additions === 0 && deletions === 0) {
    return 'no changes';
  }

  const parts: string[] = [];

  if (additions > 0) {
    parts.push(`+${additions}`);
  }

  if (deletions > 0) {
    parts.push(`-${deletions}`);
  }

  return parts.join(' ');
}
