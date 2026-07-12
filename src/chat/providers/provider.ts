/**
 * LLM Provider Interface for mainwpcontrol
 *
 * Abstract interface for different LLM providers.
 * Supported: OpenAI, Anthropic, Gemini, OpenRouter, Local (OpenAI-compatible)
 */

/**
 * Message role in conversation
 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * Chat message
 */
export interface Message {
  role: MessageRole;
  content: string;
  /** Native assistant tool calls that must precede matching tool results */
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    /** Opaque Gemini thought signature pass-through; other providers ignore it. */
    thoughtSignature?: string;
  }>;
  /** Tool call ID (for tool responses) */
  toolCallId?: string;
  /** Tool name (for tool responses) */
  toolName?: string;
}

/**
 * Tool definition for function calling
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * Tool call from LLM
 */
export interface ToolCall {
  id: string;
  name: string;
  /** Kept unknown until the envelope parser proves it is an object */
  arguments: unknown;
  /** Opaque Gemini thought signature pass-through; other providers ignore it. */
  thoughtSignature?: string;
}

/**
 * LLM response
 */
export interface LLMResponse {
  /** Raw content from LLM */
  content: string;
  /** Parsed tool calls (if using function calling API) */
  toolCalls?: ToolCall[] | undefined;
  /** Finish reason */
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'error';
  /** Usage statistics */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  } | undefined;
  /** Model used */
  model: string;
}

/**
 * Chat options
 */
export interface ChatOptions {
  /** Model to use (provider-specific) */
  model?: string | undefined;
  /** Temperature (0-2) */
  temperature?: number | undefined;
  /** Maximum tokens in response */
  maxTokens?: number | undefined;
  /** Tool definitions for function calling */
  tools?: ToolDefinition[] | undefined;
  /** Whether to use streaming */
  stream?: boolean | undefined;
  /** Abort signal */
  signal?: AbortSignal | undefined;
  /** Stop sequences */
  stop?: string[] | undefined;
}

/**
 * Stream chunk for streaming responses
 */
export interface StreamChunk {
  /** Content delta */
  content?: string;
  /** Tool call delta */
  toolCall?: Partial<ToolCall>;
  /** Whether this is the final chunk */
  done: boolean;
}

/**
 * Provider configuration
 */
export interface ProviderConfig {
  /** API key */
  apiKey: string;
  /** Base URL (for custom endpoints) */
  baseUrl?: string | undefined;
  /** Default model */
  defaultModel?: string | undefined;
  /** Request timeout in ms */
  timeout?: number | undefined;
  /** Organization ID (OpenAI) */
  organization?: string | undefined;
}

/**
 * Supported provider names
 */
export const SUPPORTED_PROVIDER_NAMES = [
  'openai',
  'anthropic',
  'gemini',
  'openrouter',
  'local',
] as const;

export type ProviderName = typeof SUPPORTED_PROVIDER_NAMES[number];

export type ProviderSelectionSource = 'flag' | 'env' | 'settings' | 'auto' | 'none';

export interface ResolvedProviderSelection {
  name?: ProviderName;
  source: ProviderSelectionSource;
  configured: boolean;
  config: ProviderConfig;
  warnings: string[];
}

/**
 * Provider capabilities
 */
export interface ProviderCapabilities {
  /** Supports function calling */
  functionCalling: boolean;
  /** Supports streaming */
  streaming: boolean;
  /** Supports system messages */
  systemMessages: boolean;
  /** Supports vision/images */
  vision: boolean;
  /** Maximum context length */
  maxContextLength: number;
}

/**
 * LLM Provider interface
 */
export interface LLMProvider {
  /** Provider name */
  readonly name: string;

  /** Provider capabilities */
  readonly capabilities: ProviderCapabilities;

  /**
   * Send chat completion request
   */
  chat(messages: Message[], options?: ChatOptions): Promise<LLMResponse>;

  /**
   * Send chat completion request with streaming
   */
  chatStream?(
    messages: Message[],
    options?: ChatOptions
  ): AsyncGenerator<StreamChunk, void, undefined>;

  /**
   * Check if provider is configured
   */
  isConfigured(): boolean;

  /**
   * Get available models
   */
  getModels(): string[];

  /**
   * Get default model
   */
  getDefaultModel(): string;
}

/**
 * Provider factory function type
 */
export type ProviderFactory = (config: ProviderConfig) => LLMProvider;

/**
 * Provider registry
 */
const providers = new Map<string, ProviderFactory>();

/**
 * Register a provider factory
 */
export function registerProvider(name: string, factory: ProviderFactory): void {
  providers.set(name.toLowerCase(), factory);
}

/**
 * Get a provider factory
 */
export function getProviderFactory(name: string): ProviderFactory | undefined {
  return providers.get(name.toLowerCase());
}

/**
 * List registered providers
 */
export function listProviders(): string[] {
  return Array.from(providers.keys());
}

/**
 * Check whether a provider name is supported.
 */
export function isSupportedProviderName(value: string): value is ProviderName {
  return (SUPPORTED_PROVIDER_NAMES as readonly string[]).includes(value.toLowerCase());
}

/**
 * Create a provider from config
 */
export function createProvider(name: string, config: ProviderConfig): LLMProvider {
  const factory = getProviderFactory(name);
  if (!factory) {
    throw new Error(`Unknown provider: ${name}. Available: ${listProviders().join(', ')}`);
  }
  return factory(config);
}

/**
 * Provider environment variable names
 */
export const PROVIDER_ENV_VARS: Record<string, { key: string; url?: string }> = {
  openai: { key: 'OPENAI_API_KEY' },
  anthropic: { key: 'ANTHROPIC_API_KEY' },
  gemini: { key: 'GOOGLE_API_KEY' },
  openrouter: { key: 'OPENROUTER_API_KEY' },
  local: { key: 'LOCAL_LLM_API_KEY', url: 'LOCAL_LLM_URL' },
};

/**
 * Get provider config from environment
 */
export function getProviderConfigFromEnv(
  providerName: string
): Partial<ProviderConfig> | undefined {
  const envConfig = PROVIDER_ENV_VARS[providerName.toLowerCase()];
  if (!envConfig) return undefined;

  const apiKey = process.env[envConfig.key];
  if (!apiKey) return undefined;

  const config: Partial<ProviderConfig> = { apiKey };

  if (envConfig.url) {
    const baseUrl = process.env[envConfig.url];
    if (baseUrl) {
      config.baseUrl = baseUrl;
    }
  }

  return config;
}

/**
 * Resolve the effective provider selection and merged configuration.
 */
export function resolveProviderSelection(options: {
  flagProvider?: string | undefined;
  envProvider?: string | undefined;
  settingsProvider?: string | undefined;
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  model?: string | undefined;
  timeout?: number | undefined;
}): ResolvedProviderSelection {
  const warnings: string[] = [];

  const preferredCandidates: Array<{ value: string | undefined; source: ProviderSelectionSource }> = [
    { value: options.flagProvider, source: 'flag' },
    { value: options.envProvider, source: 'env' },
    { value: options.settingsProvider, source: 'settings' },
  ];

  let selectedName: ProviderName | undefined;
  let source: ProviderSelectionSource = 'none';

  for (const candidate of preferredCandidates) {
    if (!candidate.value) continue;

    const normalized = candidate.value.trim().toLowerCase();
    if (!isSupportedProviderName(normalized)) {
      warnings.push(
        `Ignoring unsupported LLM provider "${candidate.value}". Available: ${SUPPORTED_PROVIDER_NAMES.join(', ')}`
      );
      continue;
    }

    selectedName = normalized;
    source = candidate.source;
    break;
  }

  if (!selectedName) {
    const detected = detectConfiguredProvider();
    if (detected && isSupportedProviderName(detected)) {
      selectedName = detected;
      source = 'auto';
    }
  }

  if (!selectedName) {
    return {
      source: 'none',
      configured: false,
      config: {
        apiKey: '',
        timeout: options.timeout,
      },
      warnings,
    };
  }

  const envConfig = getProviderConfigFromEnv(selectedName) ?? {};
  const apiKey = options.apiKey ?? envConfig.apiKey ?? '';
  const baseUrl = options.baseUrl ?? envConfig.baseUrl;

  return {
    name: selectedName,
    source,
    configured: Boolean(apiKey),
    config: {
      apiKey,
      baseUrl,
      defaultModel: options.model,
      timeout: options.timeout,
    },
    warnings,
  };
}

/**
 * Auto-detect configured provider from environment
 */
export function detectConfiguredProvider(): string | undefined {
  // Priority order
  const priority: ProviderName[] = ['anthropic', 'openai', 'gemini', 'openrouter', 'local'];

  for (const provider of priority) {
    const config = getProviderConfigFromEnv(provider);
    if (config?.apiKey) {
      return provider;
    }
  }

  return undefined;
}

/**
 * Split the system message from the chat messages.
 *
 * Providers that carry the system prompt out-of-band (Anthropic's `system`
 * field, Gemini's `systemInstruction`) share this instead of re-implementing
 * the extraction.
 */
export function splitSystemMessage(messages: Message[]): {
  systemContent: string | undefined;
  chatMessages: Message[];
} {
  const systemMessage = messages.find((m) => m.role === 'system');
  return {
    systemContent: systemMessage?.content,
    chatMessages: messages.filter((m) => m.role !== 'system'),
  };
}

/**
 * Convert ability schema to tool definition
 */
export function abilityToTool(
  name: string,
  description: string,
  inputSchema: Record<string, unknown> | undefined
): ToolDefinition {
  return {
    name,
    description,
    parameters: inputSchema ?? { type: 'object', properties: {} },
  };
}
