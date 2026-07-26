import { beforeEach, describe, expect, it, vi } from 'vitest';

let streamData: string[] = [];
vi.mock('./sse-reader.js', () => ({
  readSSEStream: async function* (): AsyncGenerator<string, void, undefined> {
    for (const chunk of streamData) yield chunk;
  },
}));

import { OpenAIProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';
import { MAX_STREAMED_TOOL_CALLS, type StreamChunk } from './provider.js';

async function collect(stream: AsyncGenerator<StreamChunk, void, undefined>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

/**
 * One OpenAI-compatible SSE event carrying tool-call deltas, optionally the
 * finish event.
 */
function openAIToolCallEvent(
  toolCalls: Array<{ index: number; id?: string; name?: string; arguments?: string }>,
  finishReason: string | null = null
): string {
  return JSON.stringify({
    id: 'response-1',
    model: 'test-model',
    choices: [{
      index: 0,
      delta: {
        tool_calls: toolCalls.map((tc) => ({
          index: tc.index,
          ...(tc.id !== undefined ? { id: tc.id } : {}),
          function: {
            ...(tc.name !== undefined ? { name: tc.name } : {}),
            ...(tc.arguments !== undefined ? { arguments: tc.arguments } : {}),
          },
        })),
      },
      finish_reason: finishReason,
    }],
  });
}

describe('streamed malformed tool arguments', () => {
  beforeEach(() => {
    streamData = [];
  });

  it('surfaces raw malformed OpenAI arguments for protocol rejection', async () => {
    streamData = [
      JSON.stringify({
        id: 'response-1',
        model: 'test-model',
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_bad',
              function: { name: 'mainwp__list-sites-v1', arguments: '{bad' },
            }],
          },
          finish_reason: null,
        }],
      }),
      JSON.stringify({
        id: 'response-1',
        model: 'test-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      }),
    ];

    const chunks = await collect(new OpenAIProvider({ apiKey: 'test-key' }).chatStream([]));

    expect(chunks).toContainEqual(expect.objectContaining({
      toolCall: expect.objectContaining({ arguments: '{bad' }),
    }));
  });

  // The SSE line reader bounds one line, but argument deltas are concatenated
  // across an unbounded number of lines, so the cap has to live here.
  it('aborts an OpenAI stream whose tool arguments exceed the cap', async () => {
    const delta = 'x'.repeat(600_000);
    streamData = [0, 1].map((index) =>
      JSON.stringify({
        id: 'response-1',
        model: 'test-model',
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              ...(index === 0 ? { id: 'call_big' } : {}),
              function: {
                ...(index === 0 ? { name: 'mainwp__list-sites-v1' } : {}),
                arguments: delta,
              },
            }],
          },
          finish_reason: null,
        }],
      })
    );

    await expect(
      collect(new OpenAIProvider({ apiKey: 'test-key' }).chatStream([]))
    ).rejects.toThrow(/tool call argument limit exceeded/);
  });

  it('aborts an Anthropic stream whose tool arguments exceed the cap', async () => {
    const delta = 'x'.repeat(600_000);
    streamData = [
      JSON.stringify({
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'call_big', name: 'mainwp__list-sites-v1' },
      }),
      JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: delta },
      }),
      JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: delta },
      }),
      JSON.stringify({ type: 'content_block_stop' }),
      JSON.stringify({ type: 'message_stop' }),
    ];

    await expect(
      collect(new AnthropicProvider({ apiKey: 'test-key' }).chatStream([]))
    ).rejects.toThrow(/tool call argument limit exceeded/);
  });

  // Nothing is yielded until the finish event, so the chat engine's own caps
  // cannot engage while a hostile endpoint keeps opening indices.
  it('aborts an OpenAI stream that opens more tool calls than the cap', async () => {
    streamData = [
      openAIToolCallEvent(
        Array.from({ length: MAX_STREAMED_TOOL_CALLS + 1 }, (_, index) => ({
          index,
          id: `call_${index}`,
          name: 'mainwp__list-sites-v1',
          arguments: '{}',
        }))
      ),
    ];

    await expect(
      collect(new OpenAIProvider({ apiKey: 'test-key' }).chatStream([]))
    ).rejects.toThrow(/tool call count limit exceeded/);
  });

  it('aborts an OpenAI stream whose first delta for a new index exceeds the cap', async () => {
    streamData = [
      openAIToolCallEvent([{
        index: 0,
        id: 'call_big',
        name: 'mainwp__list-sites-v1',
        arguments: 'x'.repeat(1_100_000),
      }]),
    ];

    await expect(
      collect(new OpenAIProvider({ apiKey: 'test-key' }).chatStream([]))
    ).rejects.toThrow(/tool call argument limit exceeded/);
  });

  // Each index stays under the per-call cap; only the aggregate stops N indices
  // from multiplying the same memory.
  it('aborts an OpenAI stream whose tool calls exceed the aggregate cap together', async () => {
    const delta = 'x'.repeat(600_000);
    streamData = [0, 1].map((index) =>
      openAIToolCallEvent([{
        index,
        id: `call_${index}`,
        name: 'mainwp__list-sites-v1',
        arguments: delta,
      }])
    );

    await expect(
      collect(new OpenAIProvider({ apiKey: 'test-key' }).chatStream([]))
    ).rejects.toThrow(/tool call argument limit exceeded/);
  });

  // The delta that breaches the cap can be the one carrying finish_reason.
  // Yielding it would hand the engine a call this provider truncated, followed
  // by a completion marker claiming the response was whole.
  it('throws instead of yielding when the finish event carries the overflowing delta', async () => {
    streamData = [
      openAIToolCallEvent([{
        index: 0,
        id: 'call_final',
        name: 'mainwp__list-sites-v1',
        arguments: '{"site_id":123}',
      }]),
      openAIToolCallEvent([{ index: 0, arguments: 'x'.repeat(1_100_000) }], 'tool_calls'),
    ];

    const chunks: StreamChunk[] = [];
    await expect(
      (async () => {
        for await (const chunk of new OpenAIProvider({ apiKey: 'test-key' }).chatStream([])) {
          chunks.push(chunk);
        }
      })()
    ).rejects.toThrow(/tool call argument limit exceeded/);
    expect(chunks).toEqual([]);
  });

  // Anthropic needs no count budget of its own: each block is yielded at its
  // content_block_stop, so the engine's cap engages and the provider holds at
  // most one call's arguments at a time.
  it('yields each Anthropic tool call as its block closes', async () => {
    streamData = [0, 1, 2].flatMap((index) => [
      JSON.stringify({
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: `call_${index}`, name: 'mainwp__list-sites-v1' },
      }),
      JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: '{}' },
      }),
      JSON.stringify({ type: 'content_block_stop' }),
    ]);

    const chunks = await collect(new AnthropicProvider({ apiKey: 'test-key' }).chatStream([]));

    expect(chunks.filter((chunk) => chunk.toolCall)).toHaveLength(3);
  });

  it('surfaces raw malformed Anthropic arguments for protocol rejection', async () => {
    streamData = [
      JSON.stringify({
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'call_bad', name: 'mainwp__list-sites-v1' },
      }),
      JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: '{bad' },
      }),
      JSON.stringify({ type: 'content_block_stop' }),
      JSON.stringify({ type: 'message_stop' }),
    ];

    const chunks = await collect(new AnthropicProvider({ apiKey: 'test-key' }).chatStream([]));

    expect(chunks).toContainEqual(expect.objectContaining({
      toolCall: expect.objectContaining({ arguments: '{bad' }),
    }));
  });
});
