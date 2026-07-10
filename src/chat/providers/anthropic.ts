/**
 * Anthropic Provider for mainwpcontrol
 *
 * Implements LLM provider interface for Claude models.
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
  splitSystemMessage,
} from './provider.js';
import { makeProviderRequest } from './provider-fetch.js';
import { readSSEStream } from './sse-reader.js';

/**
 * Anthropic API message format
 */
interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContent[];
}

/**
 * Anthropic content types
 */
type AnthropicContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

/**
 * Anthropic tool definition format
 */
interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/**
 * Anthropic API response
 */
interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: AnthropicContent[];
  model: string;
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
  stop_sequence?: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

/**
 * Anthropic stream events
 */
interface AnthropicStreamEvent {
  type: string;
  index?: number;
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
  };
  content_block?: AnthropicContent;
  message?: AnthropicResponse;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

/**
 * Available Anthropic models
 */
const ANTHROPIC_MODELS = [
  'claude-sonnet-4-20250514',
  'claude-3-5-sonnet-20241022',
  'claude-3-5-haiku-20241022',
  'claude-3-opus-20240229',
  'claude-3-sonnet-20240229',
  'claude-3-haiku-20240307',
] as const;

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const API_VERSION = '2023-06-01';

/**
 * Anthropic provider implementation
 */
export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  readonly capabilities: ProviderCapabilities = {
    functionCalling: true,
    streaming: true,
    systemMessages: true,
    vision: true,
    maxContextLength: 200000, // Claude 3
  };

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly timeout: number;

  constructor(config: ProviderConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? 'https://api.anthropic.com';
    this.defaultModel = config.defaultModel ?? DEFAULT_MODEL;
    this.timeout = config.timeout ?? 60000;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  getModels(): string[] {
    return [...ANTHROPIC_MODELS];
  }

  getDefaultModel(): string {
    return this.defaultModel;
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<LLMResponse> {
    const model = options?.model ?? this.defaultModel;

    const { systemContent, chatMessages } = splitSystemMessage(messages);

    const requestBody: Record<string, unknown> = {
      model,
      messages: this.convertMessages(chatMessages),
      max_tokens: options?.maxTokens ?? 4096,
    };

    if (systemContent !== undefined) {
      requestBody['system'] = systemContent;
    }

    if (options?.temperature !== undefined) {
      requestBody['temperature'] = options.temperature;
    }

    if (options?.stop) {
      requestBody['stop_sequences'] = options.stop;
    }

    if (options?.tools && options.tools.length > 0) {
      requestBody['tools'] = this.convertTools(options.tools);
    }

    const response = await makeProviderRequest<AnthropicResponse>({
      url: `${this.baseUrl}/v1/messages`,
      headers: this.getHeaders(),
      body: requestBody,
      timeout: this.timeout,
      signal: options?.signal,
      providerName: 'Anthropic',
    });

    return this.convertResponse(response);
  }

  async *chatStream(
    messages: Message[],
    options?: ChatOptions
  ): AsyncGenerator<StreamChunk, void, undefined> {
    const model = options?.model ?? this.defaultModel;

    const { systemContent, chatMessages } = splitSystemMessage(messages);

    const requestBody: Record<string, unknown> = {
      model,
      messages: this.convertMessages(chatMessages),
      max_tokens: options?.maxTokens ?? 4096,
      stream: true,
    };

    if (systemContent !== undefined) {
      requestBody['system'] = systemContent;
    }

    if (options?.temperature !== undefined) {
      requestBody['temperature'] = options.temperature;
    }

    if (options?.tools && options.tools.length > 0) {
      requestBody['tools'] = this.convertTools(options.tools);
    }

    // Track tool calls
    let toolId = '';
    let toolName = '';
    let toolArgs = '';

    for await (const data of readSSEStream({
      url: `${this.baseUrl}/v1/messages`,
      headers: this.getHeaders(),
      body: requestBody,
      signal: options?.signal,
      providerName: 'Anthropic',
    })) {
      try {
        const event = JSON.parse(data) as AnthropicStreamEvent;

        if (event.type === 'content_block_start') {
          const block = event.content_block;
          if (block?.type === 'tool_use') {
            toolId = block.id;
            toolName = block.name;
            toolArgs = '';
          }
        }

        if (event.type === 'content_block_delta') {
          const delta = event.delta;
          if (delta?.type === 'text_delta' && delta.text) {
            yield { content: delta.text, done: false };
          }
          if (delta?.type === 'input_json_delta' && delta.partial_json) {
            toolArgs += delta.partial_json;
          }
        }

        if (event.type === 'content_block_stop') {
          if (toolId && toolName) {
            try {
              const args = JSON.parse(toolArgs || '{}') as Record<string, unknown>;
              yield {
                toolCall: {
                  id: toolId,
                  name: toolName,
                  arguments: args,
                },
                done: false,
              };
            } catch {
              // Invalid JSON, skip
            }
            toolId = '';
            toolName = '';
            toolArgs = '';
          }
        }

        if (event.type === 'message_stop') {
          yield { done: true };
          return;
        }
      } catch {
        // Invalid JSON, skip line — a systematically malformed stream would
        // otherwise fail silently, so leave a trail when debugging
        if (process.env['DEBUG']) {
          console.debug('[Anthropic] Skipped malformed SSE chunk');
        }
      }
    }

    yield { done: true };
  }

  /**
   * Convert internal messages to Anthropic format
   */
  private convertMessages(messages: Message[]): AnthropicMessage[] {
    const result: AnthropicMessage[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') continue; // Handled separately

      if (msg.role === 'tool') {
        // Tool results in Anthropic format
        const lastMsg = result[result.length - 1];
        if (lastMsg && lastMsg.role === 'user') {
          // Append to existing user message
          if (typeof lastMsg.content === 'string') {
            lastMsg.content = [{ type: 'text', text: lastMsg.content }];
          }
          (lastMsg.content as AnthropicContent[]).push({
            type: 'tool_result',
            tool_use_id: msg.toolCallId ?? '',
            content: msg.content,
          });
        } else {
          // Create new user message with tool result
          result.push({
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: msg.toolCallId ?? '',
                content: msg.content,
              },
            ],
          });
        }
      } else {
        result.push({
          role: msg.role as 'user' | 'assistant',
          content: msg.content,
        });
      }
    }

    return result;
  }

  /**
   * Convert tool definitions to Anthropic format
   */
  private convertTools(
    tools: Array<{
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    }>
  ): AnthropicTool[] {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));
  }

  /**
   * Convert Anthropic response to internal format
   */
  private convertResponse(response: AnthropicResponse): LLMResponse {
    let content = '';
    const toolCalls: ToolCall[] = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        content += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: block.input,
        });
      }
    }

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason: this.convertFinishReason(response.stop_reason),
      usage: {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
        totalTokens: response.usage.input_tokens + response.usage.output_tokens,
      },
      model: response.model,
    };
  }

  /**
   * Convert finish reason
   */
  private convertFinishReason(
    reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence'
  ): LLMResponse['finishReason'] {
    switch (reason) {
      case 'end_turn':
        return 'stop';
      case 'tool_use':
        return 'tool_calls';
      case 'max_tokens':
        return 'length';
      default:
        return 'stop';
    }
  }

  /**
   * Get request headers
   */
  private getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': API_VERSION,
    };
  }

}

/**
 * Create Anthropic provider
 */
export function createAnthropicProvider(config: ProviderConfig): LLMProvider {
  return new AnthropicProvider(config);
}

// Register provider
registerProvider('anthropic', createAnthropicProvider);
