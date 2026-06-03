/**
 * Canonical session summary template.
 *
 * 10 sections: 8 ported from claudy's session memory template
 * (services/SessionMemory/prompts.ts), with the two coding-centric sections
 * ("Files and Functions", "Codebase and System Documentation") replaced by
 * "Pages Visited" and "Forms Filled / Interactions Performed" since BrowserX
 * sessions are browser-automation, not code editing.
 *
 * The extractor sub-agent rewrites this file in place each extraction.
 * Italic placeholders are TEMPLATE INSTRUCTIONS that must be preserved.
 */

export const SESSION_SUMMARY_TEMPLATE = `# Session Title
_A short, distinctive 5–10 word descriptive title for the session. Info-dense, no filler._

# Pages Visited
_URLs the agent navigated to during this session._

# Forms Filled / Interactions Performed
_Form submissions, clicks, keyboard inputs of note._

# Current State
_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._

# Task Specification
_What did the user ask to accomplish? Any design decisions or constraints._

# Workflow
_Steps taken, approach used, multi-step automation patterns._

# Errors & Corrections
_Errors encountered and how they were fixed. What did the user correct? What approaches failed and should not be tried again?_

# Learnings
_What has worked well? What has not? What to avoid? Do not duplicate items from other sections._

# Key Results
_If the user asked for a specific output (an answer, a table, exported data, a screenshot), repeat the exact result here._

# Worklog
_Step by step, what was attempted/done. Very terse summary for each step._
`;
