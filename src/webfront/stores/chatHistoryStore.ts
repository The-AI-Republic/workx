/**
 * Chat history store.
 *
 * Bridges the left-panel "Chat History" section (rendered in `AppShell`,
 * outside the chat page) to the chat page (`pages/chat/Main.svelte`). The
 * section can't call the chat page's `resumeConversation` directly because
 * they are separate components mounted by the Router, so it publishes a
 * resume *request* here; the chat page subscribes and performs the resume.
 *
 * A monotonically increasing `nonce` lets the same conversation id be
 * requested repeatedly (e.g. re-selecting the conversation you're already in)
 * and lets the chat page distinguish a fresh request from a stale one.
 */

import { writable } from 'svelte/store';

export interface ResumeRequest {
  sessionId: string;
  nonce: number;
}

/**
 * Latest pending "resume this conversation" request, or `null` once handled.
 * The chat page clears it (via {@link clearResumeRequest}) after acting on it
 * so a remount of the chat page doesn't re-trigger a stale resume.
 */
export const resumeRequest = writable<ResumeRequest | null>(null);

let nonceCounter = 0;

/**
 * Ask the chat page to load (resume) the given conversation. Callers that are
 * not already on the chat route should navigate there (e.g. `push('/')`) so
 * the chat page mounts and picks up the request.
 */
export function requestResumeConversation(sessionId: string): void {
  nonceCounter += 1;
  resumeRequest.set({ sessionId, nonce: nonceCounter });
}

/** Acknowledge and drop the current request. Called by the chat page. */
export function clearResumeRequest(): void {
  resumeRequest.set(null);
}
