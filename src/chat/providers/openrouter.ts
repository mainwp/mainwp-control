/**
 * OpenRouter Provider for mainwpctl
 *
 * Implements LLM provider interface for OpenRouter.
 * OpenRouter provides access to multiple models through a unified API
 * that's compatible with OpenAI's format.
 */

import {
  type LLMProvider,
  type ProviderConfig,
  type ProviderCapabilities,
  registerProvider,
} from './provider.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';

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
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * OpenRouter provider implementation
 */
export class OpenRouterProvider extends OpenAICompatibleProvider {
  readonly name = 'openrouter';
  readonly capabilities: ProviderCapabilities = {
    functionCalling: true,
    streaming: true,
    systemMessages: true,
    vision: true,
    maxContextLength: 200000, // Varies by model
  };

  private readonly appName: string;

  constructor(config: ProviderConfig) {
    super(config, { baseUrl: DEFAULT_BASE_URL, model: DEFAULT_MODEL });
    this.appName = 'mainwpctl';
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  getModels(): string[] {
    return [...OPENROUTER_MODELS];
  }

  protected getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      'HTTP-Referer': 'https://github.com/mainwp/mainwp-control',
      'X-Title': this.appName,
    };
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
