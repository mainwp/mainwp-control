/**
 * Tests for ContextWindow truncation boundary logic.
 *
 * The critical invariant: a cut is only safe immediately before a `user`
 * message. Cutting mid tool-exchange orphans a `tool` result from its
 * assistant tool call, which providers reject on the next call.
 */

import { describe, it, expect } from 'vitest';
import { ContextWindow } from './context-window.js';
import type { Message } from './providers/provider.js';

const system: Message = { role: 'system', content: 'system prompt' };
const user = (content: string): Message => ({ role: 'user', content });
const assistant = (content: string): Message => ({ role: 'assistant', content });
const tool = (name: string): Message => ({
  role: 'tool',
  content: '{"ok":true}',
  toolCallId: `call_${name}`,
  toolName: name,
});

describe('ContextWindow', () => {
  describe('shouldTruncate', () => {
    it('returns false when no limit is configured', () => {
      const window = new ContextWindow(undefined);
      expect(window.shouldTruncate([system, user('a'), assistant('b')])).toBe(false);
    });

    it('returns false when limit is 0 (explicit unlimited)', () => {
      const window = new ContextWindow(0);
      expect(window.shouldTruncate([system, user('a'), assistant('b')])).toBe(false);
    });

    it('rejects a negative limit', () => {
      expect(() => new ContextWindow(-5)).toThrow(
        'maxMessages must be non-negative'
      );
    });

    it('returns false while within the limit', () => {
      const window = new ContextWindow(2);
      expect(window.shouldTruncate([system, user('a'), assistant('b')])).toBe(false);
    });

    it('returns true when message count (excluding system) exceeds the limit', () => {
      const window = new ContextWindow(2);
      expect(
        window.shouldTruncate([system, user('a'), assistant('b'), user('c')])
      ).toBe(true);
    });
  });

  describe('truncate', () => {
    it('returns the original array unchanged when within the limit', () => {
      const window = new ContextWindow(5);
      const messages = [system, user('a'), assistant('b')];
      expect(window.truncate(messages)).toBe(messages);
    });

    it('cuts at a user boundary and always keeps the system prompt', () => {
      const window = new ContextWindow(2);
      const messages = [system, user('m1'), assistant('r1'), user('m2'), assistant('r2')];

      const result = window.truncate(messages);

      expect(result[0]).toBe(system);
      expect(result[1]!.role).toBe('user');
      expect(result[1]!.content).toBe('m2');
      expect(result).toHaveLength(3);
    });

    it('never orphans a tool result mid tool-calling loop (skips instead)', () => {
      // Mid tool-loop overflow: only assistant/tool messages after the ideal
      // cut point. The old fallback cut here and orphaned tool results.
      const window = new ContextWindow(4);
      const messages = [
        system,
        user('list sites'),
        assistant('tc1'),
        tool('list-sites-v1'),
        assistant('tc2'),
        tool('list-sites-v1'),
      ];

      const result = window.truncate(messages);

      // No safe boundary exists — truncation is deferred, not forced
      expect(result).toBe(messages);
    });

    it('catches up at the next user boundary after a deferred cycle', () => {
      const window = new ContextWindow(4);
      const messages = [
        system,
        user('list sites'),
        assistant('tc1'),
        tool('list-sites-v1'),
        assistant('tc2'),
        tool('list-sites-v1'),
        assistant('answer'),
        user('thanks'),
      ];

      const result = window.truncate(messages);

      expect(result[0]).toBe(system);
      // The only user boundary at/after the ideal cut is the final message
      expect(result).toEqual([system, user('thanks')]);
      // Pairing integrity holds: no tool message without its assistant
      for (let i = 1; i < result.length; i++) {
        if (result[i]!.role === 'tool') {
          expect(result[i - 1]!.role).toBe('assistant');
        }
      }
    });

    it('keeps a complete tool exchange when the cut lands before its user turn', () => {
      const window = new ContextWindow(4);
      const messages = [
        system,
        user('old'),
        assistant('old reply'),
        user('list sites'),
        assistant('tc1'),
        tool('list-sites-v1'),
        assistant('answer'),
      ];

      const result = window.truncate(messages);

      expect(result).toEqual([
        system,
        user('list sites'),
        assistant('tc1'),
        tool('list-sites-v1'),
        assistant('answer'),
      ]);
    });

    it('handles an empty history without throwing', () => {
      const window = new ContextWindow(2);
      const messages: Message[] = [];
      expect(window.truncate(messages)).toBe(messages);
    });

    // Regression: ChatEngine injects a synthetic `User approved: yes` user
    // message between an assistant tool-call and its confirm result. Treating
    // that as a real turn boundary would cut there and orphan the tool result.
    it('does not cut at the synthetic approval message (defers instead)', () => {
      const window = new ContextWindow(3);
      const messages = [
        system,
        user('delete site 1'),
        assistant('tc-delete'),
        user('User approved: yes'),
        tool('delete-site-v1'),
      ];

      // Only boundary at/after the ideal cut is the synthetic approval, whose
      // next message is a tool result — not a real turn start, so defer.
      expect(window.truncate(messages)).toBe(messages);
    });

    it('catches up cleanly at the next real user turn after an approval', () => {
      const window = new ContextWindow(3);
      const messages = [
        system,
        user('delete site 1'),
        assistant('tc-delete'),
        user('User approved: yes'),
        tool('delete-site-v1'),
        assistant('done'),
        user('next question'),
      ];

      const result = window.truncate(messages);

      expect(result).toEqual([system, user('next question')]);
      // No orphaned tool result
      for (let i = 1; i < result.length; i++) {
        if (result[i]!.role === 'tool') {
          expect(result[i - 1]!.role).toBe('assistant');
        }
      }
    });
  });
});
