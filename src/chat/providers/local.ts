/**
 * Local LLM Provider for mainwpcontrol
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
  registerProvider,
} from './provider.js';
import {
  OpenAICompatibleProvider,
  type OpenAICompatibleResponse,
} from './openai-compatible.js';

const DEFAULT_BASE_URL = 'http://localhost:8080/v1';
const DEFAULT_MODEL = 'local';

/**
 * Local LLM provider implementation
 */
export class LocalProvider extends OpenAICompatibleProvider {
  readonly name = 'local';
  readonly capabilities: ProviderCapabilities = {
    functionCalling: true, // May vary by server
    streaming: true,
    systemMessages: true,
    vision: false, // Typically not supported
    maxContextLength: 8192, // Default, varies by model
  };

  constructor(config: ProviderConfig) {
    super(
      { ...config, apiKey: config.apiKey || 'not-needed' },
      { baseUrl: DEFAULT_BASE_URL, model: DEFAULT_MODEL, timeout: 120000 }
    );
  }

  isConfigured(): boolean {
    // Local providers don't necessarily need an API key
    return Boolean(this.baseUrl);
  }

  getModels(): string[] {
    // Local models are dynamic, return default
    return [this.defaultModel];
  }

  protected getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.apiKey && this.apiKey !== 'not-needed') {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    return headers;
  }

  /**
   * Override chat to add tool-embedding fallback for servers without function calling
   */
  async chat(messages: Message[], options?: ChatOptions): Promise<LLMResponse> {
    try {
      return await super.chat(messages, options);
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
        const model = options?.model ?? this.defaultModel;
        const fallbackBody: Record<string, unknown> = {
          model,
          messages: this.convertMessages(messagesWithToolInfo),
          temperature: options?.temperature,
          max_tokens: options?.maxTokens,
          stop: options?.stop,
        };
        const response = await this.makeRequest<OpenAICompatibleResponse>(
          '/chat/completions',
          fallbackBody,
          options?.signal
        );
        return this.convertResponse(response);
      }
      throw error;
    }
  }

  /**
   * Generate a tool call ID for streaming when the server doesn't provide one.
   * Local servers often omit tool call IDs.
   */
  protected override getStreamToolCallId(index: number): string {
    return `tc_${Date.now()}_${index}`;
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
}

/**
 * Create Local provider
 */
export function createLocalProvider(config: ProviderConfig): LLMProvider {
  return new LocalProvider(config);
}

// Register provider
registerProvider('local', createLocalProvider);
