/**
 * E2E Test: Non-TTY Behavior
 *
 * Validates behavior in non-interactive (piped/CI) environments.
 * Ensures mainwpcontrol doesn't hang in CI pipelines and provides
 * appropriate error messages for terminal-dependent features.
 *
 * INVARIANTS TESTED:
 * - Bare `mainwpcontrol` in non-TTY exits with code 1 and guidance
 * - `mainwpcontrol "message"` in non-TTY works (single-message mode)
 * - --quiet suppresses stdout, exit code reflects success/failure
 * - --json output works in pipe
 * - Destructive --confirm without --force in non-TTY exits with error
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createMockProfile,
  createMockAbility,
  createMockLLMAnswerResponse,
  createMockLLMToolCallResponse,
  restoreEnvVars,
  setEnvVar,
} from './test-helpers.js';

// ============================================================================
// Module-level mocks
// ============================================================================

const mockProfileStoreGetActive = vi.fn();
const mockProfileStoreGet = vi.fn();

vi.mock('../../config/profile-store.js', () => ({
  getProfileStore: vi.fn(() => ({
    get: mockProfileStoreGet,
    getActive: mockProfileStoreGetActive,
    save: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
    setActive: vi.fn().mockResolvedValue(undefined),
  })),
  ProfileStore: vi.fn(),
}));

const mockKeychainGetOrThrow = vi.fn();

vi.mock('../../config/keychain.js', () => ({
  getKeychain: vi.fn(() => ({
    get: vi.fn(),
    getOrThrow: mockKeychainGetOrThrow,
    set: vi.fn().mockResolvedValue({ stored: true, location: 'keychain' }),
    delete: vi.fn(),
    isAvailable: vi.fn().mockResolvedValue(true),
  })),
  Keychain: vi.fn(),
}));

vi.mock('../../core/http-client.js', () => ({
  createHttpClient: vi.fn(() => ({
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
  })),
}));

const mockExecutorListAbilities = vi.fn();
const mockExecutorExecute = vi.fn();
const mockExecutorGetAbility = vi.fn();

vi.mock('../../core/abilities-executor.js', () => ({
  createAbilitiesExecutor: vi.fn(() => ({
    listAbilities: mockExecutorListAbilities,
    execute: mockExecutorExecute,
    getAbility: mockExecutorGetAbility,
  })),
}));

vi.mock('../../utils/audit-logger.js', () => ({
  getAuditLogger: vi.fn(() => ({
    logDestructiveAction: vi.fn().mockResolvedValue(undefined),
  })),
  logDestructiveActionSafe: vi.fn().mockResolvedValue(undefined),
}));

const { mockCreateInterface } = vi.hoisted(() => ({
  mockCreateInterface: vi.fn(() => ({
    question: vi.fn(),
    close: vi.fn(),
    on: vi.fn().mockReturnThis(),
  })),
}));
vi.mock('node:readline', () => ({
  createInterface: mockCreateInterface,
}));

vi.mock('../../config/settings.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../config/settings.js')>();
  return {
    ...original,
    loadSettings: vi.fn().mockResolvedValue({}),
  };
});

// Mock isInteractive to simulate non-TTY
let mockIsInteractive = false;
vi.mock('../../utils/prompt.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../utils/prompt.js')>();
  return {
    ...original,
    isInteractive: vi.fn(() => mockIsInteractive),
    promptForConfirmation: vi.fn().mockResolvedValue(false),
  };
});

// Mock LLM providers
const {
  mockProviderChat,
  mockDetectConfiguredProvider,
  mockGetProviderConfigFromEnv,
  mockResolveProviderSelection,
} = vi.hoisted(() => ({
  mockProviderChat: vi.fn(),
  mockDetectConfiguredProvider: vi.fn(() => 'openai'),
  mockGetProviderConfigFromEnv: vi.fn(() => ({ apiKey: 'test-key' })),
  mockResolveProviderSelection: vi.fn(() => ({
    name: 'openai',
    source: 'auto',
    configured: true,
    config: { apiKey: 'test-key', timeout: 30000 },
    warnings: [],
  })),
}));
vi.mock('../../chat/providers/provider.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../chat/providers/provider.js')>();
  return {
    ...original,
    detectConfiguredProvider: mockDetectConfiguredProvider,
    getProviderConfigFromEnv: mockGetProviderConfigFromEnv,
    resolveProviderSelection: mockResolveProviderSelection,
    createProvider: vi.fn(() => ({
      name: 'mock-provider',
      capabilities: {
        functionCalling: true,
        streaming: false,
        systemMessages: true,
        vision: false,
        maxContextLength: 4096,
      },
      chat: mockProviderChat,
      isConfigured: () => true,
      getModels: () => ['test-model'],
      getDefaultModel: () => 'test-model',
    })),
  };
});

// ============================================================================
// Imports (after mocks)
// ============================================================================

import ChatCommand from '../../commands/chat.js';
import AbilitiesRun from '../../commands/abilities/run.js';

// ============================================================================
// Test Utilities
// ============================================================================

interface CapturedOutput {
  stdout: string[];
  stderr: string[];
  exitCode?: number;
}

function createCommandInstance<T extends ChatCommand | AbilitiesRun>(
  CommandClass: new (argv: string[], config: unknown) => T,
  argv: string[] = []
): { command: T; output: CapturedOutput } {
  const output: CapturedOutput = { stdout: [], stderr: [] };

  const mockConfig = {
    root: '/mock/root',
    bin: 'mainwpcontrol',
    name: 'mainwpcontrol',
    version: '1.0.0',
    pjson: { name: 'mainwpcontrol', version: '1.0.0' },
    dataDir: '/mock/data',
    cacheDir: '/mock/cache',
    configDir: '/mock/config',
    findCommand: vi.fn(),
    runCommand: vi.fn(),
    runHook: vi.fn(),
  };

  const command = new CommandClass(argv, mockConfig as never);

  command.log = vi.fn((...args: unknown[]) => {
    output.stdout.push(args.map(String).join(' '));
  });
  command.logToStderr = vi.fn((...args: unknown[]) => {
    output.stderr.push(args.map(String).join(' '));
  });
  command.exit = vi.fn((code?: number) => {
    output.exitCode = code ?? 0;
    throw new Error(`EXIT:${code ?? 0}`);
  }) as never;
  command.error = vi.fn((message: string | Error, options?: { exit?: number }) => {
    output.stderr.push(message instanceof Error ? message.message : message);
    output.exitCode = options?.exit ?? 1;
    throw new Error(`EXIT:${output.exitCode}`);
  }) as never;

  return { command, output };
}

// ============================================================================
// Tests
// ============================================================================

describe('E2E: Non-TTY Behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsInteractive = false; // Default to non-interactive
    mockDetectConfiguredProvider.mockReturnValue('openai');
    mockGetProviderConfigFromEnv.mockReturnValue({ apiKey: 'test-key' });
    mockResolveProviderSelection.mockReturnValue({
      name: 'openai',
      source: 'auto',
      configured: true,
      config: { apiKey: 'test-key', timeout: 30000 },
      warnings: [],
    });

    const mockProfile = createMockProfile();
    mockProfileStoreGetActive.mockResolvedValue(mockProfile);
    mockKeychainGetOrThrow.mockResolvedValue('test-password');
    setEnvVar('OPENAI_API_KEY', 'test-key');
  });

  afterEach(() => {
    vi.clearAllMocks();
    restoreEnvVars();
  });

  describe('Chat command in non-TTY', () => {
    it('exits with code 1 when no message provided in non-TTY mode', async () => {
      mockIsInteractive = false;

      const { command, output } = createCommandInstance(ChatCommand);
      command.parse = vi.fn().mockResolvedValue({
        flags: {
          json: false,
          quiet: false,
          debug: false,
          provider: undefined,
          model: undefined,
          'api-key': undefined,
          'base-url': undefined,
          'max-turns': 3,
          'max-context-messages': undefined,
          stream: true,
        },
        args: { message: undefined },
      }) as never;

      try { await command.run(); } catch { /* exit */ }

      expect(output.exitCode).toBe(1);
      const stderr = output.stderr.join('\n');
      expect(stderr).toContain('Interactive chat requires a terminal');
      expect(stderr).toContain('abilities run');
      expect(mockCreateInterface).not.toHaveBeenCalled();
    });

    it('handles a single readonly message and exits cleanly', async () => {
      const listSitesAbility = createMockAbility('list-sites-v1', { readonly: true });

      mockProviderChat
        .mockResolvedValueOnce(createMockLLMToolCallResponse('list-sites-v1', {}))
        .mockResolvedValueOnce(createMockLLMAnswerResponse('Done'));
      mockExecutorListAbilities.mockResolvedValue([listSitesAbility]);
      mockExecutorGetAbility.mockResolvedValue(listSitesAbility);
      mockExecutorExecute.mockResolvedValue({
        success: true,
        data: { sites: [{ id: 1, name: 'Test Site' }] },
      });

      const { command, output } = createCommandInstance(ChatCommand);
      command.parse = vi.fn().mockResolvedValue({
        flags: {
          json: false,
          quiet: false,
          debug: false,
          provider: undefined,
          model: undefined,
          'api-key': undefined,
          'base-url': undefined,
          'max-turns': 3,
          'max-context-messages': undefined,
          stream: false,
        },
        args: { message: 'list all sites' },
      }) as never;

      try { await command.run(); } catch { /* exit */ }

      const stdout = output.stdout.join('\n');
      expect(stdout).toContain('[mainwp/list-sites-v1]');
      expect(stdout).toContain('Test Site');
      expect(output.exitCode).toBeUndefined();
      expect(mockExecutorExecute).toHaveBeenCalledWith('mainwp/list-sites-v1', {});
      expect(mockExecutorExecute).toHaveBeenCalledTimes(1);
      expect(mockCreateInterface).not.toHaveBeenCalled();
    });

    it('halts after destructive preview in single-message mode', async () => {
      const deleteSiteAbility = createMockAbility('delete-site-v1', { destructive: true });

      mockProviderChat.mockResolvedValue(
        createMockLLMToolCallResponse('delete-site-v1', { site_id: 123 })
      );
      mockExecutorListAbilities.mockResolvedValue([deleteSiteAbility]);
      mockExecutorGetAbility.mockResolvedValue(deleteSiteAbility);
      mockExecutorExecute.mockResolvedValue({
        success: true,
        data: { affected: [{ id: 123, name: 'Site 123' }] },
      });

      const { command, output } = createCommandInstance(ChatCommand);
      command.parse = vi.fn().mockResolvedValue({
        flags: {
          json: false,
          quiet: false,
          debug: false,
          provider: undefined,
          model: undefined,
          'api-key': undefined,
          'base-url': undefined,
          'max-turns': 3,
          'max-context-messages': undefined,
          stream: false,
        },
        args: { message: 'delete site 123' },
      }) as never;

      try { await command.run(); } catch { /* exit */ }

      const stdout = output.stdout.join('\n');
      expect(stdout).toContain('Destructive action requires approval');
      expect(mockExecutorExecute).toHaveBeenCalledWith(
        'mainwp/delete-site-v1',
        { site_id: 123 },
        { dryRun: true }
      );
      expect(
        mockExecutorExecute.mock.calls.some(([, , options]) => options?.confirm === true)
      ).toBe(false);
      expect(output.exitCode).toBeUndefined();
      expect(mockCreateInterface).not.toHaveBeenCalled();
    });

    it('emits clean JSON for a single readonly message with --json', async () => {
      const listSitesAbility = createMockAbility('list-sites-v1', { readonly: true });

      mockProviderChat
        .mockResolvedValueOnce(createMockLLMToolCallResponse('list-sites-v1', {}))
        .mockResolvedValueOnce(createMockLLMAnswerResponse('Done'));
      mockExecutorListAbilities.mockResolvedValue([listSitesAbility]);
      mockExecutorGetAbility.mockResolvedValue(listSitesAbility);
      mockExecutorExecute.mockResolvedValue({
        success: true,
        data: { sites: [{ id: 1, name: 'Test Site' }] },
      });

      const { command, output } = createCommandInstance(ChatCommand);
      command.parse = vi.fn().mockResolvedValue({
        flags: {
          json: true,
          quiet: false,
          debug: false,
          provider: undefined,
          model: undefined,
          'api-key': undefined,
          'base-url': undefined,
          'max-turns': 3,
          'max-context-messages': undefined,
          stream: false,
        },
        args: { message: 'list all sites' },
      }) as never;

      try { await command.run(); } catch { /* exit */ }

      // Contract: exactly one JSON object emitted, no preamble text
      expect(output.stdout).toHaveLength(1);
      const allOutput = output.stdout[0]!;
      const parsed = JSON.parse(allOutput);
      expect(parsed.type).toBe('tool_result');
      expect(parsed.tool).toBe('mainwp/list-sites-v1');
      expect(parsed.result.success).toBe(true);
      expect(mockExecutorExecute).toHaveBeenCalledTimes(1);
      expect(mockCreateInterface).not.toHaveBeenCalled();
    });

    it('emits final tool result (not intermediate) for multi-tool-call --json', async () => {
      const listSitesAbility = createMockAbility('list-sites-v1', { readonly: true });
      const updatePluginsAbility = createMockAbility('update-site-plugins-v1', { readonly: false });

      // LLM does two tool calls: list-sites (intermediate) then update-plugins (final), then answers
      mockProviderChat
        .mockResolvedValueOnce(createMockLLMToolCallResponse('list-sites-v1', {}))
        .mockResolvedValueOnce(createMockLLMToolCallResponse('update-site-plugins-v1', { site_id: 1 }))
        .mockResolvedValueOnce(createMockLLMAnswerResponse('Plugins updated'));
      mockExecutorListAbilities.mockResolvedValue([listSitesAbility, updatePluginsAbility]);
      mockExecutorGetAbility
        .mockResolvedValueOnce(listSitesAbility)
        .mockResolvedValueOnce(updatePluginsAbility);
      mockExecutorExecute
        .mockResolvedValueOnce({
          success: true,
          data: { sites: [{ id: 1, name: 'Test Site' }] },
        })
        .mockResolvedValueOnce({
          success: true,
          data: { updated: ['akismet/akismet.php'], site_id: 1 },
        });

      const { command, output } = createCommandInstance(ChatCommand);
      command.parse = vi.fn().mockResolvedValue({
        flags: {
          json: true,
          quiet: false,
          debug: false,
          provider: undefined,
          model: undefined,
          'api-key': undefined,
          'base-url': undefined,
          'max-turns': 3,
          'max-context-messages': undefined,
          stream: false,
        },
        args: { message: 'update plugins on site 1' },
      }) as never;

      try { await command.run(); } catch { /* exit */ }

      const allOutput = output.stdout.join('\n');
      const parsed = JSON.parse(allOutput);
      // Contract: exactly one JSON object, selecting the final tool result
      expect(output.stdout).toHaveLength(1);
      expect(parsed.type).toBe('tool_result');
      expect(parsed.tool).toBe('mainwp/update-site-plugins-v1');
      expect(parsed.result.data.updated).toContain('akismet/akismet.php');
      expect(mockExecutorExecute).toHaveBeenCalledTimes(2);
      expect(mockCreateInterface).not.toHaveBeenCalled();
    });

    it('exits with code 2 when no provider is configured for single-message mode', async () => {
      mockResolveProviderSelection.mockReturnValueOnce({
        source: 'none',
        configured: false,
        config: { apiKey: '', timeout: 30000 },
        warnings: [],
      });

      const { command, output } = createCommandInstance(ChatCommand);
      command.parse = vi.fn().mockResolvedValue({
        flags: {
          json: false,
          quiet: false,
          debug: false,
          provider: undefined,
          model: undefined,
          'api-key': undefined,
          'base-url': undefined,
          'max-turns': 3,
          'max-context-messages': undefined,
          stream: false,
        },
        args: { message: 'list all sites' },
      }) as never;

      try { await command.run(); } catch { /* exit */ }

      expect(output.exitCode).toBe(2);
      expect(output.stdout).toHaveLength(0);
      const stderr = output.stderr.join('\n');
      expect(stderr).toContain('No LLM provider configured');
      expect(stderr).toContain('LOCAL_LLM_API_KEY');
      expect(stderr).toContain('environment variables / --api-key');
      expect(mockCreateInterface).not.toHaveBeenCalled();
    });
  });

  describe('Quiet mode', () => {
    it('suppresses stdout when --quiet is set', async () => {
      mockExecutorGetAbility.mockResolvedValue(
        createMockAbility('list-sites-v1', { readonly: true })
      );
      mockExecutorExecute.mockResolvedValue({
        success: true,
        data: { sites: [] },
      });

      const { command, output } = createCommandInstance(AbilitiesRun);
      command.parse = vi.fn().mockResolvedValue({
        flags: {
          json: false,
          quiet: true,
          debug: false,
          input: '{}',
          'dry-run': false,
          confirm: false,
          force: false,
          wait: false,
          'wait-timeout': 300,
        },
        args: { name: 'list-sites-v1' },
      }) as never;

      try { await command.run(); } catch { /* exit */ }

      // No stdout output in quiet mode
      expect(output.stdout.length).toBe(0);
      expect(output.exitCode).toBeUndefined(); // success = no exit code
    });

    it('--json overrides --quiet (explicit structured output wins)', async () => {
      mockExecutorGetAbility.mockResolvedValue(
        createMockAbility('list-sites-v1', { readonly: true })
      );
      mockExecutorExecute.mockResolvedValue({
        success: true,
        data: { sites: [] },
      });

      const { command, output } = createCommandInstance(AbilitiesRun);
      command.parse = vi.fn().mockResolvedValue({
        flags: {
          json: true,
          quiet: true, // Both set, json should win
          debug: false,
          input: '{}',
          'dry-run': false,
          confirm: false,
          force: false,
          wait: false,
          'wait-timeout': 300,
        },
        args: { name: 'list-sites-v1' },
      }) as never;

      try { await command.run(); } catch { /* exit */ }

      // JSON output should be present despite --quiet
      expect(output.stdout.length).toBeGreaterThan(0);
      const allOutput = output.stdout.join('\n');
      expect(() => JSON.parse(allOutput)).not.toThrow();
    });
  });

  describe('Destructive in non-TTY', () => {
    it('requires --force flag for destructive --confirm in non-interactive mode', async () => {
      mockIsInteractive = false;

      mockExecutorGetAbility.mockResolvedValue(
        createMockAbility('delete-site-v1', { destructive: true })
      );
      // Mock preview execution (called during destructive flow)
      mockExecutorExecute.mockResolvedValue({
        success: true,
        data: { affected: [] },
      });

      const { command, output } = createCommandInstance(AbilitiesRun);
      command.parse = vi.fn().mockResolvedValue({
        flags: {
          json: false,
          quiet: false,
          debug: false,
          input: '{"site_id_or_domain": 1}',
          'dry-run': false,
          confirm: true,
          force: false, // No --force
          wait: false,
          'wait-timeout': 300,
        },
        args: { name: 'delete-site-v1' },
      }) as never;

      let thrownError: Error | undefined;
      try {
        await command.run();
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('EXIT:')) {
          // Expected exit from mocked exit()
        } else {
          thrownError = error as Error;
        }
      }

      // Either exit code 1 was set, or an InputError was thrown
      if (output.exitCode !== undefined) {
        expect(output.exitCode).toBe(1);
      } else if (thrownError) {
        const { InputError } = await import('../../utils/errors.js');
        expect(thrownError).toBeInstanceOf(InputError);
      } else {
        // Should not reach here - one of the above should have triggered
        expect.fail('Expected exit code 1 or InputError');
      }
    });
  });

  describe('JSON in pipe', () => {
    it('--json output is clean JSON in non-TTY', async () => {
      mockExecutorGetAbility.mockResolvedValue(
        createMockAbility('list-sites-v1', { readonly: true })
      );
      mockExecutorExecute.mockResolvedValue({
        success: true,
        data: { sites: [{ id: 1 }] },
      });

      const { command, output } = createCommandInstance(AbilitiesRun);
      command.parse = vi.fn().mockResolvedValue({
        flags: {
          json: true,
          quiet: false,
          debug: false,
          input: '{}',
          'dry-run': false,
          confirm: false,
          force: false,
          wait: false,
          'wait-timeout': 300,
        },
        args: { name: 'list-sites-v1' },
      }) as never;

      try { await command.run(); } catch { /* exit */ }

      const allOutput = output.stdout.join('\n');
      const parsed = JSON.parse(allOutput);
      expect(parsed.success).toBe(true);
      expect(parsed.data).toBeDefined();
    });
  });
});
