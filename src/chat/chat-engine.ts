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
  LLMResponse,
  Message,
  ChatOptions,
  ToolDefinition,
  StreamChunk,
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
import { logDestructiveActionSafe } from '../utils/audit-logger.js';

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
  /** Maximum messages to keep in context (excluding system prompt). undefined = no limit */
  maxContextMessages?: number;
  /** Maximum estimated tokens in context. Reserved for future use. */
  maxContextTokens?: number;
  /** Whether to use streaming responses (default: false) */
  stream?: boolean;
  /** Callback for streaming content chunks (called as content arrives) */
  onStreamChunk?: (content: string) => void;
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
 *
 * Context window management: The engine maintains a sliding window of messages
 * to prevent unbounded memory growth. The system prompt is always preserved,
 * and message coherence (user-assistant pairs, tool call-result pairs) is maintained.
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
  private readonly maxContextMessages: number | undefined;
  private readonly stream: boolean;
  private readonly onStreamChunk?: (content: string) => void;

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
    this.stream = options.stream ?? false;
    // Only assign if defined to satisfy exactOptionalPropertyTypes
    if (options.onStreamChunk !== undefined) {
      this.onStreamChunk = options.onStreamChunk;
    }

    // Build prompt config, handling optional properties correctly
    const mergedPromptConfig: SystemPromptConfig = {
      ...defaultPromptConfig,
      ...options.promptConfig,
      maxToolCalls: options.maxToolCallsPerTurn ?? defaultPromptConfig.maxToolCalls,
      maxParseRetries: options.maxParseRetries ?? defaultPromptConfig.maxParseRetries,
    };

    // Context window configuration: resolve from options, promptConfig, or default
    // This ensures the default limit (20) is applied unless explicitly overridden
    const resolvedContextMessages =
      options.maxContextMessages ??
      options.promptConfig?.maxContextMessages ??
      defaultPromptConfig.maxContextMessages;

    this.maxContextMessages = resolvedContextMessages;

    // Sync the resolved value into promptConfig for system prompt generation
    if (resolvedContextMessages !== undefined) {
      mergedPromptConfig.maxContextMessages = resolvedContextMessages;
    }

    // Handle optional token limit (reserved for future use)
    const contextTokens = options.maxContextTokens ?? options.promptConfig?.maxContextTokens;
    if (contextTokens !== undefined) {
      mergedPromptConfig.maxContextTokens = contextTokens;
    }

    this.promptConfig = mergedPromptConfig;
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

    // Truncate BEFORE LLM call to ensure the LLM sees a bounded context
    // This prevents sending unbounded history to the provider
    this.truncateHistory();

    // Process with LLM
    const responses = await this.processLLMResponse();

    // Truncate again after processing for storage (handles messages added during tool calling)
    this.truncateHistory();

    return responses;
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

      // Log audit entry for declined action (fire-and-forget)
      await logDestructiveActionSafe({
        abilityName: preview.ability.name,
        preview: {
          summary: preview.preview.summary,
          affectedCount: preview.preview.affected.length,
        },
        userDecision: 'declined',
        input: preview.input,
      });

      // Truncate after preview resolution (safe boundary)
      this.truncateHistory();

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

    // Log audit entry for approved and executed action (fire-and-forget)
    const executionAudit: { success: boolean; error?: string } = {
      success: result.success,
    };
    if (result.error?.message) {
      executionAudit.error = result.error.message;
    }
    await logDestructiveActionSafe({
      abilityName: preview.ability.name,
      preview: {
        summary: preview.preview.summary,
        affectedCount: preview.preview.affected.length,
      },
      userDecision: 'approved',
      execution: executionAudit,
      input: preview.input,
    });

    // Add result to context
    const toolResultMsg = {
      role: 'tool' as const,
      content: JSON.stringify(result),
      toolCallId: `execute_${preview.ability.name}`,
      toolName: preview.ability.name,
    };
    this.messages.push(toolResultMsg);

    // Truncate after preview resolution (safe boundary)
    this.truncateHistory();

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

      // Get LLM response (streaming or non-streaming)
      let llmResponse: LLMResponse;
      if (this.stream && this.provider.chatStream && this.provider.capabilities.streaming) {
        const stream = this.provider.chatStream(this.messages, chatOptions);
        llmResponse = await this.accumulateStream(stream);
      } else {
        llmResponse = await this.provider.chat(this.messages, chatOptions);
      }

      // Don't process tool calls from interrupted streams — arguments may be incomplete
      if (llmResponse.finishReason === 'error') {
        responses.push({
          type: 'error',
          error: 'Response interrupted — please try again',
        });
        break;
      }

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

        // Truncate between tool-call iterations to enforce context limit
        // This ensures each provider.chat call receives a bounded history
        // Note: truncateHistory() already skips when pendingPreview is set
        this.truncateHistory();
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
   * Accumulate streaming chunks into a complete LLM response.
   * This method consumes an AsyncGenerator<StreamChunk> and reconstructs
   * a complete LLMResponse compatible with the existing parseResponse() logic.
   *
   * @param stream - The streaming generator from the provider
   * @returns A complete LLMResponse with accumulated content and tool calls
   */
  private async accumulateStream(
    stream: AsyncGenerator<StreamChunk, void, undefined>
  ): Promise<LLMResponse> {
    let content = '';
    // Providers yield complete tool calls (not deltas), so we collect them directly
    const toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];

    try {
      for await (const chunk of stream) {
        // Handle content chunks
        if (chunk.content) {
          content += chunk.content;
          // Call callback for progressive display
          if (this.onStreamChunk) {
            this.onStreamChunk(chunk.content);
          }
        }

        // Handle tool call chunks - providers yield each complete tool call as a separate chunk
        // before the done chunk, so push each one immediately
        if (chunk.toolCall && chunk.toolCall.id && chunk.toolCall.name) {
          toolCalls.push({
            id: chunk.toolCall.id,
            name: chunk.toolCall.name,
            arguments: chunk.toolCall.arguments ?? {},
          });
        }

        // When done flag is set, we've collected all tool calls
        if (chunk.done) {
          break;
        }
      }
    } catch (error) {
      // If streaming fails mid-response, return what we have so far
      if (content || toolCalls.length > 0) {
        console.error(
          `[ChatEngine] Stream interrupted: ${error instanceof Error ? error.message : String(error)}`
        );
        return {
          content,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          finishReason: 'error',
          model: this.provider.getDefaultModel(),
        };
      }
      // If no content accumulated, re-throw
      throw error;
    }

    // Return accumulated LLMResponse
    const parsedToolCalls = toolCalls;

    return {
      content,
      toolCalls: parsedToolCalls.length > 0 ? parsedToolCalls : undefined,
      finishReason: parsedToolCalls.length > 0 ? 'tool_calls' : 'stop',
      model: this.provider.getDefaultModel(),
    };
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
   * Get message count (excluding system prompt)
   */
  private getMessageCount(): number {
    return this.messages.length - 1;
  }

  /**
   * Estimate tokens for a set of messages using character count as a rough proxy.
   * Uses character_count / 4 as a heuristic (common approximation for English text).
   *
   * NOTE: This is a rough estimate. Actual token counts from LLMResponse.usage
   * are more accurate when available.
   *
   * @param messages - Messages to estimate tokens for
   * @returns Estimated token count
   */
  private estimateTokens(messages: Message[]): number {
    let totalChars = 0;
    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        totalChars += msg.content.length;
      }
    }
    // Character count / 4 is a common heuristic for English text tokenization
    return Math.ceil(totalChars / 4);
  }

  /**
   * Check if context truncation should occur based on message count limits.
   * Token-based limits are reserved for future implementation.
   *
   * @returns true if truncation should occur, false if:
   *   - maxContextMessages is undefined (no limit)
   *   - maxContextMessages is 0 (explicit unlimited)
   *   - message count is within limit
   */
  private shouldTruncate(): boolean {
    if (this.maxContextMessages === undefined || this.maxContextMessages === 0) {
      return false; // No limit configured or explicitly unlimited
    }
    return this.getMessageCount() > this.maxContextMessages;
  }

  /**
   * Find the index where truncation should start, respecting message boundaries.
   * This ensures we keep complete user-assistant exchanges and tool call-result pairs.
   *
   * @returns Index in the messages array where truncation should start (exclusive of system prompt)
   */
  private findTruncationPoint(): number {
    if (this.maxContextMessages === undefined || this.maxContextMessages <= 0) {
      return 1; // Keep only system prompt
    }

    // Calculate how many messages to keep (plus 1 for system prompt)
    const targetLength = this.maxContextMessages + 1;

    if (this.messages.length <= targetLength) {
      return this.messages.length; // No truncation needed
    }

    // Start from where we'd ideally cut
    const idealTruncationIndex = this.messages.length - this.maxContextMessages;

    // Ensure we don't cut the system prompt
    let truncationIndex = Math.max(1, idealTruncationIndex);

    // Walk forward to find a safe boundary (start of a user message)
    // This ensures we don't split:
    // - user message + assistant response
    // - tool call + tool result
    // - retry prompts from their original failed attempt
    const maxSearchIndex = this.messages.length;
    while (truncationIndex < maxSearchIndex) {
      const msg = this.messages[truncationIndex];
      // Safe to cut at the start of a user message
      if (msg && msg.role === 'user') {
        break;
      }
      truncationIndex++;
    }

    // Fallback: if no user boundary found, keep at least maxContextMessages
    // This ensures we don't drop all messages when the limit is very small
    if (truncationIndex >= this.messages.length) {
      truncationIndex = Math.max(1, idealTruncationIndex);
    }

    return truncationIndex;
  }

  /**
   * Truncate message history using a sliding window approach.
   * Preserves:
   * - System prompt (always first message)
   * - Messages since pending preview (if any)
   * - Most recent N messages where N = maxContextMessages
   * - Complete message exchanges (user-assistant, tool call-result pairs)
   */
  private truncateHistory(): void {
    if (!this.shouldTruncate()) {
      return;
    }

    // Safety: Never truncate if there's a pending preview
    // This preserves context for the approval decision
    if (this.pendingPreview !== null) {
      return;
    }

    const systemPrompt = this.messages[0];
    if (!systemPrompt) {
      return;
    }

    const truncationIndex = this.findTruncationPoint();
    const messagesBefore = this.messages.length;

    // Keep system prompt + messages from truncation point onwards
    this.messages = [systemPrompt, ...this.messages.slice(truncationIndex)];

    // Debug logging (only if significant truncation occurred)
    const messagesRemoved = messagesBefore - this.messages.length;
    if (messagesRemoved > 0 && process.env['DEBUG']) {
      console.debug(
        `[ChatEngine] Truncated ${messagesRemoved} messages (${messagesBefore - 1} -> ${this.messages.length - 1})`
      );
    }
  }

  /**
   * Get context window statistics for monitoring.
   *
   * @returns Object with current message count, max limit, and estimated tokens
   */
  getContextStats(): {
    messageCount: number;
    maxMessages: number | undefined;
    estimatedTokens: number;
  } {
    return {
      messageCount: this.getMessageCount(),
      maxMessages: this.maxContextMessages,
      estimatedTokens: this.estimateTokens(this.messages),
    };
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
