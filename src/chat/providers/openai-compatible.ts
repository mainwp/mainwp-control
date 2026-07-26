/**
 * OpenAI-Compatible Provider Base Class
 *
 * Abstract base for providers that use the OpenAI chat completions API format:
 * OpenAI, OpenRouter, and local OpenAI-compatible servers (Ollama, LM Studio, etc.)
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
  MAX_TOOL_ARGUMENTS_LENGTH,
} from './provider.js';
import { readSSEStream } from './sse-reader.js';
import {
  assertNoRedirect,
  MAX_PROVIDER_ERROR_BODY_BYTES,
  readBoundedResponseText,
  sanitizeProviderErrorBody,
} from './provider-fetch.js';

/**
 * OpenAI-compatible API message format
 */
export interface OpenAICompatibleMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OpenAICompatibleToolCall[];
  tool_call_id?: string;
}

/**
 * OpenAI-compatible tool call format
 */
export interface OpenAICompatibleToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * OpenAI-compatible tool definition format
 */
export interface OpenAICompatibleTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * OpenAI-compatible API response
 */
export interface OpenAICompatibleResponse {
  id: string;
  object?: string;
  created?: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: OpenAICompatibleToolCall[];
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * OpenAI-compatible stream chunk
 */
export interface OpenAICompatibleStreamChunk {
  id: string;
  object?: string;
  created?: number;
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
    finish_reason: string | null;
  }>;
}

/**
 * Abstract base class for OpenAI-compatible LLM providers.
 *
 * Subclasses must implement:
 * - `name` and `capabilities` (readonly properties)
 * - `getHeaders()` — provider-specific auth headers
 * - `getModels()` — available model list
 * - `isConfigured()` — config validation
 *
 * Subclasses may override:
 * - `convertFinishReason()` — if the provider maps finish reasons differently
 * - `chat()` — if the provider needs fallback logic (e.g. local tool embedding)
 * - `getStreamToolCallId()` — if the provider generates tool call IDs differently
 */
export abstract class OpenAICompatibleProvider implements LLMProvider {
  abstract readonly name: string;
  abstract readonly capabilities: ProviderCapabilities;

  protected readonly apiKey: string;
  protected readonly baseUrl: string;
  protected readonly defaultModel: string;
  protected readonly timeout: number;

  constructor(config: ProviderConfig, defaults: { baseUrl: string; model: string; timeout?: number }) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? defaults.baseUrl;
    this.defaultModel = config.defaultModel ?? defaults.model;
    this.timeout = config.timeout ?? (defaults.timeout ?? 60000);
  }

  abstract isConfigured(): boolean;
  abstract getModels(): string[];
  protected abstract getHeaders(): Record<string, string>;

  getDefaultModel(): string {
    return this.defaultModel;
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<LLMResponse> {
    const model = options?.model ?? this.defaultModel;
    const apiMessages = this.convertMessages(messages);

    const requestBody: Record<string, unknown> = {
      model,
      messages: apiMessages,
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

    const response = await this.makeRequest<OpenAICompatibleResponse>(
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
    const apiMessages = this.convertMessages(messages);

    const requestBody: Record<string, unknown> = {
      model,
      messages: apiMessages,
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

    // Track tool calls across chunks
    const toolCalls = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();

    // Set inside the try below, thrown after it: the catch there swallows
    // everything as a malformed chunk, so throwing inside would turn the cap
    // breach into a silently skipped event and let accumulation continue.
    let argumentsOverflow = false;

    for await (const data of readSSEStream({
      url: `${this.baseUrl}/chat/completions`,
      headers: this.getHeaders(),
      body: requestBody,
      signal: options?.signal,
      providerName: this.name,
    })) {
      if (data === '[DONE]') {
        yield { done: true };
        return;
      }

      try {
        const chunk = JSON.parse(data) as OpenAICompatibleStreamChunk;
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
                id: tc.id ?? this.getStreamToolCallId(tc.index),
                name: tc.function?.name ?? '',
                arguments: tc.function?.arguments ?? '',
              });
            } else if (tc.function?.arguments) {
              // Per call: the deltas for one index are concatenated across an
              // unbounded number of events, which the SSE line cap does not
              // bound.
              if (
                existing.arguments.length + tc.function.arguments.length >
                MAX_TOOL_ARGUMENTS_LENGTH
              ) {
                argumentsOverflow = true;
              } else {
                existing.arguments += tc.function.arguments;
              }
            }
          }
        }

        // Final chunk
        if (choice.finish_reason === 'tool_calls') {
          for (const [, tc] of toolCalls) {
            let args: unknown = tc.arguments;
            try {
              args = JSON.parse(tc.arguments) as unknown;
            } catch {
              // Preserve the raw accumulated string. The shared tool envelope
              // rejects non-object arguments as a protocol error without
              // executing the proposed call.
            }
            yield {
              toolCall: {
                id: tc.id,
                name: tc.name,
                arguments: args,
              },
              done: false,
            };
          }
          yield { done: true };
          return;
        }
      } catch {
        // Invalid JSON, skip line — a systematically malformed stream would
        // otherwise fail silently, so leave a trail when debugging
        if (process.env['DEBUG']) {
          console.debug(`[${this.name}] Skipped malformed SSE chunk`);
        }
      }

      if (argumentsOverflow) {
        throw new Error(`${this.name} tool call argument limit exceeded`);
      }
    }

    yield { done: true };
  }

  /**
   * Convert internal messages to OpenAI-compatible format
   */
  protected convertMessages(messages: Message[]): OpenAICompatibleMessage[] {
    return messages.map((msg) => {
      const base: OpenAICompatibleMessage = {
        role: msg.role,
        content: msg.content,
      };

      if (msg.role === 'tool' && msg.toolCallId) {
        base.tool_call_id = msg.toolCallId;
      }

      if (msg.role === 'assistant' && msg.toolCalls) {
        base.content = msg.content || null;
        base.tool_calls = msg.toolCalls.map((toolCall) => ({
          id: toolCall.id,
          type: 'function' as const,
          function: {
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.arguments),
          },
        }));
      }

      return base;
    });
  }

  /**
   * Convert tool definitions to OpenAI-compatible format
   */
  protected convertTools(
    tools: Array<{
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    }>
  ): OpenAICompatibleTool[] {
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
   * Convert OpenAI-compatible response to internal format
   */
  protected convertResponse(response: OpenAICompatibleResponse): LLMResponse {
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
      finishReason: this.convertFinishReason(choice.finish_reason),
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
   * Convert the API finish reason string to the internal LLMResponse finishReason.
   * Override in subclasses if the provider uses different finish reason strings.
   */
  protected convertFinishReason(reason: string): LLMResponse['finishReason'] {
    switch (reason) {
      case 'stop':
        return 'stop';
      case 'tool_calls':
        return 'tool_calls';
      case 'length':
        return 'length';
      case 'content_filter':
        return 'content_filter';
      default:
        return reason as LLMResponse['finishReason'];
    }
  }

  /**
   * Parse tool call arguments JSON
   */
  protected parseArguments(args: string): unknown {
    try {
      return JSON.parse(args) as unknown;
    } catch {
      return args;
    }
  }

  /**
   * Generate a tool call ID for streaming when the server doesn't provide one.
   * Override in subclasses if needed (e.g. local providers that omit IDs).
   */
  protected getStreamToolCallId(index: number): string {
    return `tc_${Date.now()}_${index}`;
  }

  /**
   * Make API request with timeout
   */
  protected async makeRequest<T>(
    endpoint: string,
    body: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    const combinedSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;

    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(body),
        signal: combinedSignal,
        redirect: 'manual',
      });

      assertNoRedirect(response, this.name);

      if (!response.ok) {
        const error = await readBoundedResponseText(
          response,
          MAX_PROVIDER_ERROR_BODY_BYTES,
          combinedSignal,
        );
        throw new Error(
          `${this.name} API error: ${response.status} ${sanitizeProviderErrorBody(error)}`
        );
      }

      return (await response.json()) as T;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
