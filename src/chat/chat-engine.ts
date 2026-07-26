/**
 * Chat Engine for mainwpcontrol
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
  ToolCall,
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
import { ContextWindow } from './context-window.js';
import { logDestructiveActionSafe } from '../utils/audit-logger.js';
import { getInputSanitizer } from '../validation/input-sanitizer.js';
import { getSchemaValidator } from '../validation/schema-validator.js';
import { SchemaValidationError } from '../utils/errors.js';
import { stripControlChars } from '../utils/terminal-sanitizer.js';
import { redactSensitiveKeys } from '../utils/redaction.js';
import { executeAbilityWithPolicy } from '../core/execute-ability-with-policy.js';

/**
 * Largest streamed response body accumulated into a single LLM response.
 *
 * The provider stream is unbounded on its own and the SSE window runs for
 * minutes, so this is the size cap for the non-streaming path's equivalent.
 * 1MB is far beyond any real tool envelope or chat answer.
 */
const MAX_STREAM_CONTENT_LENGTH = 1_048_576;

/**
 * Truncate to `limit` UTF-16 units without splitting a surrogate pair.
 *
 * A plain slice can cut between the halves of an astral character (emoji,
 * many CJK extensions) and leave a lone surrogate, which serializes as a
 * replacement character and can corrupt the tail of the response.
 */
function truncateWholeCodePoints(text: string, limit: number): string {
  const cut = text.slice(0, limit);
  const lastCode = cut.charCodeAt(cut.length - 1);
  // High surrogate at the boundary means its low half was cut off.
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    return cut.slice(0, -1);
  }
  return cut;
}

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
  | {
      type: 'error';
      error: string;
      /** Ability name, when the error occurred while handling a specific tool */
      tool?: string;
      /**
       * Stable error code for callers that map chat errors to process
       * outcomes (e.g. 'OUTCOME_UNKNOWN' for a confirm call that failed
       * after dispatch).
       */
      code?: string;
    };

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
  toolCallId: string;
  toolAlias: string;
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
  private readonly contextWindow: ContextWindow;
  private readonly stream: boolean;
  private readonly onStreamChunk?: (content: string) => void;

  private messages: Message[] = [];
  private abilities: Ability[] = [];
  private tools: ToolDefinition[] = [];
  private readonly toolAliases = new Map<string, string>();
  private readonly abilityAliases = new Map<string, string>();
  private pendingPreview: PendingPreview | null = null;
  private initialized = false;
  // Engine-lifetime counter for fallback tool-call IDs. A per-turn counter
  // would repeat call_1, call_2, ... across turns while history is retained,
  // producing duplicate IDs in the conversation sent to providers.
  private fallbackToolCallId = 0;

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

    this.contextWindow = new ContextWindow(resolvedContextMessages);

    // Sync the resolved value into promptConfig for system prompt generation
    if (resolvedContextMessages !== undefined) {
      mergedPromptConfig.maxContextMessages = resolvedContextMessages;
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

    // Convert to protocol-safe tool definitions and keep a collision-checked
    // reverse map so execution always uses the real ability name.
    this.tools = this.abilities.map((ability) => {
      const alias = ability.name.replaceAll('/', '__');
      const existing = this.toolAliases.get(alias);
      if (existing && existing !== ability.name) {
        throw new Error(
          `Tool alias collision: "${existing}" and "${ability.name}" both map to "${alias}"`
        );
      }
      this.toolAliases.set(alias, ability.name);
      this.abilityAliases.set(ability.name, alias);
      return abilityToTool(alias, ability.description, ability.input_schema);
    });

    // Build system prompt
    const systemPrompt = buildConfiguredPrompt(this.abilities, this.promptConfig);

    // Initialize message history
    this.messages = [{ role: 'system', content: systemPrompt }];

    this.initialized = true;
  }

  // Serializes sendMessage calls. History and pendingPreview are shared
  // mutable state with no other concurrency protection; the readline REPL
  // happens to serialize calls today, but programmatic callers may not.
  private inFlight: Promise<void> = Promise.resolve();

  /**
   * Send a user message and process the response
   *
   * Concurrent calls are queued and run in call order; a rejected call does
   * not block the calls queued behind it.
   */
  async sendMessage(userMessage: string): Promise<ChatResponse[]> {
    const previous = this.inFlight;
    let release!: () => void;
    this.inFlight = new Promise((resolve) => (release = resolve));

    await previous;
    try {
      return await this.sendMessageSerialized(userMessage);
    } finally {
      release();
    }
  }

  private async sendMessageSerialized(userMessage: string): Promise<ChatResponse[]> {
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
   * Build the audit-log preview payload for a pending preview
   */
  private static previewAuditPayload(preview: PendingPreview): {
    summary: string;
    affectedCount: number;
  } {
    return {
      summary: preview.preview.summary,
      affectedCount: preview.preview.affected.length,
    };
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
        role: 'tool',
        content: JSON.stringify({
          success: false,
          error: {
            code: 'USER_DECLINED',
            message: 'The user declined the destructive action.',
          },
        }),
        toolCallId: preview.toolCallId,
        toolName: preview.toolAlias,
      });
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
        preview: ChatEngine.previewAuditPayload(preview),
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

    // Record the approval BEFORE dispatching the confirm call, so a transport
    // failure (or process death) mid-confirm still leaves durable evidence
    // that an approved destructive action may have reached the Dashboard.
    await logDestructiveActionSafe({
      abilityName: preview.ability.name,
      preview: ChatEngine.previewAuditPayload(preview),
      userDecision: 'approved',
      stage: 'dispatch',
      input: preview.input,
    });

    // User approved - execute with confirm. A throw here arrives after
    // dispatch was initiated: the outcome is unknown. Fail closed — audit the
    // uncertainty, keep history coherent, and tell the user to verify before
    // retrying. Never auto-retry the confirm.
    let result: ExecutionResult;
    try {
      result = await executeAbilityWithPolicy(
        this.executor,
        preview.ability,
        preview.input,
        { confirm: true }
      );
    } catch (error) {
      const reason = getInputSanitizer().sanitizeErrorMessage(
        error instanceof Error ? error.message : String(error)
      );
      await logDestructiveActionSafe({
        abilityName: preview.ability.name,
        preview: ChatEngine.previewAuditPayload(preview),
        userDecision: 'approved',
        execution: { success: false, error: reason, outcomeUnknown: true },
        input: preview.input,
      });
      this.messages.push({
        role: 'tool',
        content: JSON.stringify({
          success: false,
          error: {
            code: 'OUTCOME_UNKNOWN',
            message:
              'The confirm call failed after dispatch; the action may or may not have executed. Do not retry without verifying Dashboard state.',
          },
        }),
        toolCallId: preview.toolCallId,
        toolName: preview.toolAlias,
      });
      this.messages.push({ role: 'user', content: userMessage });
      this.truncateHistory();
      return [
        {
          type: 'error',
          error:
            `Confirm call for "${preview.ability.name}" failed after dispatch: ${reason}. ` +
            'The Dashboard may or may not have executed the action — verify its state before retrying.',
          tool: preview.ability.name,
          code: 'OUTCOME_UNKNOWN',
        },
      ];
    }

    // Log audit entry for approved and executed action (fire-and-forget)
    const executionAudit: { success: boolean; error?: string } = {
      success: result.success,
    };
    if (result.error?.message) {
      executionAudit.error = getInputSanitizer().sanitizeErrorMessage(result.error.message);
    }
    await logDestructiveActionSafe({
      abilityName: preview.ability.name,
      preview: ChatEngine.previewAuditPayload(preview),
      userDecision: 'approved',
      execution: executionAudit,
      input: preview.input,
    });

    // Add result to context. PROVIDER BOUNDARY: only a key-redacted copy of
    // the result enters the history sent to the LLM provider; the unredacted
    // result still goes back to the local user below.
    const toolResultMsg = {
      role: 'tool' as const,
      content: JSON.stringify(redactSensitiveKeys(result)),
      toolCallId: preview.toolCallId,
      toolName: preview.toolAlias,
    };
    this.messages.push(toolResultMsg);
    this.messages.push({
      role: 'user',
      content: 'User approved: yes',
    });

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
        toolAliases: this.toolAliases,
      });

      // Handle parse errors with retry
      if (parseResult.response.type === 'error') {
        if (isRetryable(parseResult) && retryCount < this.maxParseRetries) {
          retryCount++;
          // Add retry prompt
          this.messages.push({
            role: 'assistant',
            content:
              llmResponse.content ||
              'Invalid tool call omitted due to a protocol error.',
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

      const toolCallId = toolResponse.id ?? `call_${++this.fallbackToolCallId}`;
      const toolAlias =
        this.abilityAliases.get(toolResponse.tool) ?? toolResponse.tool;

      // Add assistant message with tool call
      this.messages.push({
        role: 'assistant',
        content: llmResponse.content,
        toolCalls: [
          {
            id: toolCallId,
            name: toolAlias,
            arguments: toolResponse.input,
            ...(toolResponse.thoughtSignature !== undefined
              ? { thoughtSignature: toolResponse.thoughtSignature }
              : {}),
          },
        ],
      });

      // Execute tool
      const toolResult = await this.executeTool(
        toolResponse.tool,
        toolResponse.input,
        toolCallId,
        toolAlias
      );

      if (toolResult.type === 'preview') {
        // Preview requires user approval - stop here
        responses.push(toolResult);
        break;
      }

      responses.push(toolResult);

      // Add tool result to context. PROVIDER BOUNDARY: ability output is
      // Dashboard-controlled data leaving the machine for a third-party LLM
      // provider — redact sensitive-looking keys before it enters history
      // (AGENTS.md: "minimize and redact secrets/customer data"). The
      // unredacted result was already returned to the local user above.
      if (toolResult.type === 'tool_result') {
        const resultContent =
          toolResult.result.success
            ? JSON.stringify(redactSensitiveKeys(toolResult.result.data))
            : JSON.stringify(redactSensitiveKeys(toolResult.result.error));

        this.messages.push({
          role: 'tool',
          content: resultContent,
          toolCallId,
          toolName: toolAlias,
        });

        // Truncate between tool-call iterations to enforce context limit
        // This ensures each provider.chat call receives a bounded history
        // Note: truncateHistory() already skips when pendingPreview is set
        this.truncateHistory();
      } else if (toolResult.type === 'error') {
        this.messages.push({
          role: 'tool',
          content: JSON.stringify({ error: toolResult.error }),
          toolCallId,
          toolName: toolAlias,
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
    input: Record<string, unknown>,
    toolCallId: string,
    toolAlias: string
  ): Promise<ChatResponse> {
    // Find ability
    const ability = await this.executor.getAbility(toolName);
    if (!ability) {
      return {
        type: 'error',
        error: `Unknown ability: ${toolName}`,
      };
    }

    input = getInputSanitizer().sanitize(input);
    if (ability.input_schema) {
      try {
        const validated = getSchemaValidator().validateOrThrow(
          input,
          ability.input_schema,
          ability.name
        );
        input = validated.coerced ?? input;
      } catch (error) {
        if (error instanceof SchemaValidationError) {
          const validationError: NonNullable<ExecutionResult['error']> = {
            code: error.code,
            message: error.message,
            details: error.details,
          };
          if (error.hint) {
            validationError.hint = error.hint;
          }
          return {
            type: 'tool_result',
            tool: ability.name,
            result: {
              success: false,
              error: validationError,
            },
          };
        }
        // A throw here would leave the already-pushed assistant tool call
        // dangling in history (no matching tool message), corrupting the next
        // provider request. Surface it like the execution catch-all below.
        return {
          type: 'error',
          error: error instanceof Error ? error.message : String(error),
          tool: ability.name,
        };
      }
    }

    // Check if destructive
    const classification = this.safetyController.classify(ability);

    if (classification.requiresSafetyFlow) {
      // SAFETY: Destructive actions always preview first
      // AI cannot skip this step
      return this.executeWithPreview(
        ability,
        input,
        toolCallId,
        toolAlias
      );
    }

    // Safe to execute directly
    try {
      const result = await executeAbilityWithPolicy(this.executor, ability, input);
      return {
        type: 'tool_result',
        tool: ability.name,
        result,
      };
    } catch (error) {
      return {
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
        tool: ability.name,
      };
    }
  }

  /**
   * Execute destructive action with preview
   */
  private async executeWithPreview(
    ability: Ability,
    input: Record<string, unknown>,
    toolCallId: string,
    toolAlias: string
  ): Promise<ChatResponse> {
    try {
      // Execute with dry_run
      const previewResult = await executeAbilityWithPolicy(
        this.executor,
        ability,
        input,
        { dryRun: true }
      );

      if (!previewResult.success) {
        return {
          type: 'error',
          error: previewResult.error?.message ?? 'Preview failed',
          tool: ability.name,
        };
      }

      // Format preview
      const preview = this.safetyController.formatPreviewResult(
        ability,
        input,
        previewResult
      );

      // Store pending preview for approval
      this.pendingPreview = { ability, input, preview, toolCallId, toolAlias };

      return {
        type: 'preview',
        preview,
        requiresApproval: true,
      };
    } catch (error) {
      return {
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
        tool: ability.name,
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
    const toolCalls: ToolCall[] = [];
    // A response we cut short must not be reported as a complete answer.
    let contentTruncated = false;

    try {
      for await (const chunk of stream) {
        // Handle content chunks
        if (chunk.content) {
          // Bound the accumulation: the SSE window is minutes long and the
          // provider stream has no size cap of its own, so an oversized
          // response would otherwise grow unbounded in memory and feed the
          // downstream envelope scan. Display still streams every chunk.
          if (content.length >= MAX_STREAM_CONTENT_LENGTH) {
            // Already full; this chunk is being dropped.
            contentTruncated = true;
          } else {
            const combined = content + chunk.content;
            // >= not >: a surrogate pair split across chunks can land exactly on
            // the cap, and a `>` test would never trim the orphaned half.
            if (combined.length >= MAX_STREAM_CONTENT_LENGTH) {
              content = truncateWholeCodePoints(combined, MAX_STREAM_CONTENT_LENGTH);
              if (combined.length > content.length) {
                contentTruncated = true;
              }
            } else {
              content = combined;
            }
          }
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
            arguments: chunk.toolCall.arguments,
            ...(chunk.toolCall.thoughtSignature !== undefined
              ? { thoughtSignature: chunk.toolCall.thoughtSignature }
              : {}),
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
          `[ChatEngine] Stream interrupted: ${stripControlChars(
            error instanceof Error ? error.message : String(error)
          )}`
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

    // A stream that ended cleanly but delivered nothing is a failed response,
    // not an empty answer: reporting finishReason 'stop' here would flow into
    // the envelope parser's plain-text fallback and surface as a successful
    // blank reply (exit 0 in one-shot mode).
    if (!content && toolCalls.length === 0) {
      return {
        content: '',
        toolCalls: undefined,
        finishReason: 'error',
        model: this.provider.getDefaultModel(),
      };
    }

    // Return accumulated LLMResponse
    const parsedToolCalls = toolCalls;

    // Content we cut at the cap is not a complete answer. Reporting 'stop'
    // would let a truncated response pass as a finished one; 'length' routes it
    // into the envelope parser's existing protocol-error path instead.
    if (contentTruncated && parsedToolCalls.length === 0) {
      return {
        content,
        toolCalls: undefined,
        finishReason: 'length',
        model: this.provider.getDefaultModel(),
      };
    }

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
   * Truncate message history via the context window.
   *
   * Safety: Never truncates while a preview is pending — this preserves
   * context for the approval decision.
   */
  private truncateHistory(): void {
    if (this.pendingPreview !== null) {
      return;
    }
    this.messages = this.contextWindow.truncate(this.messages);
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
