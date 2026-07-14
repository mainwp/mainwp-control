/**
 * Tests for AnthropicProvider message conversion
 *
 * Audit-remainders item 4 (2026-07-13): the audit flagged that after a
 * declined destructive preview, chat-engine history holds a `tool` result
 * followed directly by a `user` message with no assistant turn between, and
 * convertMessages() maps the tool result to a `user`-role entry — so the
 * request body sent to /v1/messages contains two consecutive `user` entries.
 *
 * That is NOT a bug. The Messages API does not enforce strict role
 * alternation; per the API reference (platform.claude.com/docs/en/api/messages,
 * checked 2026-07-13): "Consecutive `user` or `assistant` turns in your
 * request will be combined into a single turn." Merging client-side is
 * therefore unnecessary, so convertMessages intentionally does not do it.
 * The test below pins the current wire shape so a future change to it is a
 * conscious decision rather than an accident.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Message } from './provider.js';

const mockMakeProviderRequest = vi.fn();

vi.mock('./provider-fetch.js', () => ({
  makeProviderRequest: (...args: unknown[]) => mockMakeProviderRequest(...args),
}));

const { createAnthropicProvider } = await import('./anthropic.js');

interface CapturedMessage {
  role: string;
  content: unknown;
}

function anthropicTextResponse(text: string) {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    model: 'claude-sonnet-4-6',
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

describe('AnthropicProvider.convertMessages (via chat)', () => {
  beforeEach(() => {
    mockMakeProviderRequest.mockReset();
    mockMakeProviderRequest.mockResolvedValue(anthropicTextResponse('ok'));
  });

  function createProvider() {
    return createAnthropicProvider({ apiKey: 'test-key' });
  }

  async function captureMessages(history: Message[]): Promise<CapturedMessage[]> {
    await createProvider().chat(history);
    const request = mockMakeProviderRequest.mock.calls[0]![0] as {
      body: { messages: CapturedMessage[] };
    };
    return request.body.messages;
  }

  it('sends consecutive user-role entries after a declined preview (API merges them)', async () => {
    // Decline-path history: assistant tool call → tool result → user decline echo
    const history: Message[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'delete site 7' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'call_1', name: 'delete-site-v1', arguments: { site_id: 7 } },
        ],
      },
      {
        role: 'tool',
        content: '{"declined":true}',
        toolCallId: 'call_1',
        toolName: 'delete-site-v1',
      },
      { role: 'user', content: 'User declined the action.' },
    ];

    const messages = await captureMessages(history);

    expect(messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user', // tool result converted to user role
      'user', // decline echo — consecutive user entries are valid; API merges
    ]);
  });

  it('keeps a normally alternating history unchanged', async () => {
    const history: Message[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
      { role: 'user', content: 'list my sites' },
    ];

    const messages = await captureMessages(history);

    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(messages[0]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
    });
  });

  it('appends a tool result into a directly preceding user message', async () => {
    // Two tool results in a row: the second merges into the user-role entry
    // created for the first instead of opening another user entry
    const history: Message[] = [
      { role: 'user', content: 'check both sites' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'call_1', name: 'check-site-v1', arguments: { site_id: 1 } },
          { id: 'call_2', name: 'check-site-v1', arguments: { site_id: 2 } },
        ],
      },
      { role: 'tool', content: '{"ok":true}', toolCallId: 'call_1' },
      { role: 'tool', content: '{"ok":true}', toolCallId: 'call_2' },
    ];

    const messages = await captureMessages(history);

    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    const toolResults = messages[2]!.content as Array<{ type: string; tool_use_id: string }>;
    expect(toolResults.map((block) => block.tool_use_id)).toEqual(['call_1', 'call_2']);
  });
});
