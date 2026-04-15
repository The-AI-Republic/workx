// File: src/core/subagent/builtinTypes.ts

import type { SubAgentTypeConfig } from './types';

export const BUILTIN_SUBAGENT_TYPES: SubAgentTypeConfig[] = [
  {
    id: 'researcher',
    name: 'Researcher',
    description: 'Fast read-only agent for exploring the codebase, searching files, reading documentation, and gathering information. Use when you need to find or understand something before acting.',
    systemPrompt: `You are a research assistant. Your job is to find information, read files, search code, and report back concisely.

Rules:
- Focus on gathering facts, not making changes
- Be thorough but concise in your findings
- Report file paths and line numbers when referencing code
- If you can't find what you're looking for, say so clearly`,
    tools: {
      deny: ['browser_dom', 'browser_navigate', 'browser_screenshot', 'exec_command', 'sub_agent'],
    },
    maxTurns: 15,
    approvalPolicy: 'never',
    suppressedEvents: ['AgentMessageDelta', 'AgentReasoningDelta'],
  },
  {
    id: 'planner',
    name: 'Planner',
    description: 'Agent for analyzing requirements and creating implementation plans. Use when you need to break down a complex task into steps before executing.',
    systemPrompt: `You are a planning assistant. Analyze the task, identify the files and components involved, and create a clear step-by-step plan.

Rules:
- Read relevant code before planning
- Identify dependencies between steps
- Note potential risks or edge cases
- Keep plans actionable and concrete`,
    tools: {
      deny: ['browser_dom', 'browser_navigate', 'exec_command', 'sub_agent'],
    },
    maxTurns: 20,
    approvalPolicy: 'never',
    suppressedEvents: ['AgentMessageDelta', 'AgentReasoningDelta'],
  },
  {
    id: 'worker',
    name: 'Worker',
    description: 'General-purpose agent that can read, write, and execute. Use for independent sub-tasks that can be fully described in the prompt without needing back-and-forth.',
    systemPrompt: `You are a task executor. Complete the assigned task efficiently and report what you did.

Rules:
- Do exactly what is asked, no more
- Report what you changed and why
- If you encounter an unexpected situation, describe it clearly`,
    tools: {
      deny: ['sub_agent'],
    },
    maxTurns: 25,
    approvalPolicy: 'inherit',
    suppressedEvents: ['AgentMessageDelta'],
  },
];
