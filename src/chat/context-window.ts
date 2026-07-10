/**
 * Context window management for chat message history.
 *
 * Extracted from ChatEngine so the truncation boundary logic is unit-testable
 * without constructing a full engine.
 */

import type { Message } from './providers/provider.js';

/**
 * Sliding-window truncation over a message history.
 *
 * INVARIANT: A cut is only safe immediately before a `user` message.
 * Cutting anywhere else can orphan a `tool` result from its preceding
 * assistant tool call, which providers reject on the next call (Anthropic
 * returns 400 for a tool_result with no matching tool_use; OpenAI-compatible
 * APIs reject unmatched tool_call_ids).
 */
export class ContextWindow {
  /**
   * @param maxMessages - Maximum messages to keep (excluding system prompt).
   *   undefined or 0 = unlimited.
   */
  constructor(private readonly maxMessages: number | undefined) {}

  /**
   * Check if the history exceeds the configured limit.
   */
  shouldTruncate(messages: Message[]): boolean {
    if (this.maxMessages === undefined || this.maxMessages <= 0) {
      return false; // No limit configured or explicitly unlimited
    }
    return messages.length - 1 > this.maxMessages;
  }

  /**
   * Truncate history using a sliding window approach. Preserves:
   * - System prompt (always first message)
   * - Complete exchanges (user-assistant, tool call-result pairs), by only
   *   cutting immediately before a `user` message
   *
   * If no safe boundary exists at or after the ideal cut point (mid
   * tool-calling loop, when only assistant/tool messages follow), truncation
   * is skipped for this cycle rather than making an unsafe cut — the next
   * user turn provides a safe boundary and the window catches up then.
   *
   * @returns A new truncated array, or the original array unchanged when no
   *   truncation occurs.
   */
  truncate(messages: Message[]): Message[] {
    if (!this.shouldTruncate(messages)) {
      return messages;
    }

    const systemPrompt = messages[0];
    if (!systemPrompt) {
      return messages;
    }

    const cutIndex = this.findSafeCut(messages);
    if (cutIndex === null) {
      return messages;
    }

    const truncated = [systemPrompt, ...messages.slice(cutIndex)];

    if (process.env['DEBUG']) {
      console.debug(
        `[ContextWindow] Truncated ${messages.length - truncated.length} messages (${messages.length - 1} -> ${truncated.length - 1})`
      );
    }

    return truncated;
  }

  /**
   * Find the first safe cut index at or after the ideal cut point.
   *
   * @returns Index of the first `user` message at or after the ideal cut
   *   point (never 0, the system prompt), or null when none exists.
   */
  private findSafeCut(messages: Message[]): number | null {
    // shouldTruncate() guarantees maxMessages is a positive number here
    const idealCut = messages.length - (this.maxMessages as number);

    for (let i = Math.max(1, idealCut); i < messages.length; i++) {
      if (messages[i]?.role === 'user') {
        return i;
      }
    }

    return null;
  }
}
