import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatEngine } from '../chat-engine.js';
import type { Ability, ExecutionOptions, ExecutionResult } from '../../core/abilities-executor.js';
import type { LLMProvider } from './provider.js';
import { OpenAIProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';
import { GeminiProvider } from './gemini.js';

vi.mock('../../utils/audit-logger.js', () => ({
  logDestructiveActionSafe: vi.fn(async () => undefined),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const readonlyAbility: Ability = {
  name: 'mainwp/list-sites-v1',
  label: 'List sites',
  description: 'List sites',
  category: 'sites',
  input_schema: { type: 'object', properties: {} },
  meta: {
    annotations: { readonly: true, destructive: false, idempotent: true },
  },
};

const destructiveAbility: Ability = {
  name: 'mainwp/delete-site-v1',
  label: 'Delete site',
  description: 'Delete a site',
  category: 'sites',
  input_schema: {
    type: 'object',
    properties: { site_id: { type: 'integer' } },
    required: ['site_id'],
  },
  meta: {
    annotations: { readonly: false, destructive: true, idempotent: false },
  },
};

type WireProvider = 'openai' | 'anthropic' | 'gemini';

function okJson(data: unknown): object {
  return {
    ok: true,
    json: async () => data,
  };
}

function createProvider(name: WireProvider): LLMProvider {
  switch (name) {
    case 'openai':
      return new OpenAIProvider({ apiKey: 'test-key' });
    case 'anthropic':
      return new AnthropicProvider({ apiKey: 'test-key' });
    case 'gemini':
      return new GeminiProvider({ apiKey: 'test-key' });
  }
}

function toolResponse(name: WireProvider, toolName: string, id: string): object {
  switch (name) {
    case 'openai':
      return {
        id: 'response-1',
        model: 'test-model',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id,
              type: 'function',
              function: { name: toolName, arguments: toolName.includes('delete') ? '{"site_id":123}' : '{}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      };
    case 'anthropic':
      return {
        id: 'response-1',
        type: 'message',
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id,
          name: toolName,
          input: toolName.includes('delete') ? { site_id: 123 } : {},
        }],
        model: 'test-model',
        stop_reason: 'tool_use',
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    case 'gemini':
      return {
        candidates: [{
          content: {
            role: 'model',
            parts: [{
              functionCall: {
                id,
                name: toolName,
                args: toolName.includes('delete') ? { site_id: 123 } : {},
              },
            }],
          },
          finishReason: 'STOP',
        }],
      };
  }
}

function answerResponse(name: WireProvider): object {
  switch (name) {
    case 'openai':
      return {
        id: 'response-2',
        model: 'test-model',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: '{"answer":"Done"}' },
          finish_reason: 'stop',
        }],
      };
    case 'anthropic':
      return {
        id: 'response-2',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: '{"answer":"Done"}' }],
        model: 'test-model',
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    case 'gemini':
      return {
        candidates: [{
          content: { role: 'model', parts: [{ text: '{"answer":"Done"}' }] },
          finishReason: 'STOP',
        }],
      };
  }
}

function createExecutor(
  ability: Ability,
  executeHandler?: (
    options?: ExecutionOptions
  ) => ExecutionResult
): {
  listAbilities: ReturnType<typeof vi.fn>;
  getAbility: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
} {
  return {
    listAbilities: vi.fn(async () => [ability]),
    getAbility: vi.fn(async (name: string) => name === ability.name ? ability : undefined),
    execute: vi.fn(async (
      _name: string,
      _input: Record<string, unknown>,
      options?: ExecutionOptions
    ) => executeHandler?.(options) ?? { success: true, data: { ok: true } }),
  };
}

function requestBody(callIndex: number): Record<string, unknown> {
  const request = mockFetch.mock.calls[callIndex]?.[1] as { body: string } | undefined;
  if (!request) throw new Error(`Missing fetch call ${callIndex}`);
  return JSON.parse(request.body) as Record<string, unknown>;
}

function assertAliasedDeclaration(provider: WireProvider, body: Record<string, unknown>): void {
  const tools = body['tools'] as Array<Record<string, unknown>>;
  let name: string;
  if (provider === 'openai') {
    name = ((tools[0]?.['function'] as Record<string, unknown>)?.['name']) as string;
  } else if (provider === 'anthropic') {
    name = tools[0]?.['name'] as string;
  } else {
    const declarations = tools[0]?.['functionDeclarations'] as Array<Record<string, unknown>>;
    name = declarations[0]?.['name'] as string;
  }
  expect(name).toBe('mainwp__list-sites-v1');
  expect(name).not.toContain('/');
}

function assertCallResultPair(
  provider: WireProvider,
  body: Record<string, unknown>,
  id: string,
  alias: string
): void {
  if (provider === 'openai') {
    const messages = body['messages'] as Array<Record<string, unknown>>;
    const assistant = messages.find((message) => message['role'] === 'assistant' && message['tool_calls']);
    const tool = messages.find((message) => message['role'] === 'tool');
    const call = (assistant?.['tool_calls'] as Array<Record<string, unknown>>)?.[0];
    expect(call?.['id']).toBe(id);
    expect((call?.['function'] as Record<string, unknown>)?.['name']).toBe(alias);
    expect(tool?.['tool_call_id']).toBe(id);
    return;
  }

  if (provider === 'anthropic') {
    const messages = body['messages'] as Array<Record<string, unknown>>;
    const blocks = messages.flatMap((message) =>
      Array.isArray(message['content']) ? message['content'] as Array<Record<string, unknown>> : []
    );
    expect(blocks).toContainEqual(expect.objectContaining({
      type: 'tool_use', id, name: alias,
    }));
    expect(blocks).toContainEqual(expect.objectContaining({
      type: 'tool_result', tool_use_id: id,
    }));
    return;
  }

  const contents = body['contents'] as Array<Record<string, unknown>>;
  const parts = contents.flatMap((content) => content['parts'] as Array<Record<string, unknown>>);
  expect(parts).toContainEqual({
    functionCall: expect.objectContaining({ id, name: alias }),
  });
  expect(parts).toContainEqual({
    functionResponse: expect.objectContaining({ id, name: alias }),
  });
}

describe.each<WireProvider>(['openai', 'anthropic', 'gemini'])('%s native tool protocol', (providerName) => {
  afterEach(() => {
    mockFetch.mockReset();
  });

  it('aliases declarations and preserves the native call block on continuation', async () => {
    const callId = `call_${providerName}_readonly`;
    mockFetch
      .mockResolvedValueOnce(okJson(toolResponse(providerName, 'mainwp__list-sites-v1', callId)))
      .mockResolvedValueOnce(okJson(answerResponse(providerName)));
    const executor = createExecutor(readonlyAbility);
    const engine = new ChatEngine({
      provider: createProvider(providerName),
      executor: executor as never,
    });

    await engine.sendMessage('List sites');

    assertAliasedDeclaration(providerName, requestBody(0));
    assertCallResultPair(
      providerName,
      requestBody(1),
      callId,
      'mainwp__list-sites-v1'
    );
  });

  it('preserves the original native call id after destructive approval', async () => {
    const callId = `call_${providerName}_delete`;
    mockFetch
      .mockResolvedValueOnce(okJson(toolResponse(providerName, 'mainwp__delete-site-v1', callId)))
      .mockResolvedValueOnce(okJson(answerResponse(providerName)));
    const executor = createExecutor(destructiveAbility, (options) =>
      options?.dryRun
        ? { success: true, data: { affected: [{ id: 123 }] } }
        : { success: true, data: { deleted: true } }
    );
    const engine = new ChatEngine({
      provider: createProvider(providerName),
      executor: executor as never,
    });

    await engine.sendMessage('Delete site 123');
    await engine.sendMessage('yes');
    await engine.sendMessage('Summarize the result');

    assertCallResultPair(
      providerName,
      requestBody(1),
      callId,
      'mainwp__delete-site-v1'
    );
  });
});

describe('provider model defaults', () => {
  it('advertises the active Anthropic models and defaults to Sonnet 4.6', () => {
    const provider = new AnthropicProvider({ apiKey: 'test-key' });
    expect(provider.getDefaultModel()).toBe('claude-sonnet-4-6');
    expect(provider.getModels()).toEqual([
      'claude-sonnet-4-6',
      'claude-sonnet-4-5-20250929',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-haiku-4-5-20251001',
    ]);
  });

  it('advertises active Gemini text models and defaults to Gemini 3.5 Flash', () => {
    const provider = new GeminiProvider({ apiKey: 'test-key' });
    expect(provider.getDefaultModel()).toBe('gemini-3.5-flash');
    expect(provider.getModels()).toEqual([
      'gemini-3.5-flash',
      'gemini-3.1-pro-preview',
      'gemini-3-flash-preview',
      'gemini-3.1-flash-lite',
    ]);
  });
});

describe('OpenAI malformed native arguments', () => {
  afterEach(() => {
    mockFetch.mockReset();
  });

  it('routes invalid argument JSON through the parse fallback without execution', async () => {
    mockFetch.mockResolvedValueOnce(okJson({
      id: 'response-invalid',
      model: 'test-model',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_invalid_json',
            type: 'function',
            function: {
              name: 'mainwp__list-sites-v1',
              arguments: '{not-json',
            },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    }));
    const executor = createExecutor(readonlyAbility);
    const engine = new ChatEngine({
      provider: createProvider('openai'),
      executor: executor as never,
      maxParseRetries: 0,
    });

    const responses = await engine.sendMessage('List sites');

    expect(responses[0]?.type).toBe('error');
    expect(executor.execute).not.toHaveBeenCalled();
  });
});
