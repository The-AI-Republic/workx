/**
 * FileWriteRiskAssessor — design §4.8 layer 2.
 *
 * Pins the user-facing approval guarantee for code-mode file mutation:
 *  - edit_file/write_file score > 30 ⇒ ask_user (NOT silently auto-approved),
 *    and that mapping holds independent of tool params/context.
 *  - read_file/grep/glob stay StaticRiskAssessor(0) ⇒ auto_approve.
 * Without this, a refactor could drop the assessor or attach it to the
 * read-only tools and nothing would fail.
 */

import { describe, it, expect } from 'vitest';
import { FileWriteRiskAssessor } from '../FileWriteRiskAssessor';
import { StaticRiskAssessor } from '../StaticRiskAssessor';
import { RiskLevel } from '../../types';
import { ReadFileTool, EditFileTool, WriteFileTool } from '../../../../tools/file-search/FileAccessTool';
import { GrepTool } from '../../../../tools/file-search/GrepTool';
import { GlobTool } from '../../../../tools/file-search/GlobTool';

describe('FileWriteRiskAssessor', () => {
  const a = new FileWriteRiskAssessor();

  for (const tool of ['edit_file', 'write_file']) {
    it(`${tool} → score 45, Medium, ask_user`, () => {
      const r = a.assess(tool, {});
      expect(r.score).toBe(45);
      expect(r.score).toBeGreaterThan(30); // > the riskAbove:30 ASK threshold
      expect(r.level).toBe(RiskLevel.Medium);
      expect(r.action).toBe('ask_user');
      expect(r.factors.join(' ')).toContain(tool);
    });
  }

  it('decision is invariant to parameters and context', () => {
    const huge = a.assess('write_file', { content: 'x'.repeat(10_000), path: '/etc/passwd' });
    expect(huge.action).toBe('ask_user');
    expect(huge.score).toBe(45);
  });
});

describe('file-tool risk-assessor wiring', () => {
  it('edit_file/write_file carry FileWriteRiskAssessor', () => {
    expect(new EditFileTool().riskAssessor).toBeInstanceOf(FileWriteRiskAssessor);
    expect(new WriteFileTool().riskAssessor).toBeInstanceOf(FileWriteRiskAssessor);
  });

  it('read_file/grep/glob are read-only StaticRiskAssessor(0) → auto_approve', () => {
    for (const [name, assessor] of [
      ['read_file', new ReadFileTool().riskAssessor],
      ['grep', new GrepTool().riskAssessor],
      ['glob', new GlobTool().riskAssessor],
    ] as const) {
      expect(assessor).toBeInstanceOf(StaticRiskAssessor);
      const r = assessor.assess(name, {});
      expect(r.score).toBe(0);
      expect(r.action).toBe('auto_approve');
    }
  });
});
