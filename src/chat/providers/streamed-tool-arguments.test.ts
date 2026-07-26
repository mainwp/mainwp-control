import { beforeEach, describe, expect, it, vi } from 'vitest';

let streamData: string[] = [];
vi.mock('./sse-reader.js', () => ({
  readSSEStream: async function* (): AsyncGenerator<string, void, undefined> {
    for (const chunk of streamData) yield chunk;
  },
}));

import { OpenAIProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';
import type { StreamChunk } from './provider.js';

async function collect(stream: AsyncGenerator<StreamChunk, void, undefined>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
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
