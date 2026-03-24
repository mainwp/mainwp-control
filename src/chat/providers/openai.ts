/**
 * OpenAI Provider for mainwpcontrol
 *
 * Implements LLM provider interface for OpenAI GPT models.
 */

import {
  type LLMProvider,
  type ProviderConfig,
  type ProviderCapabilities,
  registerProvider,
} from './provider.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';

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
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/**
 * OpenAI provider implementation
 */
export class OpenAIProvider extends OpenAICompatibleProvider {
  readonly name = 'openai';
  readonly capabilities: ProviderCapabilities = {
    functionCalling: true,
    streaming: true,
    systemMessages: true,
    vision: true,
    maxContextLength: 128000, // GPT-4o
  };

  private readonly organization: string | undefined;

  constructor(config: ProviderConfig) {
    super(config, { baseUrl: DEFAULT_BASE_URL, model: DEFAULT_MODEL });
    this.organization = config.organization;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  getModels(): string[] {
    return [...OPENAI_MODELS];
  }

  protected getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };

    if (this.organization) {
      headers['OpenAI-Organization'] = this.organization;
    }

    return headers;
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
