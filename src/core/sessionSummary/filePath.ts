function preferredSeparator(path: string): '/' | '\\' {
  return path.includes('\\') && !path.includes('/') ? '\\' : '/';
}

function trimLeadingSeparators(path: string): string {
  return path.replace(/^[\\/]+/, '');
}

function trimTrailingSeparators(path: string): string {
  if (/^[A-Za-z]:[\\/]?$/.test(path)) return path;
  if (/^[\\/]+$/.test(path)) return path[0] ?? '/';
  return path.replace(/[\\/]+$/, '');
}

function trimSeparators(path: string): string {
  return trimLeadingSeparators(trimTrailingSeparators(path));
}

export function joinSummaryPath(root: string, ...parts: string[]): string {
  const sep = preferredSeparator(root);
  let joined = trimTrailingSeparators(root);
  for (const part of parts.map(trimSeparators).filter((segment) => segment.length > 0)) {
    joined = !joined || joined.endsWith('/') || joined.endsWith('\\')
      ? `${joined}${part}`
      : `${joined}${sep}${part}`;
  }
  return joined;
}

export function dirnameSummaryPath(filePath: string): string {
  const trimmed = trimTrailingSeparators(filePath);
  const slashIdx = trimmed.lastIndexOf('/');
  const backslashIdx = trimmed.lastIndexOf('\\');
  const idx = Math.max(slashIdx, backslashIdx);

  if (idx < 0) return '.';
  if (idx === 0) return trimmed[0] ?? '/';
  if (/^[A-Za-z]:[\\/]/.test(trimmed) && idx === 2) {
    return trimmed.slice(0, 3);
  }
  return trimmed.slice(0, idx);
}

export function normalizeSummaryPath(filePath: string): string {
  const sep = preferredSeparator(filePath);
  const drive = /^[A-Za-z]:/.test(filePath) ? filePath.slice(0, 2) : '';
  const withoutDrive = drive ? filePath.slice(2) : filePath;
  const absolute = withoutDrive.startsWith('/') || withoutDrive.startsWith('\\');
  const stack: string[] = [];

  for (const part of withoutDrive.split(/[\\/]+/)) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (stack.length > 0 && stack[stack.length - 1] !== '..') {
        stack.pop();
      } else if (!absolute) {
        stack.push(part);
      }
      continue;
    }
    stack.push(part);
  }

  const prefix = `${drive}${absolute ? sep : ''}`;
  const joined = stack.join(sep);
  if (joined) return `${prefix}${joined}`;
  if (prefix) return prefix;
  return '.';
}
