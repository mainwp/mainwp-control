/**
 * Local LLM Provider for mainwpctl
 *
 * Implements LLM provider interface for OpenAI-compatible local endpoints.
 * Supports llama.cpp, Ollama, LM Studio, and other OpenAI-compatible servers.
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
 * OpenAI-compatible message format
 */
interface LocalMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: LocalToolCall[];
  tool_call_id?: string;
}

interface LocalToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface LocalTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface LocalResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: LocalToolCall[];
    };
    finish_reason: 'stop' | 'tool_calls' | 'length';
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface LocalStreamChunk {
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
    finish_reason: 'stop' | 'tool_calls' | 'length' | null;
  }>;
}

const DEFAULT_BASE_URL = 'http://localhost:8080/v1';
const DEFAULT_MODEL = 'local';

/**
 * Local LLM provider implementation
 */
export class LocalProvider implements LLMProvider {
  readonly name = 'local';
  readonly capabilities: ProviderCapabilities = {
    functionCalling: true, // May vary by server
    streaming: true,
    systemMessages: true,
    vision: false, // Typically not supported
    maxContextLength: 8192, // Default, varies by model
  };

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly timeout: number;

  constructor(config: ProviderConfig) {
    this.apiKey = config.apiKey || 'not-needed';
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.defaultModel = config.defaultModel ?? DEFAULT_MODEL;
    this.timeout = config.timeout ?? 120000; // Longer timeout for local
  }

  isConfigured(): boolean {
    // Local providers don't necessarily need an API key
    return Boolean(this.baseUrl);
  }

  getModels(): string[] {
    // Local models are dynamic, return default
    return [this.defaultModel];
  }

  getDefaultModel(): string {
    return this.defaultModel;
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<LLMResponse> {
    const model = options?.model ?? this.defaultModel;
    const localMessages = this.convertMessages(messages);

    const requestBody: Record<string, unknown> = {
      model,
      messages: localMessages,
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

    // Only add tools if the server supports it
    if (options?.tools && options.tools.length > 0) {
      requestBody['tools'] = this.convertTools(options.tools);
      requestBody['tool_choice'] = 'auto';
    }

    try {
      const response = await this.makeRequest<LocalResponse>(
        '/chat/completions',
        requestBody,
        options?.signal
      );
      return this.convertResponse(response);
    } catch (error) {
      // If function calling fails, try without tools
      if (
        options?.tools &&
        error instanceof Error &&
        error.message.includes('tool')
      ) {
        // Retry without tools, embedding tool info in system prompt
        const messagesWithToolInfo = this.embedToolsInSystemPrompt(
          messages,
          options.tools
        );
        const fallbackBody = {
          model,
          messages: this.convertMessages(messagesWithToolInfo),
          temperature: options?.temperature,
          max_tokens: options?.maxTokens,
          stop: options?.stop,
        };
        const response = await this.makeRequest<LocalResponse>(
          '/chat/completions',
          fallbackBody,
          options?.signal
        );
        return this.convertResponse(response);
      }
      throw error;
    }
  }

  async *chatStream(
    messages: Message[],
    options?: ChatOptions
  ): AsyncGenerator<StreamChunk, void, undefined> {
    const model = options?.model ?? this.defaultModel;
    const localMessages = this.convertMessages(messages);

    const requestBody: Record<string, unknown> = {
      model,
      messages: localMessages,
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
      throw new Error(`Local LLM API error: ${response.status} ${error}`);
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
          const chunk = JSON.parse(data) as LocalStreamChunk;
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
                  id: tc.id ?? `tc_${Date.now()}_${tc.index}`,
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

  /**
   * Embed tool definitions in system prompt for servers without function calling
   */
  private embedToolsInSystemPrompt(
    messages: Message[],
    tools: Array<{
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    }>
  ): Message[] {
    const toolInfo = tools
      .map(
        (t) =>
          `- ${t.name}: ${t.description}\n  Parameters: ${JSON.stringify(t.parameters, null, 2)}`
      )
      .join('\n');

    const toolPrompt = `
You have access to the following tools. To use a tool, respond with a JSON object in this format:
{ "tool": "<tool_name>", "input": { <parameters> } }

Available tools:
${toolInfo}

If you don't need to use a tool, respond with:
{ "answer": "<your response>" }
`;

    const result = [...messages];
    const systemIdx = result.findIndex((m) => m.role === 'system');

    if (systemIdx >= 0) {
      const existingMsg = result[systemIdx];
      if (existingMsg) {
        const updatedMsg: Message = {
          role: existingMsg.role,
          content: existingMsg.content + '\n\n' + toolPrompt,
        };
        if (existingMsg.toolCallId) {
          updatedMsg.toolCallId = existingMsg.toolCallId;
        }
        if (existingMsg.toolName) {
          updatedMsg.toolName = existingMsg.toolName;
        }
        result[systemIdx] = updatedMsg;
      }
    } else {
      result.unshift({
        role: 'system',
        content: toolPrompt,
      });
    }

    return result;
  }

  private convertMessages(messages: Message[]): LocalMessage[] {
    return messages.map((msg) => {
      const base: LocalMessage = {
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
  ): LocalTool[] {
    return tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  private convertResponse(response: LocalResponse): LLMResponse {
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

  private parseArguments(args: string): Record<string, unknown> {
    try {
      return JSON.parse(args) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private convertFinishReason(
    reason: 'stop' | 'tool_calls' | 'length'
  ): LLMResponse['finishReason'] {
    return reason;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.apiKey && this.apiKey !== 'not-needed') {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    return headers;
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
        throw new Error(`Local LLM API error: ${response.status} ${error}`);
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
 * Create Local provider
 */
export function createLocalProvider(config: ProviderConfig): LLMProvider {
  return new LocalProvider(config);
}

// Register provider
registerProvider('local', createLocalProvider);
