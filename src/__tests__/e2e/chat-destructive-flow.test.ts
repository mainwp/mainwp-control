/**
 * E2E Test: Chat → Destructive Action Integration Flow
 *
 * Tests the complete chat workflow including destructive action preview
 * and approval. Verifies safety controller behavior, preview flow,
 * and user approval handling.
 *
 * INVARIANTS TESTED:
 * - SafetyController enforces preview-before-execution
 * - `dry_run` and `confirm` are mutually exclusive
 * - Preview displays affected items correctly
 * - User approval/decline handled properly
 * - Readonly abilities bypass preview flow
 * - Tool call limits enforced per turn
 * - JSON retry logic works with max attempts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createMockAbility,
  createMockProvider,
  createMockLLMToolCallResponse,
  createMockLLMAnswerResponse,
  createMockExecutor,
  createSuccessResult,
  createPreviewResult,
  createErrorResult,
  STANDARD_ABILITIES,
  setupE2ETest,
  cleanupE2ETest,
} from './test-helpers.js';
import type { LLMProvider, LLMResponse } from '../../chat/providers/provider.js';
import type { ExecutionOptions } from '../../core/abilities-executor.js';

// ============================================================================
// Imports
// ============================================================================

import { ChatEngine, createChatEngine } from '../../chat/chat-engine.js';

// ============================================================================
// Test Fixtures
// ============================================================================

/**
 * Create a test ChatEngine with mocks
 */
function createTestEngine(options: {
  provider?: LLMProvider;
  abilities?: ReturnType<typeof createMockAbility>[];
  executeHandler?: (
    name: string,
    input: Record<string, unknown>,
    options?: ExecutionOptions
  ) => ReturnType<typeof createSuccessResult>;
  maxToolCallsPerTurn?: number;
  maxParseRetries?: number;
}): {
  engine: ChatEngine;
  mockProvider: LLMProvider;
  mockExecutor: ReturnType<typeof createMockExecutor>;
} {
  const abilities = options.abilities ?? [
    STANDARD_ABILITIES.listSites,
    STANDARD_ABILITIES.deleteSite,
  ];
  const mockExecutor = createMockExecutor({
    abilities,
    executeHandler: options.executeHandler,
  });
  const mockProvider = options.provider ?? createMockProvider([
    createMockLLMAnswerResponse('Hello'),
  ]);

  const engine = createChatEngine({
    provider: mockProvider,
    executor: mockExecutor as never,
    maxToolCallsPerTurn: options.maxToolCallsPerTurn,
    maxParseRetries: options.maxParseRetries,
  });

  return { engine, mockProvider, mockExecutor };
}

/**
 * Create an invalid JSON LLM response
 */
function createInvalidJsonResponse(): LLMResponse {
  return {
    content: '{"type": "tool_call", "tool": broken',
    finishReason: 'stop',
    model: 'test-model',
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('E2E: Chat → Destructive Action Flow', () => {
  afterEach(() => {
    cleanupE2ETest();
  });

  // ==========================================================================
  // Complete Destructive Action Flow (Interactive Mode)
  // ==========================================================================

  describe('Complete Destructive Action Flow', () => {
    it('previews destructive action with dry_run first', async () => {
      const mockProvider = createMockProvider([
        createMockLLMToolCallResponse('delete-site-v1', { site_id: 123 }),
      ]);

      const { engine, mockExecutor } = createTestEngine({
        provider: mockProvider,
        abilities: [STANDARD_ABILITIES.deleteSite],
        executeHandler: (_name, _input, options) => {
          if (options?.dryRun) {
            return createPreviewResult([{ id: 123, name: 'Site to delete' }]);
          }
          return createSuccessResult({ deleted: true });
        },
      });

      await engine.sendMessage('Delete site 123');

      // Verify dry_run was sent (full ability name with mainwp/ prefix)
      expect(mockExecutor.execute).toHaveBeenCalledWith(
        'mainwp/delete-site-v1',
        { site_id: 123 },
        { dryRun: true }
      );
    });

    it('sets pending preview state after destructive preview', async () => {
      const mockProvider = createMockProvider([
        createMockLLMToolCallResponse('delete-site-v1', { site_id: 123 }),
      ]);

      const { engine } = createTestEngine({
        provider: mockProvider,
        abilities: [STANDARD_ABILITIES.deleteSite],
        executeHandler: () => createPreviewResult([{ id: 123 }]),
      });

      await engine.sendMessage('Delete site 123');

      expect(engine.hasPendingPreview()).toBe(true);
      const preview = engine.getPendingPreview();
      expect(preview).not.toBeNull();
      expect(preview!.abilityName).toBe('mainwp/delete-site-v1');
      expect(preview!.requiresApproval).toBe(true);
    });

    it('executes with confirm after user approval', async () => {
      const mockProvider = createMockProvider([
        createMockLLMToolCallResponse('delete-site-v1', { site_id: 123 }),
      ]);

      const { engine, mockExecutor } = createTestEngine({
        provider: mockProvider,
        abilities: [STANDARD_ABILITIES.deleteSite],
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

      // Step 1: Trigger preview
      await engine.sendMessage('Delete site 123');
      expect(engine.hasPendingPreview()).toBe(true);

      // Step 2: Approve
      await engine.sendMessage('yes');

      // Verify confirm was sent
      expect(mockExecutor.execute).toHaveBeenLastCalledWith(
        'mainwp/delete-site-v1',
        { site_id: 123 },
        { confirm: true }
      );
    });

    it('clears pending preview after approval', async () => {
      const mockProvider = createMockProvider([
        createMockLLMToolCallResponse('delete-site-v1', { site_id: 123 }),
      ]);

      const { engine } = createTestEngine({
        provider: mockProvider,
        abilities: [STANDARD_ABILITIES.deleteSite],
        executeHandler: (_n, _i, opts) =>
          opts?.dryRun ? createPreviewResult([{ id: 123 }]) : createSuccessResult({ deleted: true }),
      });

      await engine.sendMessage('Delete site 123');
      await engine.sendMessage('yes');

      expect(engine.hasPendingPreview()).toBe(false);
      expect(engine.getPendingPreview()).toBeNull();
    });

    it('returns tool_result response after approval', async () => {
      const mockProvider = createMockProvider([
        createMockLLMToolCallResponse('delete-site-v1', { site_id: 123 }),
      ]);

      const { engine } = createTestEngine({
        provider: mockProvider,
        abilities: [STANDARD_ABILITIES.deleteSite],
        executeHandler: (_n, _i, opts) =>
          opts?.dryRun ? createPreviewResult([{ id: 123 }]) : createSuccessResult({ deleted: true }),
      });

      await engine.sendMessage('Delete site 123');
      const responses = await engine.sendMessage('yes');

      expect(responses[0]!.type).toBe('tool_result');
    });

    it('includes preview and result in tool_result response', async () => {
      const mockProvider = createMockProvider([
        createMockLLMToolCallResponse('delete-site-v1', { site_id: 123 }),
      ]);

      const { engine } = createTestEngine({
        provider: mockProvider,
        abilities: [STANDARD_ABILITIES.deleteSite],
        executeHandler: (_n, _i, opts) =>
          opts?.dryRun ? createPreviewResult([{ id: 123 }]) : createSuccessResult({ deleted: true }),
      });

      await engine.sendMessage('Delete site 123');
      const responses = await engine.sendMessage('yes');

      if (responses[0]?.type === 'tool_result') {
        expect(responses[0].result).toBeDefined();
        expect(responses[0].preview).toBeDefined();
        expect(responses[0].preview!.abilityName).toBe('mainwp/delete-site-v1');
      }
    });
  });

  // ==========================================================================
  // User Declines Destructive Action
  // ==========================================================================

  describe('User Declines Destructive Action', () => {
    async function setupPreviewState(): Promise<{
      engine: ChatEngine;
      mockExecutor: ReturnType<typeof createMockExecutor>;
    }> {
      const mockProvider = createMockProvider([
        createMockLLMToolCallResponse('delete-site-v1', { site_id: 123 }),
      ]);

      const { engine, mockExecutor } = createTestEngine({
        provider: mockProvider,
        abilities: [STANDARD_ABILITIES.deleteSite],
        executeHandler: (_name, _input, options) => {
          if (options?.dryRun) {
            return createPreviewResult([{ id: 123 }]);
          }
          return createSuccessResult({ deleted: true });
        },
      });

      await engine.sendMessage('Delete site 123');
      expect(engine.hasPendingPreview()).toBe(true);

      // Clear mock call count after setup
      mockExecutor.execute.mockClear();

      return { engine, mockExecutor };
    }

    it('does NOT execute on decline with "no"', async () => {
      const { engine, mockExecutor } = await setupPreviewState();

      await engine.sendMessage('no');

      expect(mockExecutor.execute).not.toHaveBeenCalled();
    });

    it('does NOT execute on decline with "cancel"', async () => {
      const { engine, mockExecutor } = await setupPreviewState();

      await engine.sendMessage('cancel');

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
      }
    });

    it('treats arbitrary text as decline', async () => {
      const { engine, mockExecutor } = await setupPreviewState();

      await engine.sendMessage('I changed my mind');

      expect(mockExecutor.execute).not.toHaveBeenCalled();
      expect(engine.hasPendingPreview()).toBe(false);
    });
  });

  // ==========================================================================
  // Readonly Action Executes Directly
  // ==========================================================================

  describe('Readonly Action Executes Directly', () => {
    it('executes readonly ability immediately without preview', async () => {
      const mockProvider = createMockProvider([
        createMockLLMToolCallResponse('list-sites-v1', {}),
        createMockLLMAnswerResponse('Here are your sites'),
      ]);

      const { engine, mockExecutor } = createTestEngine({
        provider: mockProvider,
        abilities: [STANDARD_ABILITIES.listSites],
        executeHandler: () => createSuccessResult({ sites: [{ id: 1, name: 'Test Site' }] }),
      });

      await engine.sendMessage('List my sites');

      // Should be called without dryRun (uses full ability name)
      expect(mockExecutor.execute).toHaveBeenCalledWith('mainwp/list-sites-v1', {});
      expect(mockExecutor.execute).not.toHaveBeenCalledWith(
        'mainwp/list-sites-v1',
        {},
        expect.objectContaining({ dryRun: true })
      );
    });

    it('does not set pending preview for readonly ability', async () => {
      const mockProvider = createMockProvider([
        createMockLLMToolCallResponse('list-sites-v1', {}),
        createMockLLMAnswerResponse('Done'),
      ]);

      const { engine } = createTestEngine({
        provider: mockProvider,
        abilities: [STANDARD_ABILITIES.listSites],
        executeHandler: () => createSuccessResult({ sites: [] }),
      });

      await engine.sendMessage('List my sites');

      expect(engine.hasPendingPreview()).toBe(false);
      expect(engine.getPendingPreview()).toBeNull();
    });

    it('returns tool_result response for readonly ability', async () => {
      const mockProvider = createMockProvider([
        createMockLLMToolCallResponse('list-sites-v1', {}),
        createMockLLMAnswerResponse('Done'),
      ]);

      const { engine } = createTestEngine({
        provider: mockProvider,
        abilities: [STANDARD_ABILITIES.listSites],
        executeHandler: () => createSuccessResult({ sites: [{ id: 1 }] }),
      });

      const responses = await engine.sendMessage('List sites');

      const toolResult = responses.find((r) => r.type === 'tool_result');
      expect(toolResult).toBeDefined();
      expect(toolResult!.type).toBe('tool_result');
    });
  });

  // ==========================================================================
  // Destructive Action in Non-Interactive Mode
  // ==========================================================================

  describe('Destructive Action - Non-Interactive Mode', () => {
    it('shows preview and halts for destructive action', async () => {
      const mockProvider = createMockProvider([
        createMockLLMToolCallResponse('delete-site-v1', { site_id: 123 }),
      ]);

      const { engine } = createTestEngine({
        provider: mockProvider,
        abilities: [STANDARD_ABILITIES.deleteSite],
        executeHandler: () => createPreviewResult([{ id: 123, name: 'Site' }]),
      });

      const responses = await engine.sendMessage('Delete site 123');

      // Should return preview response
      expect(responses).toHaveLength(1);
      expect(responses[0]!.type).toBe('preview');

      // Should have pending preview
      expect(engine.hasPendingPreview()).toBe(true);
    });

    it('preview response indicates approval required', async () => {
      const mockProvider = createMockProvider([
        createMockLLMToolCallResponse('delete-site-v1', { site_id: 123 }),
      ]);

      const { engine } = createTestEngine({
        provider: mockProvider,
        abilities: [STANDARD_ABILITIES.deleteSite],
        executeHandler: () => createPreviewResult([{ id: 123 }]),
      });

      const responses = await engine.sendMessage('Delete site 123');

      if (responses[0]?.type === 'preview') {
        expect(responses[0].requiresApproval).toBe(true);
      }
    });
  });

  // ==========================================================================
  // Max Tool Calls Per Turn Enforcement
  // ==========================================================================

  describe('Max Tool Calls Per Turn Enforcement', () => {
    it('enforces maxToolCallsPerTurn limit', async () => {
      // Provider always returns another tool call
      const infiniteProvider: LLMProvider = {
        name: 'infinite-provider',
        capabilities: {
          functionCalling: true,
          streaming: false,
          systemMessages: true,
          vision: false,
          maxContextLength: 4096,
        },
        chat: vi.fn(async () => createMockLLMToolCallResponse('list-sites-v1', {})),
        isConfigured: () => true,
        getModels: () => ['test-model'],
        getDefaultModel: () => 'test-model',
      };

      const { engine, mockExecutor } = createTestEngine({
        provider: infiniteProvider,
        abilities: [STANDARD_ABILITIES.listSites],
        maxToolCallsPerTurn: 3,
        executeHandler: () => createSuccessResult({ sites: [] }),
      });

      await engine.sendMessage('List all sites');

      // Should have executed exactly 3 tools
      expect(mockExecutor.execute).toHaveBeenCalledTimes(3);
    });

    it('respects custom maxToolCallsPerTurn value', async () => {
      const infiniteProvider: LLMProvider = {
        name: 'infinite-provider',
        capabilities: {
          functionCalling: true,
          streaming: false,
          systemMessages: true,
          vision: false,
          maxContextLength: 4096,
        },
        chat: vi.fn(async () => createMockLLMToolCallResponse('list-sites-v1', {})),
        isConfigured: () => true,
        getModels: () => ['test-model'],
        getDefaultModel: () => 'test-model',
      };

      const { engine, mockExecutor } = createTestEngine({
        provider: infiniteProvider,
        abilities: [STANDARD_ABILITIES.listSites],
        maxToolCallsPerTurn: 1,
        executeHandler: () => createSuccessResult({ sites: [] }),
      });

      await engine.sendMessage('List sites');

      expect(mockExecutor.execute).toHaveBeenCalledTimes(1);
    });

    it('resets counter between sendMessage calls', async () => {
      const turnProvider: LLMProvider = {
        name: 'turn-provider',
        capabilities: {
          functionCalling: true,
          streaming: false,
          systemMessages: true,
          vision: false,
          maxContextLength: 4096,
        },
        chat: vi.fn(async () => createMockLLMToolCallResponse('list-sites-v1', {})),
        isConfigured: () => true,
        getModels: () => ['test-model'],
        getDefaultModel: () => 'test-model',
      };

      const { engine, mockExecutor } = createTestEngine({
        provider: turnProvider,
        abilities: [STANDARD_ABILITIES.listSites],
        maxToolCallsPerTurn: 1,
        executeHandler: () => createSuccessResult({ sites: [] }),
      });

      await engine.sendMessage('First request');
      await engine.sendMessage('Second request');

      // Each turn should allow 1 tool call
      expect(mockExecutor.execute).toHaveBeenCalledTimes(2);
    });

    it('returns message about max tool calls reached', async () => {
      const infiniteProvider: LLMProvider = {
        name: 'infinite-provider',
        capabilities: {
          functionCalling: true,
          streaming: false,
          systemMessages: true,
          vision: false,
          maxContextLength: 4096,
        },
        chat: vi.fn(async () => createMockLLMToolCallResponse('list-sites-v1', {})),
        isConfigured: () => true,
        getModels: () => ['test-model'],
        getDefaultModel: () => 'test-model',
      };

      const { engine } = createTestEngine({
        provider: infiniteProvider,
        abilities: [STANDARD_ABILITIES.listSites],
        maxToolCallsPerTurn: 2,
        executeHandler: () => createSuccessResult({ sites: [] }),
      });

      const responses = await engine.sendMessage('List all sites');

      // Should have a message about max tool calls
      const maxCallsMessage = responses.find(
        (r) => r.type === 'message' && r.content.includes('maximum tool calls')
      );
      expect(maxCallsMessage).toBeDefined();
    });
  });

  // ==========================================================================
  // JSON Parse Retry Logic
  // ==========================================================================

  describe('JSON Parse Retry Logic', () => {
    it('retries on invalid JSON and succeeds', async () => {
      const mockProvider = createMockProvider([
        createInvalidJsonResponse(),
        createMockLLMAnswerResponse('Success after retry'),
      ]);

      const { engine } = createTestEngine({
        provider: mockProvider,
        abilities: [STANDARD_ABILITIES.listSites],
        maxParseRetries: 2,
      });

      const responses = await engine.sendMessage('Hello');

      expect(responses).toHaveLength(1);
      expect(responses[0]!.type).toBe('message');
      if (responses[0]?.type === 'message') {
        expect(responses[0].content).toBe('Success after retry');
      }
    });

    it('fails after max retries exceeded', async () => {
      const mockProvider = createMockProvider([
        createInvalidJsonResponse(),
        createInvalidJsonResponse(),
        createInvalidJsonResponse(),
      ]);

      const { engine } = createTestEngine({
        provider: mockProvider,
        abilities: [STANDARD_ABILITIES.listSites],
        maxParseRetries: 2,
      });

      const responses = await engine.sendMessage('Hello');

      expect(responses).toHaveLength(1);
      expect(responses[0]!.type).toBe('error');
    });

    it('adds retry prompt to message history', async () => {
      const mockProvider = createMockProvider([
        createInvalidJsonResponse(),
        createMockLLMAnswerResponse('Fixed'),
      ]);

      const { engine } = createTestEngine({
        provider: mockProvider,
        abilities: [STANDARD_ABILITIES.listSites],
      });

      await engine.sendMessage('Hello');

      const history = engine.getHistory();
      const retryMessage = history.find(
        (m) => m.role === 'user' && m.content.includes('Your previous response was not valid JSON')
      );
      expect(retryMessage).toBeDefined();
    });

    it('respects maxParseRetries: 0', async () => {
      const mockProvider = createMockProvider([
        createInvalidJsonResponse(),
      ]);

      const { engine } = createTestEngine({
        provider: mockProvider,
        abilities: [STANDARD_ABILITIES.listSites],
        maxParseRetries: 0,
      });

      const responses = await engine.sendMessage('Hello');

      // Should fail immediately with no retries
      expect(responses[0]!.type).toBe('error');
      expect(mockProvider.chat).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // Tool Execution Error Handling
  // ==========================================================================

  describe('Tool Execution Error Handling', () => {
    it('returns error for unknown ability', async () => {
      const mockProvider = createMockProvider([
        createMockLLMToolCallResponse('unknown-ability-v1', {}),
      ]);

      const { engine, mockExecutor } = createTestEngine({
        provider: mockProvider,
        abilities: [STANDARD_ABILITIES.listSites],
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
        createMockLLMToolCallResponse('list-sites-v1', {}),
      ]);

      const { engine } = createTestEngine({
        provider: mockProvider,
        abilities: [STANDARD_ABILITIES.listSites],
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

    it('stops execution after error', async () => {
      const infiniteProvider: LLMProvider = {
        name: 'infinite',
        capabilities: {
          functionCalling: true,
          streaming: false,
          systemMessages: true,
          vision: false,
          maxContextLength: 4096,
        },
        chat: vi.fn(async () => createMockLLMToolCallResponse('list-sites-v1', {})),
        isConfigured: () => true,
        getModels: () => ['test'],
        getDefaultModel: () => 'test',
      };

      const { engine, mockExecutor } = createTestEngine({
        provider: infiniteProvider,
        abilities: [STANDARD_ABILITIES.listSites],
        maxToolCallsPerTurn: 5,
        executeHandler: () => {
          throw new Error('Always fails');
        },
      });

      await engine.sendMessage('Go');

      // Should stop after first error
      expect(mockExecutor.execute).toHaveBeenCalledTimes(1);
    });

    it('handles preview execution error', async () => {
      const mockProvider = createMockProvider([
        createMockLLMToolCallResponse('delete-site-v1', { site_id: 999 }),
      ]);

      const { engine } = createTestEngine({
        provider: mockProvider,
        abilities: [STANDARD_ABILITIES.deleteSite],
        executeHandler: () => createErrorResult('NOT_FOUND', 'Site not found'),
      });

      const responses = await engine.sendMessage('Delete site 999');

      expect(responses[0]!.type).toBe('error');
      expect(engine.hasPendingPreview()).toBe(false);
    });
  });

  // ==========================================================================
  // Approval Keywords
  // ==========================================================================

  describe('Approval Keywords', () => {
    async function setupPreviewAndApprove(approvalText: string): Promise<{
      mockExecutor: ReturnType<typeof createMockExecutor>;
    }> {
      const mockProvider = createMockProvider([
        createMockLLMToolCallResponse('delete-site-v1', { site_id: 123 }),
      ]);

      const { engine, mockExecutor } = createTestEngine({
        provider: mockProvider,
        abilities: [STANDARD_ABILITIES.deleteSite],
        executeHandler: (_n, _i, opts) =>
          opts?.dryRun ? createPreviewResult([{ id: 123 }]) : createSuccessResult({ deleted: true }),
      });

      await engine.sendMessage('Delete site');
      mockExecutor.execute.mockClear();

      await engine.sendMessage(approvalText);

      return { mockExecutor };
    }

    it('approves with "yes"', async () => {
      const { mockExecutor } = await setupPreviewAndApprove('yes');
      expect(mockExecutor.execute).toHaveBeenCalled();
    });

    it('approves with "y"', async () => {
      const { mockExecutor } = await setupPreviewAndApprove('y');
      expect(mockExecutor.execute).toHaveBeenCalled();
    });

    it('approves with "approve"', async () => {
      const { mockExecutor } = await setupPreviewAndApprove('approve');
      expect(mockExecutor.execute).toHaveBeenCalled();
    });

    it('approves with "confirm"', async () => {
      const { mockExecutor } = await setupPreviewAndApprove('confirm');
      expect(mockExecutor.execute).toHaveBeenCalled();
    });

    it('is case-insensitive', async () => {
      const { mockExecutor } = await setupPreviewAndApprove('YES');
      expect(mockExecutor.execute).toHaveBeenCalled();
    });

    it('trims whitespace', async () => {
      const { mockExecutor } = await setupPreviewAndApprove('  yes  ');
      expect(mockExecutor.execute).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Message History Management
  // ==========================================================================

  describe('Message History Management', () => {
    it('accumulates messages across turns', async () => {
      const mockProvider = createMockProvider([
        createMockLLMAnswerResponse('Response 1'),
        createMockLLMAnswerResponse('Response 2'),
      ]);

      const { engine } = createTestEngine({ provider: mockProvider });

      await engine.sendMessage('Message 1');
      await engine.sendMessage('Message 2');

      const history = engine.getHistory();
      // 1 system + 2 user + 2 assistant
      expect(history.length).toBeGreaterThanOrEqual(5);
    });

    it('clears history preserving system prompt', async () => {
      const { engine } = createTestEngine({});
      await engine.initialize();

      const beforeClear = engine.getHistory();
      expect(beforeClear).toHaveLength(1);

      engine.clearHistory();

      const afterClear = engine.getHistory();
      expect(afterClear).toHaveLength(1);
      expect(afterClear[0]!.role).toBe('system');
    });

    it('includes tool messages in history', async () => {
      const mockProvider = createMockProvider([
        createMockLLMToolCallResponse('list-sites-v1', {}),
        createMockLLMAnswerResponse('Done'),
      ]);

      const { engine } = createTestEngine({
        provider: mockProvider,
        abilities: [STANDARD_ABILITIES.listSites],
        executeHandler: () => createSuccessResult({ sites: [] }),
      });

      await engine.sendMessage('List sites');

      const history = engine.getHistory();
      const toolMessage = history.find((m) => m.role === 'tool');
      expect(toolMessage).toBeDefined();
    });
  });

  // ==========================================================================
  // Edge Cases
  // ==========================================================================

  describe('Edge Cases', () => {
    it('handles LLM returning answer immediately', async () => {
      const mockProvider = createMockProvider([
        createMockLLMAnswerResponse('I can help you with that!'),
      ]);

      const { engine, mockExecutor } = createTestEngine({
        provider: mockProvider,
        abilities: [STANDARD_ABILITIES.listSites],
      });

      const responses = await engine.sendMessage('Hello');

      expect(mockExecutor.execute).not.toHaveBeenCalled();
      expect(responses[0]!.type).toBe('message');
    });

    it('handles empty user input during approval', async () => {
      const mockProvider = createMockProvider([
        createMockLLMToolCallResponse('delete-site-v1', { site_id: 123 }),
      ]);

      const { engine, mockExecutor } = createTestEngine({
        provider: mockProvider,
        abilities: [STANDARD_ABILITIES.deleteSite],
        executeHandler: () => createPreviewResult([{ id: 123 }]),
      });

      await engine.sendMessage('Delete site');
      mockExecutor.execute.mockClear();

      // Empty string treated as decline
      await engine.sendMessage('');

      expect(mockExecutor.execute).not.toHaveBeenCalled();
      expect(engine.hasPendingPreview()).toBe(false);
    });

    it('pairs the pending tool call with a USER_DECLINED result', async () => {
      const mockProvider = createMockProvider([
        createMockLLMToolCallResponse('delete-site-v1', { site_id: 123 }),
      ]);

      const { engine } = createTestEngine({
        provider: mockProvider,
        abilities: [STANDARD_ABILITIES.deleteSite],
        executeHandler: () => createPreviewResult([{ id: 123 }]),
      });

      await engine.sendMessage('Delete site');
      expect(engine.hasPendingPreview()).toBe(true);

      const pendingToolCallId = engine
        .getHistory()
        .find((message) => message.role === 'assistant' && message.toolCalls?.length)
        ?.toolCalls?.[0]?.id;
      expect(pendingToolCallId).toBeDefined();

      await engine.sendMessage('cancel');

      expect(engine.hasPendingPreview()).toBe(false);
      expect(engine.getPendingPreview()).toBeNull();
      const declineResult = engine
        .getHistory()
        .find(
          (message) => message.role === 'tool' && message.toolCallId === pendingToolCallId
        );
      expect(declineResult).toBeDefined();
      expect(JSON.parse(declineResult!.content)).toMatchObject({
        success: false,
        error: { code: 'USER_DECLINED' },
      });
    });

    it('mixed readonly and destructive in sequence', async () => {
      const mockProvider = createMockProvider([
        createMockLLMToolCallResponse('list-sites-v1', {}),
        createMockLLMToolCallResponse('delete-site-v1', { site_id: 1 }),
      ]);

      const { engine, mockExecutor } = createTestEngine({
        provider: mockProvider,
        abilities: [STANDARD_ABILITIES.listSites, STANDARD_ABILITIES.deleteSite],
        maxToolCallsPerTurn: 5,
        executeHandler: (_name, _input, options) => {
          if (options?.dryRun) {
            return createPreviewResult([{ id: 1 }]);
          }
          return createSuccessResult({ result: 'ok' });
        },
      });

      await engine.sendMessage('List sites then delete site 1');

      // First call (readonly) should execute directly (uses full ability name)
      expect(mockExecutor.execute).toHaveBeenNthCalledWith(1, 'mainwp/list-sites-v1', {});

      // Second call (destructive) should preview
      expect(mockExecutor.execute).toHaveBeenNthCalledWith(
        2,
        'mainwp/delete-site-v1',
        { site_id: 1 },
        { dryRun: true }
      );

      // Should have preview pending
      expect(engine.hasPendingPreview()).toBe(true);
    });
  });
});
