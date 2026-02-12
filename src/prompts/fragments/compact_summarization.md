You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

CRITICAL - Cache Storage Keys:
If cache_storage_tool was used during this conversation, you MUST preserve ALL storageKey values and their descriptions exactly as returned from write/update actions. These keys are required to retrieve cached data later. Format as:
  - storageKey: "<exact_key>" - <description>
Without these keys, cached data becomes permanently inaccessible.

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.
