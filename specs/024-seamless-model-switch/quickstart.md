# Quickstart: Seamless Model Switch

**Date**: 2026-02-17
**Feature**: 024-seamless-model-switch

## What Changed

Model switching no longer clears conversation history. When you
switch models (or providers), your conversation continues
seamlessly with the new model having full context of prior messages.

## How to Test

### Test 1: Basic Model Switch (US1)

1. Open BrowserX sidepanel
2. Start a conversation — send a message and get a response
3. Open Settings → Model Settings
4. Switch to a different model
5. Send a follow-up message referencing the prior conversation

**Expected**: The new model responds with awareness of the prior
messages. No "conversation cleared" warning appears.

### Test 2: Mid-Task Switch (US2)

1. Send a complex task (e.g., "read this page and summarize it")
2. While the agent is still processing (spinner visible), open
   Settings and switch models
3. Wait for the current task to complete
4. Send a new message

**Expected**: The running task completes normally with the original
model. The new message uses the newly selected model.

### Test 3: Model Indicator (US3)

1. Start a conversation with Model A
2. Get a response
3. Switch to Model B
4. Send another message and get a response
5. Look at both responses in the chat

**Expected**: Each assistant response shows a small label
indicating which model generated it.

### Test 4: Cross-Provider Switch

1. Start a conversation using an OpenAI model
2. Switch to a Google Gemini model
3. Send a follow-up referencing prior context

**Expected**: Gemini responds with full context awareness. Tool
call history from OpenAI is correctly translated.

## Rollback

If issues arise, the change can be reverted by restoring the
original `handleModelConfigChange()` method in BrowserxAgent.ts
(re-adding `session.clearHistory()` and new TurnContext creation).
