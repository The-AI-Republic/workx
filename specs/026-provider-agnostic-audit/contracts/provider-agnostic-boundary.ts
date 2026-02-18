/**
 * Provider-Agnostic Architectural Boundary Contract
 *
 * This contract defines the rules enforced by architectural guard-rail tests.
 * Implementation: src/core/models/__tests__/provider-agnostic.architecture.test.ts
 */

// --- Rule 1: ResponseItem Import Boundary ---
// The ResponseItem type definition file (src/core/protocol/types.ts) MUST NOT
// import from any provider SDK. Verified by scanning import statements.
//
// Banned import patterns in types.ts:
//   - 'openai'
//   - '@google/genai'
//   - 'groq'
//   - '@anthropic-ai/sdk'
//   - 'fireworks'
//   - 'together'

// --- Rule 2: Shared Component Isolation ---
// Non-client files that import ResponseItem MUST NOT contain provider-specific
// branching or imports. Verified by scanning for provider SDK imports and
// provider name string checks.
//
// Files subject to this rule (non-exhaustive, dynamically discovered):
//   - src/core/events/EventMapping.ts
//   - src/core/models/PromptHelpers.ts
//   - src/core/compact/CompactService.ts
//   - src/core/TurnManager.ts
//   - src/core/session/state/SessionState.ts
//   - src/core/session/state/SnapshotCompressor.ts
//   - src/core/TaskRunner.ts
//   - src/core/AgentTask.ts
//   - src/core/title/TitleGenerator.ts
//   - src/storage/rollout/*.ts
//   - src/core/models/types/ResponseEvent.ts
//   - src/core/models/types/ResponsesAPI.ts

// --- Rule 3: Client Conversion Containment ---
// Only files within src/core/models/client/ are permitted to import provider SDKs.
// All other source files must be provider-agnostic.
//
// Allowed provider SDK imports (client/ directory only):
//   - import OpenAI from 'openai'
//   - import { GoogleGenAI } from '@google/genai'

// --- Rule 4: ResponseItem Field Neutrality ---
// All fields on ResponseItem variants must use generic names.
// No field name should contain a provider name prefix/suffix.
//
// Acceptable: role, content, tool_calls, arguments, call_id, thoughtSignature
// Unacceptable: openai_id, gemini_content, groq_reasoning

export interface ProviderAgnosticBoundary {
  /** Provider SDK import patterns that are banned outside of client/ directory */
  readonly bannedImportPatterns: readonly string[];

  /** Directory where provider-specific imports are allowed */
  readonly allowedProviderDir: string;

  /** The ResponseItem type definition file that must remain clean */
  readonly responseItemDefinitionFile: string;
}

export const BOUNDARY_RULES: ProviderAgnosticBoundary = {
  bannedImportPatterns: [
    'openai',
    '@google/genai',
    '@anthropic-ai/sdk',
    'groq-sdk',
    'fireworks',
    'together-ai',
  ],
  allowedProviderDir: 'src/core/models/client/',
  responseItemDefinitionFile: 'src/core/protocol/types.ts',
};
