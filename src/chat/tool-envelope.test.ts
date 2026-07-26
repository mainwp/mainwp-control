import { describe, expect, it } from 'vitest';
import { parseResponse } from './tool-envelope.js';
import type { LLMResponse, ToolCall } from './providers/provider.js';

function contentResponse(content: string): LLMResponse {
  return {
    content,
    finishReason: 'stop',
    model: 'test-model',
  };
}

function expectToolCall(
  content: string,
  tool: string,
  input: Record<string, unknown>
): void {
  expect(parseResponse(contentResponse(content)).response).toEqual({
    type: 'tool',
    tool,
    input,
  });
}

describe('parseResponse', () => {
  it('parses a tool call from a fenced json block', () => {
    expectToolCall(
      '```json\n{"tool":"list-sites-v1","input":{"page":1}}\n```',
      'list-sites-v1',
      { page: 1 }
    );
  });

  it('parses a tool call from a fenced block without a language tag', () => {
    expectToolCall(
      '```\n{"tool":"list-sites-v1","input":{"page":2}}\n```',
      'list-sites-v1',
      { page: 2 }
    );
  });

  it('parses JSON after prose containing an earlier brace pair', () => {
    expectToolCall(
      'I\'ll update {site} now. {"tool":"update-site-v1","input":{"site_id":7}}',
      'update-site-v1',
      { site_id: 7 }
    );
  });

  it('parses JSON followed by prose', () => {
    expectToolCall(
      '{"tool":"list-sites-v1","input":{}} I can explain the result next.',
      'list-sites-v1',
      {}
    );
  });

  it('handles nested objects, braces in strings, and escaped quotes', () => {
    const input = {
      metadata: {
        template: '{site}',
        text: 'b}c',
        quote: 'say "hello"',
      },
    };

    expectToolCall(
      `Ready. ${JSON.stringify({ tool: 'update-site-v1', input })}`,
      'update-site-v1',
      input
    );
  });

  it('treats a response with no JSON as a plain answer', () => {
    const content = 'No matching sites were found.';

    expect(parseResponse(contentResponse(content)).response).toEqual({
      type: 'answer',
      answer: content,
    });
  });

  it('treats prose containing non-JSON braces as an answer, not a protocol error', () => {
    const content = 'The config uses { key: value } format for site entries.';

    expect(parseResponse(contentResponse(content)).response).toEqual({
      type: 'answer',
      answer: content,
    });
  });

  it('keeps malformed content that leads with "{" on the retryable error path', () => {
    const result = parseResponse(contentResponse('{"type": "tool_call", broken'));

    expect(result.response.type).toBe('error');
    expect(result.response).toMatchObject({ retryable: true });
  });

  it('treats a malformed tool envelope after prose as retryable, not an answer', () => {
    const result = parseResponse(
      contentResponse('I will call it now: {"tool": "delete-site-v1", "input":')
    );

    expect(result.response.type).toBe('error');
    expect(result.response).toMatchObject({ retryable: true });
  });

  it('treats a malformed answer envelope after prose as retryable, not an answer', () => {
    const result = parseResponse(
      contentResponse('Here is my reply: {"answer": "the site is')
    );

    expect(result.response.type).toBe('error');
    expect(result.response).toMatchObject({ retryable: true });
  });

  it('rejects native responses containing multiple tool calls', () => {
    const toolCalls: ToolCall[] = [
      { id: 'call_1', name: 'list-sites-v1', arguments: {} },
      { id: 'call_2', name: 'list-sites-v1', arguments: {} },
    ];

    const result = parseResponse({
      content: '',
      toolCalls,
      finishReason: 'tool_calls',
      model: 'test-model',
    });

    expect(result.response).toEqual({
      type: 'error',
      error: 'Expected exactly one tool call, received 2',
      retryable: true,
    });
  });
});

describe('JSON scan bounding (F19)', () => {
  it('completes quickly on an adversarial unclosed-brace payload', () => {
    // The balanced-brace scan restarts from every "{", so a wall of unclosed
    // braces is quadratic without the scan bounds.
    const hostile = `prose ${'{'.repeat(300_000)}`;
    const start = Date.now();

    const result = parseResponse(contentResponse(hostile));

    expect(Date.now() - start).toBeLessThan(500);
    // Bounded scan finds no envelope; content that leads with prose but
    // carries no envelope key is still surfaced as an answer.
    expect(result.response.type).toBe('answer');
  });

  it('still extracts an envelope embedded in surrounding prose', () => {
    const result = parseResponse(
      contentResponse('Here you go: {"answer": "hello"} — done')
    );

    expect(result.response).toEqual({ type: 'answer', answer: 'hello' });
  });

  it('still extracts a tool envelope embedded in prose', () => {
    const result = parseResponse(
      contentResponse('Calling now: {"tool": "list-sites-v1", "input": {}}')
    );

    expect(result.response).toEqual({
      type: 'tool',
      tool: 'list-sites-v1',
      input: {},
    });
  });
});
