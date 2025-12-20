/**
 * OpenRouter Provider for mainwpctl
 *
 * Implements LLM provider interface for OpenRouter.
 * OpenRouter provides access to multiple models through a unified API
 * that's compatible with OpenAI's format.
 */

import {
  type LLMProvider,
  type LLMResponse,
  type Message,
  type ChatOptions,
  type ProviderConfig,
  type ProviderCapabilities,
  type StreamChunk,
  type ToolCall,
  registerProvider,
} from './provider.js';

/**
 * OpenRouter uses OpenAI-compatible format
 */
interface OpenRouterMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OpenRouterToolCall[];
  tool_call_id?: string;
}

interface OpenRouterToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenRouterTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OpenRouterResponse {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: OpenRouterToolCall[];
    };
    finish_reason: 'stop' | 'tool_calls' | 'length' | 'content_filter';
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface OpenRouterStreamChunk {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: 'assistant';
      content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: 'function';
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | null;
  }>;
}

/**
 * Popular OpenRouter models
 */
const OPENROUTER_MODELS = [
  'anthropic/claude-3.5-sonnet',
  'anthropic/claude-3-opus',
  'openai/gpt-4o',
  'openai/gpt-4o-mini',
  'google/gemini-pro-1.5',
  'meta-llama/llama-3.1-405b-instruct',
  'meta-llama/llama-3.1-70b-instruct',
  'mistralai/mistral-large',
] as const;

const DEFAULT_MODEL = 'anthropic/claude-3.5-sonnet';

/**
 * OpenRouter provider implementation
 */
export class OpenRouterProvider implements LLMProvider {
  readonly name = 'openrouter';
  readonly capabilities: ProviderCapabilities = {
    functionCalling: true,
    streaming: true,
    systemMessages: true,
    vision: true,
    maxContextLength: 200000, // Varies by model
  };

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly timeout: number;
  private readonly appName: string;

  constructor(config: ProviderConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? 'https://openrouter.ai/api/v1';
    this.defaultModel = config.defaultModel ?? DEFAULT_MODEL;
    this.timeout = config.timeout ?? 60000;
    this.appName = 'mainwpctl';
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  getModels(): string[] {
    return [...OPENROUTER_MODELS];
  }

  getDefaultModel(): string {
    return this.defaultModel;
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<LLMResponse> {
    const model = options?.model ?? this.defaultModel;
    const openrouterMessages = this.convertMessages(messages);

    const requestBody: Record<string, unknown> = {
      model,
      messages: openrouterMessages,
    };

    if (options?.temperature !== undefined) {
      requestBody['temperature'] = options.temperature;
    }

    if (options?.maxTokens !== undefined) {
      requestBody['max_tokens'] = options.maxTokens;
    }

    if (options?.stop) {
      requestBody['stop'] = options.stop;
    }

    if (options?.tools && options.tools.length > 0) {
      requestBody['tools'] = this.convertTools(options.tools);
      requestBody['tool_choice'] = 'auto';
    }

    const response = await this.makeRequest<OpenRouterResponse>(
      '/chat/completions',
      requestBody,
      options?.signal
    );

    return this.convertResponse(response);
  }

  async *chatStream(
    messages: Message[],
    options?: ChatOptions
  ): AsyncGenerator<StreamChunk, void, undefined> {
    const model = options?.model ?? this.defaultModel;
    const openrouterMessages = this.convertMessages(messages);

    const requestBody: Record<string, unknown> = {
      model,
      messages: openrouterMessages,
      stream: true,
    };

    if (options?.temperature !== undefined) {
      requestBody['temperature'] = options.temperature;
    }

    if (options?.maxTokens !== undefined) {
      requestBody['max_tokens'] = options.maxTokens;
    }

    if (options?.tools && options.tools.length > 0) {
      requestBody['tools'] = this.convertTools(options.tools);
      requestBody['tool_choice'] = 'auto';
    }

    const fetchOptions: RequestInit = {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(requestBody),
    };

    if (options?.signal) {
      fetchOptions.signal = options.signal;
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, fetchOptions);

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenRouter API error: ${response.status} ${error}`);
    }

    if (!response.body) {
      throw new Error('No response body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const toolCalls = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') {
          yield { done: true };
          return;
        }

        try {
          const chunk = JSON.parse(data) as OpenRouterStreamChunk;
          const choice = chunk.choices[0];
          if (!choice) continue;

          const delta = choice.delta;

          if (delta.content) {
            yield { content: delta.content, done: false };
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const existing = toolCalls.get(tc.index);
              if (!existing) {
                toolCalls.set(tc.index, {
                  id: tc.id ?? '',
                  name: tc.function?.name ?? '',
                  arguments: tc.function?.arguments ?? '',
                });
              } else {
                if (tc.function?.arguments) {
                  existing.arguments += tc.function.arguments;
                }
              }
            }
          }

          if (choice.finish_reason === 'tool_calls') {
            for (const [, tc] of toolCalls) {
              try {
                const args = JSON.parse(tc.arguments) as Record<string, unknown>;
                yield {
                  toolCall: {
                    id: tc.id,
                    name: tc.name,
                    arguments: args,
                  },
                  done: false,
                };
              } catch {
                // Invalid JSON
              }
            }
            yield { done: true };
            return;
          }
        } catch {
          // Invalid JSON
        }
      }
    }

    yield { done: true };
  }

  private convertMessages(messages: Message[]): OpenRouterMessage[] {
    return messages.map((msg) => {
      const base: OpenRouterMessage = {
        role: msg.role,
        content: msg.content,
      };

      if (msg.role === 'tool' && msg.toolCallId) {
        base.tool_call_id = msg.toolCallId;
      }

      return base;
    });
  }

  private convertTools(
    tools: Array<{
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    }>
  ): OpenRouterTool[] {
    return tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  private convertResponse(response: OpenRouterResponse): LLMResponse {
    const choice = response.choices[0];
    if (!choice) {
      throw new Error('No response choice');
    }

    const toolCalls: ToolCall[] | undefined = choice.message.tool_calls?.map(
      (tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: this.parseArguments(tc.function.arguments),
      })
    );

    return {
      content: choice.message.content ?? '',
      toolCalls,
      finishReason: choice.finish_reason,
      usage: response.usage
        ? {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
            totalTokens: response.usage.total_tokens,
          }
        : undefined,
      model: response.model,
    };
  }

  private parseArguments(args: string): Record<string, unknown> {
    try {
      return JSON.parse(args) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      'HTTP-Referer': 'https://github.com/mainwp/mainwpctl',
      'X-Title': this.appName,
    };
  }

  private async makeRequest<T>(
    endpoint: string,
    body: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    const combinedSignal = signal
      ? this.combineSignals(signal, controller.signal)
      : controller.signal;

    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(body),
        signal: combinedSignal,
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`OpenRouter API error: ${response.status} ${error}`);
      }

      return (await response.json()) as T;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private combineSignals(
    signal1: AbortSignal,
    signal2: AbortSignal
  ): AbortSignal {
    const controller = new AbortController();

    const abort = () => controller.abort();
    signal1.addEventListener('abort', abort);
    signal2.addEventListener('abort', abort);

    return controller.signal;
  }
}

/**
 * Create OpenRouter provider
 */
export function createOpenRouterProvider(config: ProviderConfig): LLMProvider {
  return new OpenRouterProvider(config);
}

// Register provider
registerProvider('openrouter', createOpenRouterProvider);
