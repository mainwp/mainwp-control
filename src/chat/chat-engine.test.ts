/**
 * Golden Tests for ChatEngine
 *
 * These tests verify the critical safety invariants from PLAN.md and CHAT_PROMPT.md:
 * - AI proposes tool calls; ChatEngine executes via AbilitiesExecutor
 * - AI NEVER executes directly
 * - Destructive actions always preview first
 * - Max tool calls per turn enforced
 * - JSON retry logic
 *
 * CRITICAL: These tests are normative. Any failure indicates a violation
 * of the safety contract.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatEngine, createChatEngine, type ChatResponse } from './chat-engine.js';
import type { LLMProvider, LLMResponse, Message, ToolDefinition, ChatOptions } from './providers/provider.js';
import type { Ability, ExecutionResult, ExecutionOptions } from '../core/abilities-executor.js';

// ============================================================================
// Test Fixtures
// ============================================================================

/**
 * Create a test ability with specified annotations
 */
function createTestAbility(
  name: string,
  annotations: { readonly?: boolean; destructive?: boolean; idempotent?: boolean },
  inputSchema?: Record<string, unknown>
): Ability {
  return {
    name,
    label: name.replace(/-/g, ' ').replace(/v1$/, '').trim(),
    description: `Test ability: ${name}`,
    category: 'test',
    input_schema: inputSchema ?? { type: 'object', properties: {} },
    meta: {
      annotations: {
        readonly: annotations.readonly ?? false,
        destructive: annotations.destructive ?? false,
        idempotent: annotations.idempotent ?? false,
      },
    },
  };
}

/**
 * Create a test ability without annotations (edge case)
 */
function createAbilityWithoutAnnotations(name: string): Ability {
  return {
    name,
    label: name,
    description: `Legacy ability: ${name}`,
    category: 'legacy',
  };
}

// Standard test abilities
const READONLY_ABILITY = createTestAbility('list-sites-v1', { readonly: true });
const DESTRUCTIVE_ABILITY = createTestAbility('delete-site-v1', { destructive: true }, {
  type: 'object',
  properties: {
    site_id: { type: 'integer', description: 'Site ID' },
  },
  required: ['site_id'],
});
const DESTRUCTIVE_IDEMPOTENT_ABILITY = createTestAbility('delete-cache-v1', {
  destructive: true,
  idempotent: true,
});
const READONLY_DESTRUCTIVE_ABILITY = createTestAbility('special-v1', {
  readonly: true,
  destructive: true,
});
const ABILITY_WITHOUT_ANNOTATIONS = createAbilityWithoutAnnotations('legacy-ability-v1');
const UPDATE_ABILITY = createTestAbility('update-site-v1', { destructive: false });

// Standard LLM responses
function createToolCallResponse(toolName: string, input: Record<string, unknown>): LLMResponse {
  return {
    content: JSON.stringify({ tool: toolName, input }),
    finishReason: 'stop',
    model: 'test-model',
  };
}

function createNativeToolCallResponse(toolName: string, input: Record<string, unknown>, id = 'call_1'): LLMResponse {
  return {
    content: '',
    toolCalls: [{ id, name: toolName, arguments: input }],
    finishReason: 'tool_calls',
    model: 'test-model',
  };
}

function createAnswerResponse(answer: string): LLMResponse {
  return {
    content: JSON.stringify({ answer }),
    finishReason: 'stop',
    model: 'test-model',
  };
}

function createInvalidJsonResponse(): LLMResponse {
  return {
    content: 'This is not valid JSON { broken',
    finishReason: 'stop',
    model: 'test-model',
  };
}

// Standard execution results
function createSuccessResult<T = unknown>(data: T): ExecutionResult<T> {
  return { success: true, data };
}

function createErrorResult(code: string, message: string): ExecutionResult {
  return { success: false, error: { code, message } };
}

function createPreviewResult(affected: unknown[]): ExecutionResult {
  return { success: true, data: { affected } };
}

// ============================================================================
// Mock Factories
// ============================================================================

/**
 * Create a mock LLM provider that returns predefined responses in sequence
 */
function createMockProvider(responses: LLMResponse[]): LLMProvider {
  let callIndex = 0;
  return {
    name: 'mock-provider',
    capabilities: {
      functionCalling: true,
      streaming: false,
      systemMessages: true,
      vision: false,
      maxContextLength: 4096,
    },
    chat: vi.fn(async (_messages: Message[], _options?: ChatOptions): Promise<LLMResponse> => {
      const response = responses[callIndex];
      if (!response) {
        throw new Error(`No more mock responses (called ${callIndex + 1} times, only ${responses.length} responses provided)`);
      }
      callIndex++;
      return response;
    }),
    isConfigured: () => true,
    getModels: () => ['test-model'],
    getDefaultModel: () => 'test-model',
  };
}

/**
 * Create a mock abilities executor
 */
function createMockExecutor(
  abilities: Ability[],
  executeHandler?: (name: string, input: Record<string, unknown>, options?: ExecutionOptions) => ExecutionResult
): {
  listAbilities: ReturnType<typeof vi.fn>;
  getAbility: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
} {
  const abilityMap = new Map(abilities.map((a) => [a.name, a]));

  return {
    listAbilities: vi.fn(async () => abilities),
    getAbility: vi.fn(async (name: string) => abilityMap.get(name)),
    execute: vi.fn(async (name: string, input: Record<string, unknown>, options?: ExecutionOptions) => {
      if (executeHandler) {
        return executeHandler(name, input, options);
      }
      // Default: return success
      return createSuccessResult({ executed: true });
    }),
  };
}

/**
 * Create a test ChatEngine with mocks
 */
function createTestEngine(options: {
  provider?: LLMProvider;
  abilities?: Ability[];
  executeHandler?: (name: string, input: Record<string, unknown>, options?: ExecutionOptions) => ExecutionResult;
  maxToolCallsPerTurn?: number;
  maxParseRetries?: number;
  model?: string;
  temperature?: number;
}): {
  engine: ChatEngine;
  mockProvider: LLMProvider;
  mockExecutor: ReturnType<typeof createMockExecutor>;
} {
  const abilities = options.abilities ?? [READONLY_ABILITY, DESTRUCTIVE_ABILITY];
  const mockExecutor = createMockExecutor(abilities, options.executeHandler);
  const mockProvider = options.provider ?? createMockProvider([createAnswerResponse('Hello')]);

  const engine = createChatEngine({
    provider: mockProvider,
    executor: mockExecutor as never,
    maxToolCallsPerTurn: options.maxToolCallsPerTurn,
    maxParseRetries: options.maxParseRetries,
    model: options.model,
    temperature: options.temperature,
  });

  return { engine, mockProvider, mockExecutor };
}

// ============================================================================
// Tests
// ============================================================================

describe('ChatEngine', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================================================
  // Initialization Tests
  // ==========================================================================

  describe('Initialization', () => {
    it('calls listAbilities on executor during initialize', async () => {
      const { engine, mockExecutor } = createTestEngine({});

      await engine.initialize();

      expect(mockExecutor.listAbilities).toHaveBeenCalledTimes(1);
    });

    it('builds system prompt with abilities', async () => {
      const { engine } = createTestEngine({
        abilities: [READONLY_ABILITY, DESTRUCTIVE_ABILITY],
      });

      await engine.initialize();

      const history = engine.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0]!.role).toBe('system');
      expect(history[0]!.content).toContain('list-sites-v1');
      expect(history[0]!.content).toContain('delete-site-v1');
    });

    it('marks destructive abilities in system prompt', async () => {
      const { engine } = createTestEngine({
        abilities: [DESTRUCTIVE_ABILITY],
      });

      await engine.initialize();

      const history = engine.getHistory();
      expect(history[0]!.content).toContain('DESTRUCTIVE');
    });

    it('sets initialized flag to true', async () => {
      const { engine, mockExecutor } = createTestEngine({});

      await engine.initialize();
      await engine.initialize(); // Second call should be no-op

      expect(mockExecutor.listAbilities).toHaveBeenCalledTimes(1);
    });

    it('is idempotent - subsequent calls are no-ops', async () => {
      const { engine, mockExecutor } = createTestEngine({});

      await engine.initialize();
      await engine.initialize();
      await engine.initialize();

      expect(mockExecutor.listAbilities).toHaveBeenCalledTimes(1);
    });

    it('handles empty abilities list', async () => {
      const { engine } = createTestEngine({ abilities: [] });

      await engine.initialize();

      const history = engine.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0]!.content).toContain('No abilities available');
    });

    it('loads abilities correctly', async () => {
      const { engine } = createTestEngine({
        abilities: [READONLY_ABILITY, DESTRUCTIVE_ABILITY],
      });

      await engine.initialize();

      const abilities = engine.getAbilities();
      expect(abilities).toHaveLength(2);
      expect(abilities[0]!.name).toBe('list-sites-v1');
      expect(abilities[1]!.name).toBe('delete-site-v1');
    });

    it('uses custom model and temperature options', async () => {
      const { engine } = createTestEngine({
        model: 'custom-model',
        temperature: 0.5,
      });

      await engine.initialize();

      const info = engine.getProviderInfo();
      expect(info.model).toBe('custom-model');
    });

    it('auto-initializes on first sendMessage', async () => {
      const mockProvider = createMockProvider([createAnswerResponse('Hello')]);
      const { engine, mockExecutor } = createTestEngine({ provider: mockProvider });

      expect(mockExecutor.listAbilities).not.toHaveBeenCalled();

      await engine.sendMessage('Hi');

      expect(mockExecutor.listAbilities).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // Golden Test: Readonly Abilities Execute Directly
  // ==========================================================================

  describe('Golden Test: Readonly Abilities Execute Directly', () => {
    it('executes readonly ability immediately without preview', async () => {
      const mockProvider = createMockProvider([
        createToolCallResponse('list-sites-v1', {}),
        createAnswerResponse('Here are your sites'),
      ]);

      const { engine, mockExecutor } = createTestEngine({
        provider: mockProvider,
        abilities: [READONLY_ABILITY],
        executeHandler: () => createSuccessResult({ sites: [{ id: 1, name: 'Test Site' }] }),
      });

      const responses = await engine.sendMessage('List my sites');

      expect(mockExecutor.execute).toHaveBeenCalledWith('list-sites-v1', {});
      expect(mockExecutor.execute).not.toHaveBeenCalledWith('list-sites-v1', {}, expect.objectContaining({ dryRun: true }));
    });

    it('does not set pending preview for readonly ability', async () => {
      const mockProvider = createMockProvider([
        createToolCallResponse('list-sites-v1', {}),
        createAnswerResponse('Done'),
      ]);

      const { engine } = createTestEngine({
        provider: mockProvider,
        abilities: [READONLY_ABILITY],
        executeHandler: () => createSuccessResult({ sites: [] }),
      });

      await engine.sendMessage('List my sites');

      expect(engine.hasPendingPreview()).toBe(false);
      expect(engine.getPendingPreview()).toBeNull();
    });

    it('returns tool_result response for readonly ability', async () => {
      const mockProvider = createMockProvider([
        createToolCallResponse('list-sites-v1', {}),
        createAnswerResponse('Done'),
      ]);

      const { engine } = createTestEngine({
        provider: mockProvider,
        abilities: [READONLY_ABILITY],
        executeHandler: () => createSuccessResult({ sites: [{ id: 1 }] }),
      });

      const responses = await engine.sendMessage('List sites');

      const toolResult = responses.find((r) => r.type === 'tool_result');
      expect(toolResult).toBeDefined();
      expect(toolResult!.type).toBe('tool_result');
      if (toolResult?.type === 'tool_result') {
        expect(toolResult.tool).toBe('list-sites-v1');
        expect(toolResult.result.success).toBe(true);
      }
    });

    it('works with native function call format', async () => {
      const mockProvider = createMockProvider([
        createNativeToolCallResponse('list-sites-v1', {}),
        createAnswerResponse('Done'),
      ]);

      const { engine, mockExecutor } = createTestEngine({
        provider: mockProvider,
        abilities: [READONLY_ABILITY],
        executeHandler: () => createSuccessResult({ sites: [] }),
      });

      await engine.sendMessage('List sites');

      expect(mockExecutor.execute).toHaveBeenCalledWith('list-sites-v1', {});
    });

    it('adds tool result to message history', async () => {
      const mockProvider = createMockProvider([
        createToolCallResponse('list-sites-v1', {}),
        createAnswerResponse('Done'),
      ]);

      const { engine } = createTestEngine({
        provider: mockProvider,
        abilities: [READONLY_ABILITY],
        executeHandler: () => createSuccessResult({ sites: [] }),
      });

      await engine.sendMessage('List sites');

      const history = engine.getHistory();
      const toolMessage = history.find((m) => m.role === 'tool');
      expect(toolMessage).toBeDefined();
      expect(toolMessage!.toolName).toBe('list-sites-v1');
    });

    it('executes readonly ability with no input_schema', async () => {
      const abilityNoSchema: Ability = {
        name: 'simple-ability-v1',
        label: 'Simple',
        description: 'Simple ability',
        category: 'test',
        meta: { annotations: { readonly: true, destructive: false, idempotent: false } },
      };

      const mockProvider = createMockProvider([
        createToolCallResponse('simple-ability-v1', {}),
        createAnswerResponse('Done'),
      ]);

      const { engine, mockExecutor } = createTestEngine({
        provider: mockProvider,
        abilities: [abilityNoSchema],
        executeHandler: () => createSuccessResult({ result: 'ok' }),
      });

      await engine.sendMessage('Run simple');

      expect(mockExecutor.execute).toHaveBeenCalledWith('simple-ability-v1', {});
    });
  });

  // ==========================================================================
  // Golden Test: Destructive Preview-Before-Execution Flow
  // ==========================================================================

  describe('Golden Test: Destructive Preview-Before-Execution Flow', () => {
    it('ALWAYS previews destructive actions with dry_run', async () => {
      const mockProvider = createMockProvider([
        createToolCallResponse('delete-site-v1', { site_id: 123 }),
      ]);

      const { engine, mockExecutor } = createTestEngine({
        provider: mockProvider,
        abilities: [DESTRUCTIVE_ABILITY],
        executeHandler: (_name, _input, options) => {
          if (options?.dryRun) {
            return createPreviewResult([{ id: 123, name: 'Site to delete' }]);
          }
          return createSuccessResult({ deleted: true });
        },
      });

      await engine.sendMessage('Delete site 123');

      expect(mockExecutor.execute).toHaveBeenCalledWith(
        'delete-site-v1',
        { site_id: 123 },
        { dryRun: true }
      );
    });

    it('returns preview response type for destructive action', async () => {
      const mockProvider = createMockProvider([
        createToolCallResponse('delete-site-v1', { site_id: 123 }),
      ]);

      const { engine } = createTestEngine({
        provider: mockProvider,
        abilities: [DESTRUCTIVE_ABILITY],
        executeHandler: () => createPreviewResult([{ id: 123 }]),
      });

      const responses = await engine.sendMessage('Delete site 123');

      expect(responses).toHaveLength(1);
      expect(responses[0]!.type).toBe('preview');
      if (responses[0]?.type === 'preview') {
        expect(responses[0].requiresApproval).toBe(true);
      }
    });

    it('sets pending preview state after destructive preview', async () => {
      const mockProvider = createMockProvider([
        createToolCallResponse('delete-site-v1', { site_id: 123 }),
      ]);

      const { engine } = createTestEngine({
        provider: mockProvider,
        abilities: [DESTRUCTIVE_ABILITY],
        executeHandler: () => createPreviewResult([{ id: 123 }]),
      });

      await engine.sendMessage('Delete site 123');

      expect(engine.hasPendingPreview()).toBe(true);
      const preview = engine.getPendingPreview();
      expect(preview).not.toBeNull();
      expect(preview!.abilityName).toBe('delete-site-v1');
      expect(preview!.requiresApproval).toBe(true);
    });

    it('preview includes affected items and summary', async () => {
      const mockProvider = createMockProvider([
        createToolCallResponse('delete-site-v1', { site_id: 123 }),
      ]);

      const { engine } = createTestEngine({
        provider: mockProvider,
        abilities: [DESTRUCTIVE_ABILITY],
        executeHandler: () => createPreviewResult([{ id: 123, name: 'My Site' }]),
      });

      await engine.sendMessage('Delete site');

      const preview = engine.getPendingPreview();
      expect(preview!.affected).toHaveLength(1);
      expect(preview!.summary).toContain('1 item');
      expect(preview!.summary).toContain('deleted');
    });

    it('generates correct summary for no affected items', async () => {
      const mockProvider = createMockProvider([
        createToolCallResponse('delete-site-v1', { site_id: 123 }),
      ]);

      const { engine } = createTestEngine({
        provider: mockProvider,
        abilities: [DESTRUCTIVE_ABILITY],
        executeHandler: () => createPreviewResult([]),
      });

      await engine.sendMessage('Delete site');

      const preview = engine.getPendingPreview();
      expect(preview!.affected).toHaveLength(0);
      expect(preview!.summary).toContain('No items');
    });

    it('destructive+idempotent still requires preview', async () => {
      const mockProvider = createMockProvider([
        createToolCallResponse('delete-cache-v1', {}),
      ]);

      const { engine, mockExecutor } = createTestEngine({
        provider: mockProvider,
        abilities: [DESTRUCTIVE_IDEMPOTENT_ABILITY],
        executeHandler: () => createPreviewResult([{ cache: 'cleared' }]),
      });

      await engine.sendMessage('Clear cache');

      expect(mockExecutor.execute).toHaveBeenCalledWith(
        'delete-cache-v1',
        {},
        { dryRun: true }
      );
      expect(engine.hasPendingPreview()).toBe(true);
    });

    it('readonly+destructive executes directly (readonly takes precedence)', async () => {
      const mockProvider = createMockProvider([
        createToolCallResponse('special-v1', {}),
        createAnswerResponse('Done'),
      ]);

      const { engine, mockExecutor } = createTestEngine({
        provider: mockProvider,
        abilities: [READONLY_DESTRUCTIVE_ABILITY],
        executeHandler: () => createSuccessResult({ result: 'ok' }),
      });

      await engine.sendMessage('Run special');

      // Should NOT be called with dryRun since readonly takes precedence
      expect(mockExecutor.execute).toHaveBeenCalledWith('special-v1', {});
      expect(engine.hasPendingPreview()).toBe(false);
    });

    it('stores original input in pending preview', async () => {
      const mockProvider = createMockProvider([
        createToolCallResponse('delete-site-v1', { site_id: 456, force: true }),
      ]);

      const { engine } = createTestEngine({
        provider: mockProvider,
        abilities: [DESTRUCTIVE_ABILITY],
        executeHandler: () => createPreviewResult([{ id: 456 }]),
      });

      await engine.sendMessage('Delete site');

      const preview = engine.getPendingPreview();
      expect(preview!.input).toEqual({ site_id: 456, force: true });
    });
  });

  // ==========================================================================
  // Golden Test: User Approval Handling
  // ==========================================================================

  describe('Golden Test: User Approval Handling', () => {
    async function setupPreviewState(): Promise<{
      engine: ChatEngine;
      mockExecutor: ReturnType<typeof createMockExecutor>;
    }> {
      const mockProvider = createMockProvider([
        createToolCallResponse('delete-site-v1', { site_id: 123 }),
      ]);

      const { engine, mockExecutor } = createTestEngine({
        provider: mockProvider,
        abilities: [DESTRUCTIVE_ABILITY],
        executeHandler: (_name, _input, options) => {
          if (options?.dryRun) {
            return createPreviewResult([{ id: 123 }]);
          }
          if (options?.confirm) {
            return createSuccessResult({ deleted: true, id: 123 });
          }
          return createErrorResult('UNEXPECTED', 'Unexpected call');
        },
      });

      await engine.sendMessage('Delete site 123');
      expect(engine.hasPendingPreview()).toBe(true);

      return { engine, mockExecutor };
    }

    it('approves with "yes"', async () => {
      const { engine, mockExecutor } = await setupPreviewState();

      const responses = await engine.sendMessage('yes');

      expect(mockExecutor.execute).toHaveBeenCalledWith(
        'delete-site-v1',
        { site_id: 123 },
        { confirm: true }
      );
      expect(responses[0]!.type).toBe('tool_result');
    });

    it('approves with "y"', async () => {
      const { engine, mockExecutor } = await setupPreviewState();

      await engine.sendMessage('y');

      expect(mockExecutor.execute).toHaveBeenCalledWith(
        'delete-site-v1',
        { site_id: 123 },
        { confirm: true }
      );
    });

    it('approves with "approve"', async () => {
      const { engine, mockExecutor } = await setupPreviewState();

      await engine.sendMessage('approve');

      expect(mockExecutor.execute).toHaveBeenCalledWith(
        'delete-site-v1',
        { site_id: 123 },
        { confirm: true }
      );
    });

    it('approves with "confirm"', async () => {
      const { engine, mockExecutor } = await setupPreviewState();

      await engine.sendMessage('confirm');

      expect(mockExecutor.execute).toHaveBeenCalledWith(
        'delete-site-v1',
        { site_id: 123 },
        { confirm: true }
      );
    });

    it('is case-insensitive for approval keywords', async () => {
      const { engine, mockExecutor } = await setupPreviewState();

      await engine.sendMessage('YES');

      expect(mockExecutor.execute).toHaveBeenLastCalledWith(
        'delete-site-v1',
        { site_id: 123 },
        { confirm: true }
      );
    });

    it('trims whitespace from approval input', async () => {
      const { engine, mockExecutor } = await setupPreviewState();

      await engine.sendMessage('  yes  ');

      expect(mockExecutor.execute).toHaveBeenLastCalledWith(
        'delete-site-v1',
        { site_id: 123 },
        { confirm: true }
      );
    });

    it('clears pending preview after approval', async () => {
      const { engine } = await setupPreviewState();

      await engine.sendMessage('yes');

      expect(engine.hasPendingPreview()).toBe(false);
      expect(engine.getPendingPreview()).toBeNull();
    });

    it('returns tool_result with both result and preview', async () => {
      const { engine } = await setupPreviewState();

      const responses = await engine.sendMessage('yes');

      expect(responses[0]!.type).toBe('tool_result');
      if (responses[0]?.type === 'tool_result') {
        expect(responses[0].result).toBeDefined();
        expect(responses[0].preview).toBeDefined();
        expect(responses[0].preview!.abilityName).toBe('delete-site-v1');
      }
    });

    it('adds approval message to history', async () => {
      const { engine } = await setupPreviewState();

      await engine.sendMessage('yes');

      const history = engine.getHistory();
      const approvalMessage = history.find((m) => m.content === 'User approved: yes');
      expect(approvalMessage).toBeDefined();
      expect(approvalMessage!.role).toBe('user');
    });

    it('handles execution error after approval', async () => {
      const mockProvider = createMockProvider([
        createToolCallResponse('delete-site-v1', { site_id: 123 }),
      ]);

      let callCount = 0;
      const { engine } = createTestEngine({
        provider: mockProvider,
        abilities: [DESTRUCTIVE_ABILITY],
        executeHandler: (_name, _input, options) => {
          callCount++;
          if (options?.dryRun) {
            return createPreviewResult([{ id: 123 }]);
          }
          if (options?.confirm) {
            return createErrorResult('DELETE_FAILED', 'Site not found');
          }
          return createSuccessResult({});
        },
      });

      await engine.sendMessage('Delete site');
      const responses = await engine.sendMessage('yes');

      expect(responses[0]!.type).toBe('tool_result');
      if (responses[0]?.type === 'tool_result') {
        expect(responses[0].result.success).toBe(false);
        expect(responses[0].result.error?.code).toBe('DELETE_FAILED');
      }
    });
  });

  // ==========================================================================
  // Golden Test: User Decline Handling
  // ==========================================================================

  describe('Golden Test: User Decline Handling', () => {
    async function setupPreviewState(): Promise<{
      engine: ChatEngine;
      mockExecutor: ReturnType<typeof createMockExecutor>;
    }> {
      const mockProvider = createMockProvider([
        createToolCallResponse('delete-site-v1', { site_id: 123 }),
      ]);

      const { engine, mockExecutor } = createTestEngine({
        provider: mockProvider,
        abilities: [DESTRUCTIVE_ABILITY],
        executeHandler: (_name, _input, options) => {
          if (options?.dryRun) {
            return createPreviewResult([{ id: 123 }]);
          }
          return createSuccessResult({ deleted: true });
        },
      });

      await engine.sendMessage('Delete site 123');
      expect(engine.hasPendingPreview()).toBe(true);

      // Reset call count after setup
      mockExecutor.execute.mockClear();

      return { engine, mockExecutor };
    }

    it('declines with "no"', async () => {
      const { engine, mockExecutor } = await setupPreviewState();

      const responses = await engine.sendMessage('no');

      expect(mockExecutor.execute).not.toHaveBeenCalled();
      expect(responses[0]!.type).toBe('message');
      if (responses[0]?.type === 'message') {
        expect(responses[0].content).toContain('cancelled');
      }
    });

    it('declines with "cancel"', async () => {
      const { engine, mockExecutor } = await setupPreviewState();

      const responses = await engine.sendMessage('cancel');

      expect(mockExecutor.execute).not.toHaveBeenCalled();
      expect(responses[0]!.type).toBe('message');
    });

    it('declines with "n"', async () => {
      const { engine, mockExecutor } = await setupPreviewState();

      await engine.sendMessage('n');

      expect(mockExecutor.execute).not.toHaveBeenCalled();
    });

    it('declines with arbitrary text', async () => {
      const { engine, mockExecutor } = await setupPreviewState();

      await engine.sendMessage('I changed my mind');

      expect(mockExecutor.execute).not.toHaveBeenCalled();
    });

    it('declines with empty string', async () => {
      const { engine, mockExecutor } = await setupPreviewState();

      await engine.sendMessage('');

      expect(mockExecutor.execute).not.toHaveBeenCalled();
    });

    it('clears pending preview after decline', async () => {
      const { engine } = await setupPreviewState();

      await engine.sendMessage('no');

      expect(engine.hasPendingPreview()).toBe(false);
      expect(engine.getPendingPreview()).toBeNull();
    });

    it('returns cancellation message', async () => {
      const { engine } = await setupPreviewState();

      const responses = await engine.sendMessage('no');

      expect(responses[0]!.type).toBe('message');
      if (responses[0]?.type === 'message') {
        expect(responses[0].content).toContain('cancelled');
        expect(responses[0].content).toContain('not executed');
      }
    });

    it('adds decline message to history', async () => {
      const { engine } = await setupPreviewState();

      await engine.sendMessage('no thanks');

      const history = engine.getHistory();
      const userMessage = history.find((m) => m.role === 'user' && m.content === 'no thanks');
      expect(userMessage).toBeDefined();
    });

    it('treats subsequent message as new conversation after decline', async () => {
      const mockProvider = createMockProvider([
        createToolCallResponse('delete-site-v1', { site_id: 123 }),
        createAnswerResponse('How can I help?'),
      ]);

      const { engine, mockExecutor } = createTestEngine({
        provider: mockProvider,
        abilities: [DESTRUCTIVE_ABILITY, READONLY_ABILITY],
        executeHandler: (_name, _input, options) => {
          if (options?.dryRun) {
            return createPreviewResult([{ id: 123 }]);
          }
          return createSuccessResult({});
        },
      });

      await engine.sendMessage('Delete site 123');
      await engine.sendMessage('no');

      mockExecutor.execute.mockClear();

      // This should be treated as a new message, not an approval
      const responses = await engine.sendMessage('What can you do?');

      // Should go to LLM, not try to execute
      expect(responses[0]!.type).toBe('message');
    });
  });

  // ==========================================================================
  // Golden Test: Max Tool Calls Per Turn Enforcement
  // ==========================================================================

  describe('Golden Test: Max Tool Calls Per Turn Enforcement', () => {
    it('enforces maxToolCallsPerTurn limit (default 3)', async () => {
      // Always return another tool call
      let callIndex = 0;
      const mockProvider = createMockProvider([
        createToolCallResponse('list-sites-v1', { page: 1 }),
        createToolCallResponse('list-sites-v1', { page: 2 }),
        createToolCallResponse('list-sites-v1', { page: 3 }),
        createToolCallResponse('list-sites-v1', { page: 4 }), // Should not reach this
      ]);

      const { engine, mockExecutor } = createTestEngine({
        provider: mockProvider,
        abilities: [READONLY_ABILITY],
        maxToolCallsPerTurn: 3,
        executeHandler: () => createSuccessResult({ sites: [] }),
      });

      const responses = await engine.sendMessage('List all sites');

      // Should have executed exactly 3 tools
      expect(mockExecutor.execute).toHaveBeenCalledTimes(3);

      // Should have a message about max tool calls
      const maxCallsMessage = responses.find(
        (r) => r.type === 'message' && r.content.includes('maximum tool calls')
      );
      expect(maxCallsMessage).toBeDefined();
    });

    it('respects custom maxToolCallsPerTurn value', async () => {
      const mockProvider = createMockProvider([
        createToolCallResponse('list-sites-v1', {}),
        createToolCallResponse('list-sites-v1', {}),
      ]);

      const { engine, mockExecutor } = createTestEngine({
        provider: mockProvider,
        abilities: [READONLY_ABILITY],
        maxToolCallsPerTurn: 1,
        executeHandler: () => createSuccessResult({ sites: [] }),
      });

      await engine.sendMessage('List sites');

      expect(mockExecutor.execute).toHaveBeenCalledTimes(1);
    });

    it('resets counter between sendMessage calls', async () => {
      // Each turn gets its own set of responses
      // Turn 1: tool call -> hits limit -> returns with max calls message
      // Turn 2: tool call -> hits limit -> returns with max calls message
      const mockProvider: LLMProvider = {
        name: 'turn-provider',
        capabilities: {
          functionCalling: true,
          streaming: false,
          systemMessages: true,
          vision: false,
          maxContextLength: 4096,
        },
        chat: vi.fn(async () => createToolCallResponse('list-sites-v1', {})),
        isConfigured: () => true,
        getModels: () => ['test'],
        getDefaultModel: () => 'test',
      };

      const { engine, mockExecutor } = createTestEngine({
        provider: mockProvider,
        abilities: [READONLY_ABILITY],
        maxToolCallsPerTurn: 1,
        executeHandler: () => createSuccessResult({ sites: [] }),
      });

      await engine.sendMessage('First request');
      await engine.sendMessage('Second request');

      // Each turn should allow 1 tool call (counter resets between turns)
      expect(mockExecutor.execute).toHaveBeenCalledTimes(2);
    });

    it('stops even if LLM keeps returning tool calls', async () => {
      // Infinite tool calls
      const infiniteProvider: LLMProvider = {
        name: 'infinite-provider',
        capabilities: {
          functionCalling: true,
          streaming: false,
          systemMessages: true,
          vision: false,
          maxContextLength: 4096,
        },
        chat: vi.fn(async () => createToolCallResponse('list-sites-v1', {})),
        isConfigured: () => true,
        getModels: () => ['test'],
        getDefaultModel: () => 'test',
      };

      const { engine, mockExecutor } = createTestEngine({
        provider: infiniteProvider,
        abilities: [READONLY_ABILITY],
        maxToolCallsPerTurn: 5,
        executeHandler: () => createSuccessResult({ sites: [] }),
      });

      await engine.sendMessage('Keep listing');

      expect(mockExecutor.execute).toHaveBeenCalledTimes(5);
    });

    it('handles maxToolCallsPerTurn: 2', async () => {
      const mockProvider = createMockProvider([
        createToolCallResponse('list-sites-v1', {}),
        createToolCallResponse('list-sites-v1', {}),
        createToolCallResponse('list-sites-v1', {}),
      ]);

      const { engine, mockExecutor } = createTestEngine({
        provider: mockProvider,
        abilities: [READONLY_ABILITY],
        maxToolCallsPerTurn: 2,
        executeHandler: () => createSuccessResult({}),
      });

      await engine.sendMessage('Go');

      expect(mockExecutor.execute).toHaveBeenCalledTimes(2);
    });
  });

  // ==========================================================================
  // Golden Test: JSON Parse Retry Logic
  // ==========================================================================

  describe('Golden Test: JSON Parse Retry Logic', () => {
    it('retries on invalid JSON and succeeds', async () => {
      const mockProvider = createMockProvider([
        createInvalidJsonResponse(),
        createAnswerResponse('Success after retry'),
      ]);

      const { engine } = createTestEngine({
        provider: mockProvider,
        abilities: [READONLY_ABILITY],
        maxParseRetries: 2,
      });

      const responses = await engine.sendMessage('Hello');

      expect(responses).toHaveLength(1);
      expect(responses[0]!.type).toBe('message');
      if (responses[0]?.type === 'message') {
        expect(responses[0].content).toBe('Success after retry');
      }
    });

    it('adds retry prompt to message history', async () => {
      const mockProvider = createMockProvider([
        createInvalidJsonResponse(),
        createAnswerResponse('Fixed'),
      ]);

      const { engine } = createTestEngine({
        provider: mockProvider,
        abilities: [READONLY_ABILITY],
      });

      await engine.sendMessage('Hello');

      const history = engine.getHistory();
      // Search for the specific retry prompt text (more specific than "not valid JSON"
      // since the invalid response also contains that substring)
      const retryMessage = history.find(
        (m) => m.role === 'user' && m.content.includes('Your previous response was not valid JSON')
      );
      expect(retryMessage).toBeDefined();
      expect(retryMessage!.role).toBe('user');
    });

    it('fails after max retries exceeded', async () => {
      const mockProvider = createMockProvider([
        createInvalidJsonResponse(),
        createInvalidJsonResponse(),
        createInvalidJsonResponse(),
      ]);

      const { engine } = createTestEngine({
        provider: mockProvider,
        abilities: [READONLY_ABILITY],
        maxParseRetries: 2,
      });

      const responses = await engine.sendMessage('Hello');

      expect(responses).toHaveLength(1);
      expect(responses[0]!.type).toBe('error');
    });

    it('respects custom maxParseRetries', async () => {
      const mockProvider: LLMProvider = {
        name: 'counting-provider',
        capabilities: {
          functionCalling: true,
          streaming: false,
          systemMessages: true,
          vision: false,
          maxContextLength: 4096,
        },
        chat: vi.fn()
          .mockResolvedValueOnce(createInvalidJsonResponse())
          .mockResolvedValue(createAnswerResponse('Success')),
        isConfigured: () => true,
        getModels: () => ['test'],
        getDefaultModel: () => 'test',
      };

      const { engine } = createTestEngine({
        provider: mockProvider,
        abilities: [READONLY_ABILITY],
        maxParseRetries: 1,
      });

      const responses = await engine.sendMessage('Hello');

      // With maxParseRetries: 1, should succeed on second attempt
      expect(mockProvider.chat).toHaveBeenCalledTimes(2);
      expect(responses[0]!.type).toBe('message');
    });

    it('resets retry count after successful parse', async () => {
      const mockProvider = createMockProvider([
        createInvalidJsonResponse(),
        createToolCallResponse('list-sites-v1', {}),
        createAnswerResponse('Done'),
      ]);

      const { engine, mockExecutor } = createTestEngine({
        provider: mockProvider,
        abilities: [READONLY_ABILITY],
        executeHandler: () => createSuccessResult({ sites: [] }),
      });

      await engine.sendMessage('List sites');

      // Should have successfully executed after retry
      expect(mockExecutor.execute).toHaveBeenCalled();
    });

    it('does not retry non-retryable errors', async () => {
      // Create response with valid JSON but unknown tool (non-retryable)
      const mockProvider = createMockProvider([
        {
          content: JSON.stringify({ tool: 'unknown-ability-v1', input: {} }),
          finishReason: 'stop' as const,
          model: 'test',
        },
      ]);

      const { engine } = createTestEngine({
        provider: mockProvider,
        abilities: [READONLY_ABILITY],
      });

      const responses = await engine.sendMessage('Run unknown');

      // Should fail immediately without retry
      expect(responses).toHaveLength(1);
      expect(responses[0]!.type).toBe('error');
      expect(mockProvider.chat).toHaveBeenCalledTimes(1);
    });

    it('handles maxParseRetries: 0', async () => {
      const mockProvider = createMockProvider([
        createInvalidJsonResponse(),
      ]);

      const { engine } = createTestEngine({
        provider: mockProvider,
        abilities: [READONLY_ABILITY],
        maxParseRetries: 0,
      });

      const responses = await engine.sendMessage('Hello');

      // Should fail immediately with no retries
      expect(responses[0]!.type).toBe('error');
      expect(mockProvider.chat).toHaveBeenCalledTimes(1);
    });

    it('handles maxParseRetries: 3', async () => {
      const mockProvider: LLMProvider = {
        name: 'failing-provider',
        capabilities: {
          functionCalling: true,
          streaming: false,
          systemMessages: true,
          vision: false,
          maxContextLength: 4096,
        },
        chat: vi.fn()
          .mockResolvedValueOnce(createInvalidJsonResponse())
          .mockResolvedValueOnce(createInvalidJsonResponse())
          .mockResolvedValueOnce(createInvalidJsonResponse())
          .mockResolvedValue(createAnswerResponse('Finally!')),
        isConfigured: () => true,
        getModels: () => ['test'],
        getDefaultModel: () => 'test',
      };

      const { engine } = createTestEngine({
        provider: mockProvider,
        abilities: [READONLY_ABILITY],
        maxParseRetries: 3,
      });

      const responses = await engine.sendMessage('Hello');

      // 1 initial + 3 retries = 4 total calls
      expect(mockProvider.chat).toHaveBeenCalledTimes(4);
      expect(responses[0]!.type).toBe('message');
    });
  });

  // ==========================================================================
  // Pending Preview State Management Tests
  // ==========================================================================

  describe('Pending Preview State Management', () => {
    it('hasPendingPreview returns false initially', async () => {
      const { engine } = createTestEngine({});
      await engine.initialize();

      expect(engine.hasPendingPreview()).toBe(false);
    });

    it('hasPendingPreview returns true after destructive preview', async () => {
      const mockProvider = createMockProvider([
        createToolCallResponse('delete-site-v1', { site_id: 1 }),
      ]);

      const { engine } = createTestEngine({
        provider: mockProvider,
        abilities: [DESTRUCTIVE_ABILITY],
        executeHandler: () => createPreviewResult([{ id: 1 }]),
      });

      await engine.sendMessage('Delete site');

      expect(engine.hasPendingPreview()).toBe(true);
    });

    it('hasPendingPreview returns false after approval', async () => {
      const mockProvider = createMockProvider([
        createToolCallResponse('delete-site-v1', { site_id: 1 }),
      ]);

      const { engine } = createTestEngine({
        provider: mockProvider,
        abilities: [DESTRUCTIVE_ABILITY],
        executeHandler: (_n, _i, opts) =>
          opts?.dryRun ? createPreviewResult([{ id: 1 }]) : createSuccessResult({ deleted: true }),
      });

      await engine.sendMessage('Delete site');
      await engine.sendMessage('yes');

      expect(engine.hasPendingPreview()).toBe(false);
    });

    it('hasPendingPreview returns false after decline', async () => {
      const mockProvider = createMockProvider([
        createToolCallResponse('delete-site-v1', { site_id: 1 }),
      ]);

      const { engine } = createTestEngine({
        provider: mockProvider,
        abilities: [DESTRUCTIVE_ABILITY],
        executeHandler: () => createPreviewResult([{ id: 1 }]),
      });

      await engine.sendMessage('Delete site');
      await engine.sendMessage('no');

      expect(engine.hasPendingPreview()).toBe(false);
    });

    it('hasPendingPreview returns false after cancelPendingPreview', async () => {
      const mockProvider = createMockProvider([
        createToolCallResponse('delete-site-v1', { site_id: 1 }),
      ]);

      const { engine } = createTestEngine({
        provider: mockProvider,
        abilities: [DESTRUCTIVE_ABILITY],
        executeHandler: () => createPreviewResult([{ id: 1 }]),
      });

      await engine.sendMessage('Delete site');
      engine.cancelPendingPreview();

      expect(engine.hasPendingPreview()).toBe(false);
    });

    it('getPendingPreview returns null initially', async () => {
      const { engine } = createTestEngine({});
      await engine.initialize();

      expect(engine.getPendingPreview()).toBeNull();
    });

    it('getPendingPreview returns correct structure after preview', async () => {
      const mockProvider = createMockProvider([
        createToolCallResponse('delete-site-v1', { site_id: 123 }),
      ]);

      const { engine } = createTestEngine({
        provider: mockProvider,
        abilities: [DESTRUCTIVE_ABILITY],
        executeHandler: () => createPreviewResult([{ id: 123, name: 'Test' }]),
      });

      await engine.sendMessage('Delete site');

      const preview = engine.getPendingPreview();
      expect(preview).not.toBeNull();
      expect(preview!.abilityName).toBe('delete-site-v1');
      expect(preview!.input).toEqual({ site_id: 123 });
      expect(preview!.affected).toHaveLength(1);
      expect(preview!.requiresApproval).toBe(true);
      expect(preview!.summary).toBeDefined();
    });

    it('cancelPendingPreview clears state', async () => {
      const mockProvider = createMockProvider([
        createToolCallResponse('delete-site-v1', { site_id: 1 }),
        createAnswerResponse('OK, cancelled'),
      ]);

      const { engine } = createTestEngine({
        provider: mockProvider,
        abilities: [DESTRUCTIVE_ABILITY],
        executeHandler: () => createPreviewResult([{ id: 1 }]),
      });

      await engine.sendMessage('Delete site');
      expect(engine.hasPendingPreview()).toBe(true);

      engine.cancelPendingPreview();
      expect(engine.hasPendingPreview()).toBe(false);
      expect(engine.getPendingPreview()).toBeNull();
    });

    it('clearHistory also clears pending preview', async () => {
      const mockProvider = createMockProvider([
        createToolCallResponse('delete-site-v1', { site_id: 1 }),
      ]);

      const { engine } = createTestEngine({
        provider: mockProvider,
        abilities: [DESTRUCTIVE_ABILITY],
        executeHandler: () => createPreviewResult([{ id: 1 }]),
      });

      await engine.sendMessage('Delete site');
      expect(engine.hasPendingPreview()).toBe(true);

      engine.clearHistory();
      expect(engine.hasPendingPreview()).toBe(false);
    });
  });

  // ==========================================================================
  // Message History Management Tests
  // ==========================================================================

  describe('Message History Management', () => {
    it('getHistory returns copy of messages', async () => {
      const { engine } = createTestEngine({});
      await engine.initialize();

      const history1 = engine.getHistory();
      const history2 = engine.getHistory();

      expect(history1).not.toBe(history2);
      expect(history1).toEqual(history2);
    });

    it('modifying returned history does not affect internal state', async () => {
      const { engine } = createTestEngine({});
      await engine.initialize();

      const history = engine.getHistory();
      history.push({ role: 'user', content: 'Injected!' });

      const freshHistory = engine.getHistory();
      expect(freshHistory).not.toContainEqual({ role: 'user', content: 'Injected!' });
    });

    it('history includes system prompt, user, assistant, and tool messages', async () => {
      const mockProvider = createMockProvider([
        createToolCallResponse('list-sites-v1', {}),
        createAnswerResponse('Here are your sites'),
      ]);

      const { engine } = createTestEngine({
        provider: mockProvider,
        abilities: [READONLY_ABILITY],
        executeHandler: () => createSuccessResult({ sites: [] }),
      });

      await engine.sendMessage('List sites');

      const history = engine.getHistory();

      expect(history.some((m) => m.role === 'system')).toBe(true);
      expect(history.some((m) => m.role === 'user')).toBe(true);
      expect(history.some((m) => m.role === 'assistant')).toBe(true);
      expect(history.some((m) => m.role === 'tool')).toBe(true);
    });

    it('clearHistory preserves system prompt', async () => {
      const { engine } = createTestEngine({});
      await engine.initialize();

      const beforeClear = engine.getHistory();
      expect(beforeClear).toHaveLength(1);

      engine.clearHistory();

      const afterClear = engine.getHistory();
      expect(afterClear).toHaveLength(1);
      expect(afterClear[0]!.role).toBe('system');
    });

    it('clearHistory removes all other messages', async () => {
      const mockProvider = createMockProvider([
        createAnswerResponse('Hello!'),
      ]);

      const { engine } = createTestEngine({ provider: mockProvider });

      await engine.sendMessage('Hi');

      const before = engine.getHistory();
      expect(before.length).toBeGreaterThan(1);

      engine.clearHistory();

      const after = engine.getHistory();
      expect(after).toHaveLength(1);
    });

    it('messages accumulate across multiple sendMessage calls', async () => {
      const mockProvider = createMockProvider([
        createAnswerResponse('Response 1'),
        createAnswerResponse('Response 2'),
        createAnswerResponse('Response 3'),
      ]);

      const { engine } = createTestEngine({ provider: mockProvider });

      await engine.sendMessage('Message 1');
      await engine.sendMessage('Message 2');
      await engine.sendMessage('Message 3');

      const history = engine.getHistory();
      // 1 system + 3 user + 3 assistant = 7
      expect(history).toHaveLength(7);
    });

    it('tool messages have correct structure', async () => {
      const mockProvider = createMockProvider([
        createNativeToolCallResponse('list-sites-v1', {}, 'call_abc123'),
        createAnswerResponse('Done'),
      ]);

      const { engine } = createTestEngine({
        provider: mockProvider,
        abilities: [READONLY_ABILITY],
        executeHandler: () => createSuccessResult({ sites: [{ id: 1 }] }),
      });

      await engine.sendMessage('List sites');

      const history = engine.getHistory();
      const toolMessage = history.find((m) => m.role === 'tool');

      expect(toolMessage).toBeDefined();
      expect(toolMessage!.toolCallId).toBe('call_abc123');
      expect(toolMessage!.toolName).toBe('list-sites-v1');
      expect(toolMessage!.content).toBeDefined();
    });
  });

  // ==========================================================================
  // Error Handling Tests
  // ==========================================================================

  describe('Error Handling', () => {
    it('returns error for unknown ability', async () => {
      const mockProvider = createMockProvider([
        createToolCallResponse('unknown-ability-v1', {}),
      ]);

      const { engine, mockExecutor } = createTestEngine({
        provider: mockProvider,
        abilities: [READONLY_ABILITY],
      });

      const responses = await engine.sendMessage('Run unknown');

      expect(responses[0]!.type).toBe('error');
      if (responses[0]?.type === 'error') {
        expect(responses[0].error).toContain('unknown-ability-v1');
      }
      expect(mockExecutor.execute).not.toHaveBeenCalled();
    });

    it('returns error when executor throws', async () => {
      const mockProvider = createMockProvider([
        createToolCallResponse('list-sites-v1', {}),
      ]);

      const { engine } = createTestEngine({
        provider: mockProvider,
        abilities: [READONLY_ABILITY],
        executeHandler: () => {
          throw new Error('Executor failed');
        },
      });

      const responses = await engine.sendMessage('List sites');

      expect(responses[0]!.type).toBe('error');
      if (responses[0]?.type === 'error') {
        expect(responses[0].error).toContain('Executor failed');
      }
    });

    it('stops on execution error', async () => {
      const infiniteProvider: LLMProvider = {
        name: 'infinite',
        capabilities: {
          functionCalling: true,
          streaming: false,
          systemMessages: true,
          vision: false,
          maxContextLength: 4096,
        },
        chat: vi.fn(async () => createToolCallResponse('list-sites-v1', {})),
        isConfigured: () => true,
        getModels: () => ['test'],
        getDefaultModel: () => 'test',
      };

      const { engine, mockExecutor } = createTestEngine({
        provider: infiniteProvider,
        abilities: [READONLY_ABILITY],
        maxToolCallsPerTurn: 5,
        executeHandler: () => {
          throw new Error('Always fails');
        },
      });

      await engine.sendMessage('Go');

      // Should stop after first error, not continue trying
      expect(mockExecutor.execute).toHaveBeenCalledTimes(1);
    });

    it('returns error when preview execution fails', async () => {
      const mockProvider = createMockProvider([
        createToolCallResponse('delete-site-v1', { site_id: 999 }),
      ]);

      const { engine } = createTestEngine({
        provider: mockProvider,
        abilities: [DESTRUCTIVE_ABILITY],
        executeHandler: () => createErrorResult('NOT_FOUND', 'Site not found'),
      });

      const responses = await engine.sendMessage('Delete site 999');

      expect(responses[0]!.type).toBe('error');
      expect(engine.hasPendingPreview()).toBe(false);
    });

    it('handles preview execution throwing', async () => {
      const mockProvider = createMockProvider([
        createToolCallResponse('delete-site-v1', { site_id: 1 }),
      ]);

      const { engine } = createTestEngine({
        provider: mockProvider,
        abilities: [DESTRUCTIVE_ABILITY],
        executeHandler: () => {
          throw new Error('Network error');
        },
      });

      const responses = await engine.sendMessage('Delete site');

      expect(responses[0]!.type).toBe('error');
      expect(engine.hasPendingPreview()).toBe(false);
    });

    it('adds error to tool message in history', async () => {
      const mockProvider = createMockProvider([
        createToolCallResponse('list-sites-v1', {}),
      ]);

      const { engine } = createTestEngine({
        provider: mockProvider,
        abilities: [READONLY_ABILITY],
        executeHandler: () => {
          throw new Error('Connection failed');
        },
      });

      await engine.sendMessage('List sites');

      const history = engine.getHistory();
      const toolMessage = history.find((m) => m.role === 'tool');
      expect(toolMessage).toBeDefined();
      expect(toolMessage!.content).toContain('error');
    });
  });

  // ==========================================================================
  // Integration Tests
  // ==========================================================================

  describe('Integration Tests', () => {
    it('complete destructive flow: message → preview → approval → execution → answer', async () => {
      const mockProvider = createMockProvider([
        createToolCallResponse('delete-site-v1', { site_id: 123 }),
        createAnswerResponse('Site 123 has been deleted.'),
      ]);

      let executionCount = 0;
      const { engine, mockExecutor } = createTestEngine({
        provider: mockProvider,
        abilities: [DESTRUCTIVE_ABILITY],
        executeHandler: (_name, _input, options) => {
          executionCount++;
          if (options?.dryRun) {
            return createPreviewResult([{ id: 123, name: 'Test Site' }]);
          }
          if (options?.confirm) {
            return createSuccessResult({ deleted: true, id: 123 });
          }
          return createErrorResult('UNEXPECTED', 'Unexpected');
        },
      });

      // Step 1: User sends message
      const step1 = await engine.sendMessage('Delete site 123');
      expect(step1[0]!.type).toBe('preview');
      expect(engine.hasPendingPreview()).toBe(true);

      // Step 2: User approves
      const step2 = await engine.sendMessage('yes');
      expect(step2[0]!.type).toBe('tool_result');
      expect(engine.hasPendingPreview()).toBe(false);

      // Verify execution happened correctly
      expect(mockExecutor.execute).toHaveBeenCalledTimes(2);
      expect(mockExecutor.execute).toHaveBeenNthCalledWith(1, 'delete-site-v1', { site_id: 123 }, { dryRun: true });
      expect(mockExecutor.execute).toHaveBeenNthCalledWith(2, 'delete-site-v1', { site_id: 123 }, { confirm: true });
    });

    it('mixed readonly and destructive in sequence', async () => {
      const mockProvider = createMockProvider([
        createToolCallResponse('list-sites-v1', {}),
        createToolCallResponse('delete-site-v1', { site_id: 1 }),
      ]);

      const { engine, mockExecutor } = createTestEngine({
        provider: mockProvider,
        abilities: [READONLY_ABILITY, DESTRUCTIVE_ABILITY],
        maxToolCallsPerTurn: 5,
        executeHandler: (_name, _input, options) => {
          if (options?.dryRun) {
            return createPreviewResult([{ id: 1 }]);
          }
          return createSuccessResult({ result: 'ok' });
        },
      });

      const responses = await engine.sendMessage('List sites then delete site 1');

      // First call (readonly) should execute directly
      expect(mockExecutor.execute).toHaveBeenNthCalledWith(1, 'list-sites-v1', {});

      // Second call (destructive) should preview
      expect(mockExecutor.execute).toHaveBeenNthCalledWith(2, 'delete-site-v1', { site_id: 1 }, { dryRun: true });

      // Should have preview pending
      expect(engine.hasPendingPreview()).toBe(true);
    });

    it('tool call chain with multiple readonly calls', async () => {
      const mockProvider = createMockProvider([
        createToolCallResponse('list-sites-v1', { page: 1 }),
        createToolCallResponse('list-sites-v1', { page: 2 }),
        createAnswerResponse('Found 20 sites across 2 pages'),
      ]);

      const { engine, mockExecutor } = createTestEngine({
        provider: mockProvider,
        abilities: [READONLY_ABILITY],
        maxToolCallsPerTurn: 5,
        executeHandler: () => createSuccessResult({ sites: [{ id: 1 }] }),
      });

      const responses = await engine.sendMessage('List all sites');

      expect(mockExecutor.execute).toHaveBeenCalledTimes(2);

      // Should end with an answer
      const answer = responses.find((r) => r.type === 'message');
      expect(answer).toBeDefined();
    });

    it('conversation across multiple turns', async () => {
      const mockProvider = createMockProvider([
        createToolCallResponse('list-sites-v1', {}),
        createAnswerResponse('You have 5 sites'),
        createAnswerResponse('What would you like to do with them?'),
      ]);

      const { engine, mockExecutor } = createTestEngine({
        provider: mockProvider,
        abilities: [READONLY_ABILITY],
        executeHandler: () => createSuccessResult({ sites: [] }),
      });

      await engine.sendMessage('How many sites?');
      await engine.sendMessage('Tell me more');

      // Tool was only called in first turn
      expect(mockExecutor.execute).toHaveBeenCalledTimes(1);

      // History should accumulate
      const history = engine.getHistory();
      const userMessages = history.filter((m) => m.role === 'user');
      expect(userMessages).toHaveLength(2);
    });
  });

  // ==========================================================================
  // Edge Cases and Boundary Conditions
  // ==========================================================================

  describe('Edge Cases and Boundary Conditions', () => {
    it('handles ability without annotations (defaults to safe)', async () => {
      const mockProvider = createMockProvider([
        createToolCallResponse('legacy-ability-v1', {}),
        createAnswerResponse('Done'),
      ]);

      const { engine, mockExecutor } = createTestEngine({
        provider: mockProvider,
        abilities: [ABILITY_WITHOUT_ANNOTATIONS],
        executeHandler: () => createSuccessResult({ result: 'ok' }),
      });

      await engine.sendMessage('Run legacy');

      // Should execute directly (no preview)
      expect(mockExecutor.execute).toHaveBeenCalledWith('legacy-ability-v1', {});
      expect(engine.hasPendingPreview()).toBe(false);
    });

    it('handles LLM returning answer immediately', async () => {
      const mockProvider = createMockProvider([
        createAnswerResponse('I can help you with that!'),
      ]);

      const { engine, mockExecutor } = createTestEngine({
        provider: mockProvider,
        abilities: [READONLY_ABILITY],
      });

      const responses = await engine.sendMessage('Hello');

      expect(mockExecutor.execute).not.toHaveBeenCalled();
      expect(responses[0]!.type).toBe('message');
      if (responses[0]?.type === 'message') {
        expect(responses[0].content).toBe('I can help you with that!');
      }
    });

    it('handles tool call with empty input object', async () => {
      const mockProvider = createMockProvider([
        createToolCallResponse('list-sites-v1', {}),
        createAnswerResponse('Done'),
      ]);

      const { engine, mockExecutor } = createTestEngine({
        provider: mockProvider,
        abilities: [READONLY_ABILITY],
        executeHandler: () => createSuccessResult({ sites: [] }),
      });

      await engine.sendMessage('List sites');

      expect(mockExecutor.execute).toHaveBeenCalledWith('list-sites-v1', {});
    });

    it('handles sequential sendMessage with pending preview', async () => {
      const mockProvider = createMockProvider([
        createToolCallResponse('delete-site-v1', { site_id: 1 }),
      ]);

      const { engine } = createTestEngine({
        provider: mockProvider,
        abilities: [DESTRUCTIVE_ABILITY],
        executeHandler: (_n, _i, opts) =>
          opts?.dryRun ? createPreviewResult([{ id: 1 }]) : createSuccessResult({ deleted: true }),
      });

      await engine.sendMessage('Delete site 1');
      expect(engine.hasPendingPreview()).toBe(true);

      // Second message should be treated as approval/decline
      await engine.sendMessage('no');
      expect(engine.hasPendingPreview()).toBe(false);
    });

    it('getProviderInfo returns correct info', async () => {
      const { engine } = createTestEngine({
        model: 'gpt-4',
      });

      await engine.initialize();

      const info = engine.getProviderInfo();
      expect(info.name).toBe('mock-provider');
      expect(info.model).toBe('gpt-4');
    });

    it('getProviderInfo uses default model if not specified', async () => {
      const { engine } = createTestEngine({});

      await engine.initialize();

      const info = engine.getProviderInfo();
      expect(info.model).toBe('test-model');
    });

    it('handles tool call with extra unknown parameters', async () => {
      const mockProvider = createMockProvider([
        createToolCallResponse('list-sites-v1', { extra_param: 'ignored', another: 123 }),
        createAnswerResponse('Done'),
      ]);

      const { engine, mockExecutor } = createTestEngine({
        provider: mockProvider,
        abilities: [READONLY_ABILITY],
        executeHandler: () => createSuccessResult({ sites: [] }),
      });

      await engine.sendMessage('List sites');

      // Should still execute with the provided input
      expect(mockExecutor.execute).toHaveBeenCalledWith('list-sites-v1', { extra_param: 'ignored', another: 123 });
    });

    it('handles preview with multiple affected items', async () => {
      const mockProvider = createMockProvider([
        createToolCallResponse('delete-site-v1', { site_id: 0 }),
      ]);

      const manyItems = Array.from({ length: 50 }, (_, i) => ({ id: i, name: `Site ${i}` }));

      const { engine } = createTestEngine({
        provider: mockProvider,
        abilities: [DESTRUCTIVE_ABILITY],
        executeHandler: () => createPreviewResult(manyItems),
      });

      await engine.sendMessage('Delete all');

      const preview = engine.getPendingPreview();
      expect(preview!.affected).toHaveLength(50);
      expect(preview!.summary).toContain('50 items');
    });

    it('generates correct summary for different action verbs', async () => {
      const updateAbility = createTestAbility('update-site-v1', { destructive: true });
      const mockProvider = createMockProvider([
        createToolCallResponse('update-site-v1', { site_id: 1 }),
      ]);

      const { engine } = createTestEngine({
        provider: mockProvider,
        abilities: [updateAbility],
        executeHandler: () => createPreviewResult([{ id: 1 }]),
      });

      await engine.sendMessage('Update site');

      const preview = engine.getPendingPreview();
      expect(preview!.summary).toContain('updated');
    });
  });
});
