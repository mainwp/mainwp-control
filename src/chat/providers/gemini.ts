/**
 * Google Gemini Provider for mainwpcontrol
 *
 * Implements LLM provider interface for Gemini models.
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
import { makeProviderRequest } from './provider-fetch.js';
import { readSSEStream } from './sse-reader.js';

/**
 * Gemini API content format
 */
interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

/**
 * Gemini part types
 */
type GeminiPart =
  | { text: string }
  | {
      functionCall: {
        name: string;
        args: Record<string, unknown>;
      };
    }
  | {
      functionResponse: {
        name: string;
        response: Record<string, unknown>;
      };
    };

/**
 * Gemini tool definition format
 */
interface GeminiTool {
  functionDeclarations: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }>;
}

/**
 * Gemini API response
 */
interface GeminiResponse {
  candidates: Array<{
    content: GeminiContent;
    finishReason: 'STOP' | 'MAX_TOKENS' | 'SAFETY' | 'RECITATION' | 'OTHER';
    safetyRatings?: Array<{
      category: string;
      probability: string;
    }>;
  }>;
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
}

/**
 * Available Gemini models
 */
const GEMINI_MODELS = [
  'gemini-2.0-flash-exp',
  'gemini-1.5-pro',
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b',
] as const;

const DEFAULT_MODEL = 'gemini-1.5-flash';

/**
 * Gemini provider implementation
 */
export class GeminiProvider implements LLMProvider {
  readonly name = 'gemini';
  readonly capabilities: ProviderCapabilities = {
    functionCalling: true,
    streaming: true,
    systemMessages: true,
    vision: true,
    maxContextLength: 1000000, // Gemini 1.5 Pro
  };

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly timeout: number;

  constructor(config: ProviderConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl =
      config.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
    this.defaultModel = config.defaultModel ?? DEFAULT_MODEL;
    this.timeout = config.timeout ?? 60000;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  getModels(): string[] {
    return [...GEMINI_MODELS];
  }

  getDefaultModel(): string {
    return this.defaultModel;
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<LLMResponse> {
    const model = options?.model ?? this.defaultModel;

    // Extract system message
    const systemMessage = messages.find((m) => m.role === 'system');
    const chatMessages = messages.filter((m) => m.role !== 'system');

    const requestBody: Record<string, unknown> = {
      contents: this.convertMessages(chatMessages),
    };

    // System instruction
    if (systemMessage) {
      requestBody['systemInstruction'] = {
        parts: [{ text: systemMessage.content }],
      };
    }

    // Generation config
    const generationConfig: Record<string, unknown> = {};
    if (options?.temperature !== undefined) {
      generationConfig['temperature'] = options.temperature;
    }
    if (options?.maxTokens !== undefined) {
      generationConfig['maxOutputTokens'] = options.maxTokens;
    }
    if (options?.stop) {
      generationConfig['stopSequences'] = options.stop;
    }
    if (Object.keys(generationConfig).length > 0) {
      requestBody['generationConfig'] = generationConfig;
    }

    // Tools
    if (options?.tools && options.tools.length > 0) {
      requestBody['tools'] = [this.convertTools(options.tools)];
    }

    const endpoint = `/models/${model}:generateContent`;
    const response = await this.makeRequest<GeminiResponse>(
      endpoint,
      requestBody,
      options?.signal
    );

    return this.convertResponse(response, model);
  }

  async *chatStream(
    messages: Message[],
    options?: ChatOptions
  ): AsyncGenerator<StreamChunk, void, undefined> {
    const model = options?.model ?? this.defaultModel;

    // Extract system message
    const systemMessage = messages.find((m) => m.role === 'system');
    const chatMessages = messages.filter((m) => m.role !== 'system');

    const requestBody: Record<string, unknown> = {
      contents: this.convertMessages(chatMessages),
    };

    if (systemMessage) {
      requestBody['systemInstruction'] = {
        parts: [{ text: systemMessage.content }],
      };
    }

    const generationConfig: Record<string, unknown> = {};
    if (options?.temperature !== undefined) {
      generationConfig['temperature'] = options.temperature;
    }
    if (options?.maxTokens !== undefined) {
      generationConfig['maxOutputTokens'] = options.maxTokens;
    }
    if (Object.keys(generationConfig).length > 0) {
      requestBody['generationConfig'] = generationConfig;
    }

    if (options?.tools && options.tools.length > 0) {
      requestBody['tools'] = [this.convertTools(options.tools)];
    }

    for await (const data of readSSEStream({
      url: `${this.baseUrl}/models/${model}:streamGenerateContent?alt=sse`,
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': this.apiKey,
      },
      body: requestBody,
      signal: options?.signal,
      providerName: 'Gemini',
    })) {
      try {
        const chunk = JSON.parse(data) as GeminiResponse;
        const candidate = chunk.candidates?.[0];
        if (!candidate) continue;

        for (const part of candidate.content.parts) {
          if ('text' in part) {
            yield { content: part.text, done: false };
          } else if ('functionCall' in part) {
            yield {
              toolCall: {
                id: `fc_${Date.now()}`,
                name: part.functionCall.name,
                arguments: part.functionCall.args,
              },
              done: false,
            };
          }
        }

        if (candidate.finishReason === 'STOP') {
          yield { done: true };
          return;
        }
      } catch {
        // Invalid JSON, skip line
      }
    }

    yield { done: true };
  }

  /**
   * Convert internal messages to Gemini format
   */
  private convertMessages(messages: Message[]): GeminiContent[] {
    const result: GeminiContent[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') continue;

      if (msg.role === 'tool') {
        // Function response
        result.push({
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: msg.toolName ?? 'unknown',
                response: this.parseToolResponse(msg.content),
              },
            },
          ],
        });
      } else {
        result.push({
          role: msg.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: msg.content }],
        });
      }
    }

    return result;
  }

  /**
   * Parse tool response content
   */
  private parseToolResponse(content: string): Record<string, unknown> {
    try {
      return JSON.parse(content) as Record<string, unknown>;
    } catch {
      return { result: content };
    }
  }

  /**
   * Convert tool definitions to Gemini format
   */
  private convertTools(
    tools: Array<{
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    }>
  ): GeminiTool {
    return {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    };
  }

  /**
   * Convert Gemini response to internal format
   */
  private convertResponse(response: GeminiResponse, model: string): LLMResponse {
    const candidate = response.candidates?.[0];
    if (!candidate) {
      throw new Error('No response candidate');
    }

    let content = '';
    const toolCalls: ToolCall[] = [];

    for (const part of candidate.content.parts) {
      if ('text' in part) {
        content += part.text;
      } else if ('functionCall' in part) {
        toolCalls.push({
          id: `fc_${Date.now()}_${toolCalls.length}`,
          name: part.functionCall.name,
          arguments: part.functionCall.args,
        });
      }
    }

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason: this.convertFinishReason(candidate.finishReason),
      usage: response.usageMetadata
        ? {
            promptTokens: response.usageMetadata.promptTokenCount,
            completionTokens: response.usageMetadata.candidatesTokenCount,
            totalTokens: response.usageMetadata.totalTokenCount,
          }
        : undefined,
      model,
    };
  }

  /**
   * Convert finish reason
   */
  private convertFinishReason(
    reason: 'STOP' | 'MAX_TOKENS' | 'SAFETY' | 'RECITATION' | 'OTHER'
  ): LLMResponse['finishReason'] {
    switch (reason) {
      case 'STOP':
        return 'stop';
      case 'MAX_TOKENS':
        return 'length';
      case 'SAFETY':
        return 'content_filter';
      default:
        return 'stop';
    }
  }

  /**
   * Make API request
   */
  private async makeRequest<T>(
    endpoint: string,
    body: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<T> {
    return makeProviderRequest<T>({
      url: `${this.baseUrl}${endpoint}`,
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': this.apiKey,
      },
      body,
      timeout: this.timeout,
      signal,
      providerName: 'Gemini',
    });
  }

}

/**
 * Create Gemini provider
 */
export function createGeminiProvider(config: ProviderConfig): LLMProvider {
  return new GeminiProvider(config);
}

// Register provider
registerProvider('gemini', createGeminiProvider);
