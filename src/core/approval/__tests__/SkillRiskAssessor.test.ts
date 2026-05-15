import { describe, it, expect } from 'vitest';
import { SkillRiskAssessor } from '@/core/approval/assessors/SkillRiskAssessor';
import { RiskLevel } from '@/core/approval/types';

const catalog = (skills: Array<{ name: string; trusted: boolean; disableModelInvocation?: boolean }>) => ({
  getAllSkillMetas: () => skills,
});

describe('SkillRiskAssessor', () => {
  it('trusted skill → score 0 (auto_approve)', () => {
    const assessor = new SkillRiskAssessor(catalog([{ name: 'deploy', trusted: true }]));
    const r = assessor.assess('use_skill', { name: 'deploy' });
    expect(r.score).toBe(0);
    expect(r.level).toBe(RiskLevel.None);
    expect(r.action).toBe('auto_approve');
  });

  it('untrusted skill → score 50 (ask_user)', () => {
    const assessor = new SkillRiskAssessor(catalog([{ name: 'deploy', trusted: false }]));
    const r = assessor.assess('use_skill', { name: 'deploy' });
    expect(r.score).toBe(50);
    expect(r.level).toBe(RiskLevel.Medium);
    expect(r.action).toBe('ask_user');
  });

  it('unknown skill → score 100 (deny)', () => {
    const assessor = new SkillRiskAssessor(catalog([{ name: 'deploy', trusted: true }]));
    const r = assessor.assess('use_skill', { name: 'missing' });
    expect(r.score).toBe(100);
    expect(r.level).toBe(RiskLevel.Critical);
    expect(r.action).toBe('deny');
  });

  it('disable-model-invocation overrides trust → score 100', () => {
    const assessor = new SkillRiskAssessor(catalog([
      { name: 'admin-only', trusted: true, disableModelInvocation: true },
    ]));
    const r = assessor.assess('use_skill', { name: 'admin-only' });
    expect(r.score).toBe(100);
    expect(r.action).toBe('deny');
    expect(r.factors.some((f) => f.includes('disable-model-invocation'))).toBe(true);
  });

  it('missing or non-string `name` parameter → score 100', () => {
    const assessor = new SkillRiskAssessor(catalog([{ name: 'deploy', trusted: true }]));
    expect(assessor.assess('use_skill', {}).score).toBe(100);
    expect(assessor.assess('use_skill', { name: 42 } as unknown as Record<string, unknown>).score).toBe(100);
  });

  it('factors include the tool name', () => {
    const assessor = new SkillRiskAssessor(catalog([{ name: 'deploy', trusted: true }]));
    const r = assessor.assess('use_skill', { name: 'deploy' });
    expect(r.factors.some((f) => f.includes('use_skill'))).toBe(true);
  });
});
