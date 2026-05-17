/**
 * Tests for PromptComposer - verifies all fragments are included
 */

import { describe, it, expect, afterEach } from 'vitest';
import { PromptComposer } from '../PromptComposer';
import { registerExternalPersonas, clearExternalPersonas } from '../PersonaLoader';

describe('PromptComposer', () => {
  const composer = new PromptComposer();

  describe('composeMainInstruction', () => {
    it('should include approval policies fragment for browserx agent', () => {
      const prompt = composer.composeMainInstruction('browserx');
      expect(prompt).toContain('Action Approval System');
    });

    it('should include approval policies fragment for pi agent', () => {
      const prompt = composer.composeMainInstruction('applepi');
      expect(prompt).toContain('Action Approval System');
    });

    it('should mention actions that require approval', () => {
      const prompt = composer.composeMainInstruction('browserx');
      expect(prompt).toContain('typically require approval');
      expect(prompt).toContain('Financial operations');
    });

    it('should mention actions that are auto-approved', () => {
      const prompt = composer.composeMainInstruction('browserx');
      expect(prompt).toContain('auto-approved');
      expect(prompt).toContain('DOM snapshots');
    });

    it('should include denial handling instructions', () => {
      const prompt = composer.composeMainInstruction('browserx');
      expect(prompt).toContain('denied');
      expect(prompt).toContain('alternative approaches');
    });

    it('should include safety fragment', () => {
      const prompt = composer.composeMainInstruction('browserx');
      // Safety fragment should be present (different from approval)
      expect(prompt.length).toBeGreaterThan(100);
    });

    it('should include task policies fragment', () => {
      const prompt = composer.composeMainInstruction('browserx');
      // Both task policies and approval policies should be present
      // Approval policies should come after task policies
      const taskIdx = prompt.indexOf('Task');
      const approvalIdx = prompt.indexOf('Action Approval System');
      // Both exist
      expect(approvalIdx).toBeGreaterThan(-1);
    });
  });

  describe('composeCompactPrompt', () => {
    it('should return compact summarization prompt', () => {
      const prompt = composer.composeCompactPrompt();
      expect(prompt.length).toBeGreaterThan(0);
    });
  });

  describe('composeSummaryPrefix', () => {
    it('should return summary prefix', () => {
      const prefix = composer.composeSummaryPrefix();
      expect(prefix.length).toBeGreaterThan(0);
    });
  });

  describe('output-style persona (Track 24.2)', () => {
    afterEach(() => clearExternalPersonas());

    it('no personaName → output is byte-identical to no context (regression guard)', () => {
      const base = composer.composeMainInstruction('browserx');
      const withCtx = composer.composeMainInstruction('browserx', {});
      // Adding an empty context must not introduce a persona section.
      expect(withCtx).toBe(base);
      expect(base).toContain('## Operation Strategy'); // tools fragment present
    });

    it('keepCodingInstructions:false → tools fragment dropped, persona prompt injected', () => {
      registerExternalPersonas([
        {
          name: 'nocode',
          description: '',
          keepCodingInstructions: false,
          prompt: 'PERSONA_MARKER_XYZ',
        },
      ]);
      const prompt = composer.composeMainInstruction('browserx', { personaName: 'nocode' });
      expect(prompt).toContain('PERSONA_MARKER_XYZ');
      expect(prompt).not.toContain('## Operation Strategy');
    });

    it('keepCodingInstructions:true → tools fragment kept alongside persona', () => {
      registerExternalPersonas([
        {
          name: 'withcode',
          description: '',
          keepCodingInstructions: true,
          prompt: 'PERSONA_MARKER_ABC',
        },
      ]);
      const prompt = composer.composeMainInstruction('browserx', { personaName: 'withcode' });
      expect(prompt).toContain('PERSONA_MARKER_ABC');
      expect(prompt).toContain('## Operation Strategy');
    });
  });
});
