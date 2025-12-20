/**
 * Chat Engine for mainwpctl
 *
 * LLM interaction loop with safety enforcement.
 *
 * CRITICAL INVARIANTS (from PLAN.md, CHAT_PROMPT.md):
 * - AI proposes tool calls; ChatEngine executes via AbilitiesExecutor
 * - AI NEVER executes directly
 * - Destructive actions always preview first
 * - Max tool calls per turn enforced
 * - JSON retry logic (max 2 retries)
 */

import type {
  LLMProvider,
  Message,
  ChatOptions,
  ToolDefinition,
} from './providers/provider.js';
import {
  buildConfiguredPrompt,
  type SystemPromptConfig,
  defaultConfig as defaultPromptConfig,
} from './system-prompt.js';
import {
  parseResponse,
  isRetryable,
  buildRetryPrompt,
} from './tool-envelope.js';
import {
  type AbilitiesExecutor,
  type Ability,
  type ExecutionResult,
} from '../core/abilities-executor.js';
import {
  SafetyController,
  type PreviewResult,
} from '../core/safety-controller.js';
import { abilityToTool } from './providers/provider.js';

/**
 * Chat response types
 */
export type ChatResponse =
  | { type: 'message'; content: string }
  | {
      type: 'tool_result';
      tool: string;
      result: ExecutionResult;
      preview?: PreviewResult;
    }
  | { type: 'preview'; preview: PreviewResult; requiresApproval: boolean }
  | { type: 'error'; error: string };

/**
 * Chat engine options
 */
export interface ChatEngineOptions {
  /** LLM provider */
  provider: LLMProvider;
  /** Abilities executor */
  executor: AbilitiesExecutor;
  /** Maximum tool calls per turn */
  maxToolCallsPerTurn?: number;
  /** Maximum JSON parse retries */
  maxParseRetries?: number;
  /** Model to use */
  model?: string;
  /** Temperature */
  temperature?: number;
  /** System prompt config */
  promptConfig?: Partial<SystemPromptConfig>;
}

/**
 * Pending preview state
 */
interface PendingPreview {
  ability: Ability;
  input: Record<string, unknown>;
  preview: PreviewResult;
}

/**
 * Chat engine class
 *
 * SAFETY: All execution flows through SafetyController and AbilitiesExecutor.
 * ChatEngine never bypasses safety checks.
 */
export class ChatEngine {
  private readonly provider: LLMProvider;
  private readonly executor: AbilitiesExecutor;
  private readonly safetyController: SafetyController;
  private readonly maxToolCallsPerTurn: number;
  private readonly maxParseRetries: number;
  private readonly model: string | undefined;
  private readonly temperature: number | undefined;
  private readonly promptConfig: SystemPromptConfig;

  private messages: Message[] = [];
  private abilities: Ability[] = [];
  private tools: ToolDefinition[] = [];
  private pendingPreview: PendingPreview | null = null;
  private initialized = false;

  constructor(options: ChatEngineOptions) {
    this.provider = options.provider;
    this.executor = options.executor;
    this.safetyController = new SafetyController();
    this.maxToolCallsPerTurn = options.maxToolCallsPerTurn ?? 3;
    this.maxParseRetries = options.maxParseRetries ?? 2;
    this.model = options.model;
    this.temperature = options.temperature;
    this.promptConfig = {
      ...defaultPromptConfig,
      ...options.promptConfig,
      maxToolCalls: options.maxToolCallsPerTurn ?? defaultPromptConfig.maxToolCalls,
      maxParseRetries: options.maxParseRetries ?? defaultPromptConfig.maxParseRetries,
    };
  }

  /**
   * Initialize the chat session
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Load abilities
    this.abilities = await this.executor.listAbilities();

    // Convert to tool definitions
    this.tools = this.abilities.map((a) =>
      abilityToTool(a.name, a.description, a.input_schema)
    );

    // Build system prompt
    const systemPrompt = buildConfiguredPrompt(this.abilities, this.promptConfig);

    // Initialize message history
    this.messages = [{ role: 'system', content: systemPrompt }];

    this.initialized = true;
  }

  /**
   * Send a user message and process the response
   */
  async sendMessage(userMessage: string): Promise<ChatResponse[]> {
    if (!this.initialized) {
      await this.initialize();
    }

    // Handle pending preview approval
    if (this.pendingPreview) {
      return this.handlePreviewResponse(userMessage);
    }

    // Add user message
    this.messages.push({ role: 'user', content: userMessage });

    // Process with LLM
    return this.processLLMResponse();
  }

  /**
   * Handle response to a pending preview
   */
  private async handlePreviewResponse(
    userMessage: string
  ): Promise<ChatResponse[]> {
    const preview = this.pendingPreview!;
    this.pendingPreview = null;

    const lower = userMessage.toLowerCase().trim();
    const approved =
      lower === 'yes' ||
      lower === 'y' ||
      lower === 'approve' ||
      lower === 'confirm';

    if (!approved) {
      // User declined
      this.messages.push({
        role: 'user',
        content: userMessage,
      });
      this.messages.push({
        role: 'assistant',
        content: JSON.stringify({
          answer:
            'Operation cancelled. The destructive action was not executed.',
        }),
      });

      return [
        {
          type: 'message',
          content: 'Operation cancelled. The destructive action was not executed.',
        },
      ];
    }

    // User approved - execute with confirm
    this.messages.push({
      role: 'user',
      content: 'User approved: yes',
    });

    const result = await this.executor.execute(
      preview.ability.name,
      preview.input,
      { confirm: true }
    );

    // Add result to context
    const toolResultMsg = {
      role: 'tool' as const,
      content: JSON.stringify(result),
      toolCallId: `execute_${preview.ability.name}`,
      toolName: preview.ability.name,
    };
    this.messages.push(toolResultMsg);

    return [
      {
        type: 'tool_result',
        tool: preview.ability.name,
        result,
        preview: preview.preview,
      },
    ];
  }

  /**
   * Process LLM response with tool calling loop
   */
  private async processLLMResponse(): Promise<ChatResponse[]> {
    const responses: ChatResponse[] = [];
    let toolCallCount = 0;
    let retryCount = 0;

    while (toolCallCount < this.maxToolCallsPerTurn) {
      // Call LLM
      const chatOptions: ChatOptions = {
        model: this.model,
        temperature: this.temperature,
        tools: this.tools,
      };

      const llmResponse = await this.provider.chat(this.messages, chatOptions);

      // Parse response
      const parseResult = parseResponse(llmResponse, {
        abilities: this.abilities,
        validateToolExists: true,
      });

      // Handle parse errors with retry
      if (parseResult.response.type === 'error') {
        if (isRetryable(parseResult) && retryCount < this.maxParseRetries) {
          retryCount++;
          // Add retry prompt
          this.messages.push({
            role: 'assistant',
            content: llmResponse.content,
          });
          this.messages.push({
            role: 'user',
            content: buildRetryPrompt(parseResult),
          });
          continue;
        }

        // Unrecoverable error
        responses.push({
          type: 'error',
          error: parseResult.response.error,
        });
        break;
      }

      retryCount = 0; // Reset on successful parse

      // Handle answer
      if (parseResult.response.type === 'answer') {
        this.messages.push({
          role: 'assistant',
          content: llmResponse.content,
        });
        responses.push({
          type: 'message',
          content: parseResult.response.answer,
        });
        break;
      }

      // Handle tool call
      const toolResponse = parseResult.response;
      toolCallCount++;

      // Add assistant message with tool call
      this.messages.push({
        role: 'assistant',
        content: llmResponse.content,
      });

      // Execute tool
      const toolResult = await this.executeTool(
        toolResponse.tool,
        toolResponse.input
      );

      if (toolResult.type === 'preview') {
        // Preview requires user approval - stop here
        responses.push(toolResult);
        break;
      }

      responses.push(toolResult);

      // Add tool result to context
      if (toolResult.type === 'tool_result') {
        const resultContent =
          toolResult.result.success
            ? JSON.stringify(toolResult.result.data)
            : JSON.stringify(toolResult.result.error);

        this.messages.push({
          role: 'tool',
          content: resultContent,
          toolCallId: toolResponse.id ?? `call_${toolCallCount}`,
          toolName: toolResponse.tool,
        });
      } else if (toolResult.type === 'error') {
        this.messages.push({
          role: 'tool',
          content: JSON.stringify({ error: toolResult.error }),
          toolCallId: toolResponse.id ?? `call_${toolCallCount}`,
          toolName: toolResponse.tool,
        });
        break; // Stop on error
      }
    }

    // If we hit max tool calls, add a notice
    if (toolCallCount >= this.maxToolCallsPerTurn) {
      responses.push({
        type: 'message',
        content: `Reached maximum tool calls (${this.maxToolCallsPerTurn}). Please continue if needed.`,
      });
    }

    return responses;
  }

  /**
   * Execute a tool with safety checks
   *
   * CRITICAL: All execution goes through SafetyController
   */
  private async executeTool(
    toolName: string,
    input: Record<string, unknown>
  ): Promise<ChatResponse> {
    // Find ability
    const ability = await this.executor.getAbility(toolName);
    if (!ability) {
      return {
        type: 'error',
        error: `Unknown ability: ${toolName}`,
      };
    }

    // Check if destructive
    const classification = this.safetyController.classify(ability);

    if (classification.requiresSafetyFlow) {
      // SAFETY: Destructive actions always preview first
      // AI cannot skip this step
      return this.executeWithPreview(ability, input);
    }

    // Safe to execute directly
    try {
      const result = await this.executor.execute(ability.name, input);
      return {
        type: 'tool_result',
        tool: ability.name,
        result,
      };
    } catch (error) {
      return {
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Execute destructive action with preview
   */
  private async executeWithPreview(
    ability: Ability,
    input: Record<string, unknown>
  ): Promise<ChatResponse> {
    try {
      // Execute with dry_run
      const previewResult = await this.executor.execute(
        ability.name,
        input,
        { dryRun: true }
      );

      if (!previewResult.success) {
        return {
          type: 'error',
          error: previewResult.error?.message ?? 'Preview failed',
        };
      }

      // Format preview
      const preview = this.safetyController.formatPreviewResult(
        ability,
        input,
        previewResult
      );

      // Store pending preview for approval
      this.pendingPreview = { ability, input, preview };

      return {
        type: 'preview',
        preview,
        requiresApproval: true,
      };
    } catch (error) {
      return {
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Check if there's a pending preview awaiting approval
   */
  hasPendingPreview(): boolean {
    return this.pendingPreview !== null;
  }

  /**
   * Get the pending preview
   */
  getPendingPreview(): PreviewResult | null {
    return this.pendingPreview?.preview ?? null;
  }

  /**
   * Cancel pending preview
   */
  cancelPendingPreview(): void {
    this.pendingPreview = null;
  }

  /**
   * Get conversation history (for debugging)
   */
  getHistory(): Message[] {
    return [...this.messages];
  }

  /**
   * Clear conversation history (keep system prompt)
   */
  clearHistory(): void {
    if (this.messages.length > 0) {
      const systemPrompt = this.messages[0];
      if (systemPrompt) {
        this.messages = [systemPrompt];
      }
    }
    this.pendingPreview = null;
  }

  /**
   * Get loaded abilities
   */
  getAbilities(): Ability[] {
    return [...this.abilities];
  }

  /**
   * Get provider info
   */
  getProviderInfo(): { name: string; model: string } {
    return {
      name: this.provider.name,
      model: this.model ?? this.provider.getDefaultModel(),
    };
  }
}

/**
 * Create a chat engine
 */
export function createChatEngine(options: ChatEngineOptions): ChatEngine {
  return new ChatEngine(options);
}
