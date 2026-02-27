/**
 * Unit tests for PlanningTool (simplified V2)
 *
 * Tests validation, success responses, step counting, and Chrome runtime messaging.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PlanningTool, PLANNING_TOOL_DEFINITION } from '../PlanningTool';

// Mock the StepStatus enum from the events module
vi.mock('../../core/protocol/events', () => ({
  StepStatus: {
    Pending: 'Pending',
    InProgress: 'InProgress',
    Completed: 'Completed',
  },
}));

// Set up global chrome mock before tests
(global as any).chrome = {
  runtime: {
    sendMessage: vi.fn().mockResolvedValue(undefined),
  },
};

describe('PlanningTool', () => {
  let tool: PlanningTool;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new PlanningTool();
  });

  // ── Tool definition ─────────────────────────────────────────────────

  describe('PLANNING_TOOL_DEFINITION', () => {
    it('has the correct name', () => {
      expect(PLANNING_TOOL_DEFINITION.name).toBe('planning_tool');
    });

    it('has a non-empty description', () => {
      expect(PLANNING_TOOL_DEFINITION.description).toBeTruthy();
      expect(typeof PLANNING_TOOL_DEFINITION.description).toBe('string');
    });

    it('has an inputSchema with type object', () => {
      expect(PLANNING_TOOL_DEFINITION.inputSchema).toBeDefined();
      expect(PLANNING_TOOL_DEFINITION.inputSchema.type).toBe('object');
    });

    it('requires the plan parameter', () => {
      expect(PLANNING_TOOL_DEFINITION.inputSchema.required).toContain('plan');
    });

    it('defines explanation as a string property', () => {
      const props = PLANNING_TOOL_DEFINITION.inputSchema.properties;
      expect(props.explanation).toBeDefined();
      expect(props.explanation.type).toBe('string');
    });

    it('defines plan as an array property with object items', () => {
      const props = PLANNING_TOOL_DEFINITION.inputSchema.properties;
      expect(props.plan).toBeDefined();
      expect(props.plan.type).toBe('array');
      expect(props.plan.items).toBeDefined();
      expect(props.plan.items.type).toBe('object');
    });

    it('plan items require step and status fields', () => {
      const items = PLANNING_TOOL_DEFINITION.inputSchema.properties.plan.items;
      expect(items.required).toEqual(expect.arrayContaining(['step', 'status']));
    });

    it('status enum includes Pending, InProgress, Completed', () => {
      const statusProp =
        PLANNING_TOOL_DEFINITION.inputSchema.properties.plan.items.properties.status;
      expect(statusProp.enum).toEqual(['Pending', 'InProgress', 'Completed']);
    });
  });

  // ── getDefinition() ─────────────────────────────────────────────────

  describe('getDefinition()', () => {
    it('returns a tool definition with type function', () => {
      const def = tool.getDefinition();
      expect(def.type).toBe('function');
    });

    it('includes the correct function name', () => {
      const def = tool.getDefinition();
      if (def.type === 'function') {
        expect(def.function.name).toBe('planning_tool');
      }
    });

    it('includes metadata with capabilities', () => {
      const def = tool.getDefinition();
      if (def.type === 'function') {
        expect(def.metadata).toBeDefined();
        expect(def.metadata!.capabilities).toContain('task_planning');
        expect(def.metadata!.capabilities).toContain('progress_tracking');
      }
    });

    it('has category and version', () => {
      const def = tool.getDefinition() as any;
      expect(def.category).toBe('planning');
      expect(def.version).toBe('1.0.0');
    });
  });

  // ── execute() with valid plan (all Pending) ─────────────────────────

  describe('execute() with valid plan (all Pending)', () => {
    it('returns success with correct step count', async () => {
      const result = await tool.execute({
        plan: [
          { step: 'Step one', status: 'Pending' },
          { step: 'Step two', status: 'Pending' },
          { step: 'Step three', status: 'Pending' },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data.success).toBe(true);
      expect(result.data.stepCount).toBe(3);
    });

    it('reports all steps as pending', async () => {
      const result = await tool.execute({
        plan: [
          { step: 'Step one', status: 'Pending' },
          { step: 'Step two', status: 'Pending' },
        ],
      });

      expect(result.data.pendingCount).toBe(2);
      expect(result.data.completedCount).toBe(0);
      expect(result.data.inProgressStep).toBeNull();
    });

    it('includes a message with the step count', async () => {
      const result = await tool.execute({
        plan: [{ step: 'Only step', status: 'Pending' }],
      });

      expect(result.data.message).toContain('1 steps');
    });
  });

  // ── execute() with mixed statuses ───────────────────────────────────

  describe('execute() with mixed statuses', () => {
    it('correctly counts completed, pending, and in-progress steps', async () => {
      const result = await tool.execute({
        plan: [
          { step: 'Completed step', status: 'Completed' },
          { step: 'In-progress step', status: 'InProgress' },
          { step: 'Pending step 1', status: 'Pending' },
          { step: 'Pending step 2', status: 'Pending' },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.data.stepCount).toBe(4);
      expect(result.data.completedCount).toBe(1);
      expect(result.data.pendingCount).toBe(2);
      expect(result.data.inProgressStep).toBe('In-progress step');
    });

    it('returns null for inProgressStep when no step is InProgress', async () => {
      const result = await tool.execute({
        plan: [
          { step: 'Done', status: 'Completed' },
          { step: 'Waiting', status: 'Pending' },
        ],
      });

      expect(result.data.inProgressStep).toBeNull();
    });

    it('returns the first InProgress step when multiple exist', async () => {
      const result = await tool.execute({
        plan: [
          { step: 'First active', status: 'InProgress' },
          { step: 'Second active', status: 'InProgress' },
        ],
      });

      expect(result.data.inProgressStep).toBe('First active');
    });
  });

  // ── execute() with explanation ──────────────────────────────────────

  describe('execute() with explanation', () => {
    it('includes explanation text in the message', async () => {
      const result = await tool.execute({
        explanation: 'Starting the migration process',
        plan: [
          { step: 'Backup database', status: 'Pending' },
          { step: 'Run migrations', status: 'Pending' },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.data.message).toContain('Starting the migration process');
      expect(result.data.message).toMatch(/^Plan updated:/);
    });

    it('uses step count message when no explanation provided', async () => {
      const result = await tool.execute({
        plan: [{ step: 'Do something', status: 'Pending' }],
      });

      expect(result.data.message).toContain('1 steps');
      expect(result.data.message).not.toContain('undefined');
    });
  });

  // ── execute() with invalid plan ─────────────────────────────────────

  describe('execute() with invalid plan (not an array)', () => {
    it('returns validation error when plan is a string', async () => {
      const result = await tool.execute({
        plan: 'not an array',
      });

      expect(result.success).toBe(false);
    });

    it('returns validation error when plan is an object', async () => {
      const result = await tool.execute({
        plan: { step: 'test', status: 'Pending' },
      });

      expect(result.success).toBe(false);
    });

    it('returns validation error when plan is null', async () => {
      const result = await tool.execute({
        plan: null,
      });

      expect(result.success).toBe(false);
    });

    it('returns validation error when plan is missing', async () => {
      const result = await tool.execute({});

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  // ── execute() with empty step string ────────────────────────────────

  describe('execute() with empty step string', () => {
    it('returns VALIDATION_ERROR for an empty step string', async () => {
      const result = await tool.execute({
        plan: [{ step: '', status: 'Pending' }],
      });

      expect(result.success).toBe(true); // BaseTool wraps the result
      expect(result.data.success).toBe(false);
      expect(result.data.errorType).toBe('VALIDATION_ERROR');
      expect(result.data.error).toContain('index 0');
      expect(result.data.error).toContain('non-empty step string');
    });

    it('identifies the correct index for the invalid step', async () => {
      const result = await tool.execute({
        plan: [
          { step: 'Valid step', status: 'Pending' },
          { step: '', status: 'InProgress' },
        ],
      });

      expect(result.data.success).toBe(false);
      expect(result.data.error).toContain('index 1');
    });
  });

  // ── execute() with invalid status ───────────────────────────────────

  describe('execute() with invalid status', () => {
    it('returns VALIDATION_ERROR for an unknown status string', async () => {
      const result = await tool.execute({
        plan: [{ step: 'A step', status: 'Unknown' }],
      });

      expect(result.success).toBe(true); // BaseTool wraps the result
      expect(result.data.success).toBe(false);
      expect(result.data.errorType).toBe('VALIDATION_ERROR');
      expect(result.data.error).toContain("Invalid status 'Unknown'");
      expect(result.data.error).toContain('index 0');
    });

    it('returns error for empty status', async () => {
      const result = await tool.execute({
        plan: [{ step: 'A step', status: '' }],
      });

      expect(result.data.success).toBe(false);
      expect(result.data.errorType).toBe('VALIDATION_ERROR');
    });

    it('returns error for lowercase status', async () => {
      const result = await tool.execute({
        plan: [{ step: 'A step', status: 'pending' }],
      });

      expect(result.data.success).toBe(false);
      expect(result.data.error).toContain("Invalid status 'pending'");
    });
  });

  // ── execute() counts verification ───────────────────────────────────

  describe('execute() counts', () => {
    it('correctly counts with all Completed steps', async () => {
      const result = await tool.execute({
        plan: [
          { step: 'Step A', status: 'Completed' },
          { step: 'Step B', status: 'Completed' },
          { step: 'Step C', status: 'Completed' },
        ],
      });

      expect(result.data.completedCount).toBe(3);
      expect(result.data.pendingCount).toBe(0);
      expect(result.data.inProgressStep).toBeNull();
      expect(result.data.stepCount).toBe(3);
    });

    it('correctly counts with empty plan', async () => {
      const result = await tool.execute({
        plan: [],
      });

      expect(result.success).toBe(true);
      expect(result.data.stepCount).toBe(0);
      expect(result.data.completedCount).toBe(0);
      expect(result.data.pendingCount).toBe(0);
      expect(result.data.inProgressStep).toBeNull();
    });

    it('correctly counts a realistic multi-status plan', async () => {
      const result = await tool.execute({
        plan: [
          { step: 'Setup environment', status: 'Completed' },
          { step: 'Install dependencies', status: 'Completed' },
          { step: 'Run tests', status: 'InProgress' },
          { step: 'Deploy to staging', status: 'Pending' },
          { step: 'Deploy to production', status: 'Pending' },
        ],
      });

      expect(result.data.stepCount).toBe(5);
      expect(result.data.completedCount).toBe(2);
      expect(result.data.pendingCount).toBe(2);
      expect(result.data.inProgressStep).toBe('Run tests');
    });
  });

  // ── Chrome messaging ────────────────────────────────────────────────

  describe('_planArgs in result (for TurnManager event emission)', () => {
    it('returns _planArgs in result data for valid plans', async () => {
      const planRequest = {
        plan: [{ step: 'Test step', status: 'Pending' }],
      };

      const result = await tool.execute(planRequest);

      expect(result.data._planArgs).toEqual(planRequest);
    });

    it('does not return _planArgs when plan validation fails (empty step)', async () => {
      const result = await tool.execute({
        plan: [{ step: '', status: 'Pending' }],
      });

      expect(result.data._planArgs).toBeUndefined();
    });

    it('does not return _planArgs when plan validation fails (invalid status)', async () => {
      const result = await tool.execute({
        plan: [{ step: 'A step', status: 'BadStatus' }],
      });

      expect(result.data._planArgs).toBeUndefined();
    });

    it('does not call chrome.runtime.sendMessage (event emission moved to TurnManager)', async () => {
      await tool.execute({
        plan: [{ step: 'Step', status: 'Pending' }],
      });

      expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    });

    it('includes explanation in _planArgs when provided', async () => {
      const planRequest = {
        explanation: 'Initial plan',
        plan: [{ step: 'First step', status: 'Pending' }],
      };

      const result = await tool.execute(planRequest);

      expect(result.data._planArgs.explanation).toBe('Initial plan');
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles a single-step plan', async () => {
      const result = await tool.execute({
        plan: [{ step: 'Only step', status: 'InProgress' }],
      });

      expect(result.success).toBe(true);
      expect(result.data.stepCount).toBe(1);
      expect(result.data.inProgressStep).toBe('Only step');
      expect(result.data.completedCount).toBe(0);
      expect(result.data.pendingCount).toBe(0);
    });

    it('handles step descriptions with special characters', async () => {
      const result = await tool.execute({
        plan: [
          { step: 'Upload file "report.csv" to /data/uploads', status: 'Pending' },
          { step: 'Run query: SELECT * FROM users WHERE active = true', status: 'Pending' },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.data.stepCount).toBe(2);
    });

    it('handles a large plan', async () => {
      const largePlan = Array.from({ length: 50 }, (_, i) => ({
        step: `Step ${i + 1}`,
        status: i < 20 ? 'Completed' : i < 25 ? 'InProgress' : 'Pending',
      }));

      const result = await tool.execute({ plan: largePlan });

      expect(result.success).toBe(true);
      expect(result.data.stepCount).toBe(50);
      expect(result.data.completedCount).toBe(20);
      expect(result.data.pendingCount).toBe(25);
      expect(result.data.inProgressStep).toBe('Step 21');
    });
  });
});
