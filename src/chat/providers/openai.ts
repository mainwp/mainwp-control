/**
 * OpenAI Provider for mainwpctl
 *
 * Implements LLM provider interface for OpenAI GPT models.
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
 * OpenAI API message format
 */
interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

/**
 * OpenAI tool call format
 */
interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * OpenAI tool definition format
 */
interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * OpenAI API response
 */
interface OpenAIResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason: 'stop' | 'tool_calls' | 'length' | 'content_filter';
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * OpenAI stream chunk
 */
interface OpenAIStreamChunk {
  id: string;
  object: string;
  created: number;
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
 * Available OpenAI models
 */
const OPENAI_MODELS = [
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-4-turbo',
  'gpt-4',
  'gpt-3.5-turbo',
] as const;

const DEFAULT_MODEL = 'gpt-4o-mini';

/**
 * OpenAI provider implementation
 */
export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';
  readonly capabilities: ProviderCapabilities = {
    functionCalling: true,
    streaming: true,
    systemMessages: true,
    vision: true,
    maxContextLength: 128000, // GPT-4o
  };

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly timeout: number;
  private readonly organization: string | undefined;

  constructor(config: ProviderConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? 'https://api.openai.com/v1';
    this.defaultModel = config.defaultModel ?? DEFAULT_MODEL;
    this.timeout = config.timeout ?? 60000;
    this.organization = config.organization;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  getModels(): string[] {
    return [...OPENAI_MODELS];
  }

  getDefaultModel(): string {
    return this.defaultModel;
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<LLMResponse> {
    const model = options?.model ?? this.defaultModel;
    const openaiMessages = this.convertMessages(messages);

    const requestBody: Record<string, unknown> = {
      model,
      messages: openaiMessages,
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

    const response = await this.makeRequest<OpenAIResponse>(
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
    const openaiMessages = this.convertMessages(messages);

    const requestBody: Record<string, unknown> = {
      model,
      messages: openaiMessages,
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

    const response = await fetch(
      `${this.baseUrl}/chat/completions`,
      fetchOptions
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} ${error}`);
    }

    if (!response.body) {
      throw new Error('No response body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // Track tool calls across chunks
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
          const chunk = JSON.parse(data) as OpenAIStreamChunk;
          const choice = chunk.choices[0];
          if (!choice) continue;

          const delta = choice.delta;

          // Content chunk
          if (delta.content) {
            yield { content: delta.content, done: false };
          }

          // Tool call chunks
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

          // Final chunk
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
                // Invalid JSON, skip
              }
            }
            yield { done: true };
            return;
          }
        } catch {
          // Invalid JSON, skip line
        }
      }
    }

    yield { done: true };
  }

  /**
   * Convert internal messages to OpenAI format
   */
  private convertMessages(messages: Message[]): OpenAIMessage[] {
    return messages.map((msg) => {
      const base: OpenAIMessage = {
        role: msg.role,
        content: msg.content,
      };

      if (msg.role === 'tool' && msg.toolCallId) {
        base.tool_call_id = msg.toolCallId;
      }

      return base;
    });
  }

  /**
   * Convert tool definitions to OpenAI format
   */
  private convertTools(
    tools: Array<{
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    }>
  ): OpenAITool[] {
    return tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  /**
   * Convert OpenAI response to internal format
   */
  private convertResponse(response: OpenAIResponse): LLMResponse {
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

  /**
   * Parse tool call arguments
   */
  private parseArguments(args: string): Record<string, unknown> {
    try {
      return JSON.parse(args) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  /**
   * Get request headers
   */
  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };

    if (this.organization) {
      headers['OpenAI-Organization'] = this.organization;
    }

    return headers;
  }

  /**
   * Make API request
   */
  private async makeRequest<T>(
    endpoint: string,
    body: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    // Combine signals
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
        throw new Error(`OpenAI API error: ${response.status} ${error}`);
      }

      return (await response.json()) as T;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Combine abort signals
   */
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
 * Create OpenAI provider
 */
export function createOpenAIProvider(config: ProviderConfig): LLMProvider {
  return new OpenAIProvider(config);
}

// Register provider
registerProvider('openai', createOpenAIProvider);
