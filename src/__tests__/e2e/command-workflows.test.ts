/**
 * E2E Test: Command-Level Integration Tests
 *
 * Tests the actual CLI command classes (Login, AbilitiesList, ChatCommand)
 * by invoking their run() methods with mocked HTTP, filesystem, keychain,
 * and readline dependencies.
 *
 * Exercises:
 * - BaseCommand initialization and flag parsing
 * - Output formatting (human and JSON envelopes)
 * - Destructive preview/approval messaging for chat
 * - Profile/abilities output for login→list flow
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createMockProfile,
  createMockAbility,
  createMockHttpResponse,
  createMockLLMToolCallResponse,
  createMockLLMAnswerResponse,
  setEnvVar,
  clearEnvVar,
  restoreEnvVars,
  STANDARD_ABILITIES,
  createCommandHarness,
  type CapturedOutput,
} from './test-helpers.js';

// ============================================================================
// Module-level mocks (before imports)
// ============================================================================

// Mock profile store singleton
const mockProfileStoreGet = vi.fn();
const mockProfileStoreGetActive = vi.fn();
const mockProfileStoreSave = vi.fn();
const mockProfileStoreList = vi.fn();
const mockProfileStoreDelete = vi.fn();
const mockProfileStoreSetActive = vi.fn();

vi.mock('../../config/profile-store.js', async (importOriginal) => ({
  // Keep the real validateDashboardUrl: login calls it at intake, and these
  // workflows should exercise the genuine validation behavior.
  validateDashboardUrl: (await importOriginal<typeof import('../../config/profile-store.js')>())
    .validateDashboardUrl,
  getProfileStore: vi.fn(() => ({
    get: mockProfileStoreGet,
    getActive: mockProfileStoreGetActive,
    save: mockProfileStoreSave,
    list: mockProfileStoreList,
    delete: mockProfileStoreDelete,
    setActive: mockProfileStoreSetActive,
  })),
  ProfileStore: vi.fn(),
}));

// Mock keychain singleton
const mockKeychainGet = vi.fn();
const mockKeychainGetOrThrow = vi.fn();
const mockKeychainSet = vi.fn();
const mockKeychainDelete = vi.fn();

vi.mock('../../config/keychain.js', () => ({
  getKeychain: vi.fn(() => ({
    get: mockKeychainGet,
    getOrThrow: mockKeychainGetOrThrow,
    set: mockKeychainSet,
    delete: mockKeychainDelete,
    isAvailable: vi.fn().mockResolvedValue(true),
  })),
  Keychain: vi.fn(),
}));

// Mock http-client
const mockHttpGet = vi.fn();
const mockHttpPost = vi.fn();
const mockHttpDelete = vi.fn();

vi.mock('../../core/http-client.js', () => ({
  createHttpClient: vi.fn(() => ({
    get: mockHttpGet,
    post: mockHttpPost,
    delete: mockHttpDelete,
  })),
}));

// Mock abilities-executor
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

// Mock readline to prevent process.exit(0) on close
const mockRlQuestion = vi.fn();
const mockRlClose = vi.fn();
const mockRlOn = vi.fn().mockReturnThis();

vi.mock('node:readline', () => ({
  createInterface: vi.fn(() => ({
    question: mockRlQuestion,
    close: mockRlClose,
    on: mockRlOn,
  })),
}));

// Mock LLM providers
const mockProviderChat = vi.fn();
vi.mock('../../chat/providers/provider.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../chat/providers/provider.js')>();
  return {
    ...original,
    detectConfiguredProvider: vi.fn(() => 'openai'),
    getProviderConfigFromEnv: vi.fn(() => ({ apiKey: 'test-key' })),
    resolveProviderSelection: vi.fn(() => ({
      name: 'openai',
      source: 'auto',
      configured: true,
      config: { apiKey: 'test-key', timeout: 30000 },
      warnings: [],
    })),
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

import Login from '../../commands/login.js';
import AbilitiesList from '../../commands/abilities/list.js';
import ChatCommand from '../../commands/chat.js';

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Parse argv into flags and args
 *
 * Note: Boolean flags (those with default: false/true) don't consume the next argument.
 */
function parseArgv(argv: string[], flagDefs: Record<string, { char?: string; default?: unknown; boolean?: boolean }> = {}): {
  flags: Record<string, unknown>;
  args: Record<string, string>;
} {
  const flags: Record<string, unknown> = {};
  const args: Record<string, string> = {};
  let i = 0;

  // Detect boolean flags (those with boolean default values)
  const booleanFlags = new Set<string>();
  for (const [name, def] of Object.entries(flagDefs)) {
    if (def.default !== undefined) {
      flags[name] = def.default;
    }
    if (typeof def.default === 'boolean' || def.boolean) {
      booleanFlags.add(name);
    }
  }

  while (i < argv.length) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const [key, value] = arg.slice(2).split('=');
      if (value !== undefined) {
        flags[key] = value;
      } else if (booleanFlags.has(key)) {
        // Boolean flags don't consume next argument
        flags[key] = true;
      } else if (argv[i + 1] && !argv[i + 1].startsWith('-')) {
        flags[key] = argv[++i];
      } else {
        flags[key] = true;
      }
    } else if (arg.startsWith('-')) {
      const char = arg.slice(1);
      // Find flag by char
      const flagEntry = Object.entries(flagDefs).find(([_, def]) => def.char === char);
      const flagName = flagEntry?.[0];
      if (flagName && booleanFlags.has(flagName)) {
        flags[flagName] = true;
      } else if (flagName && argv[i + 1] && !argv[i + 1].startsWith('-')) {
        flags[flagName] = argv[++i];
      } else if (flagName) {
        flags[flagName] = true;
      }
    } else {
      // Positional arg
      args.message = arg;
    }
    i++;
  }

  return { flags, args };
}

/**
 * Create a command instance with mocked config and output capture
 */
function createCommandWithCapture<T extends Login | AbilitiesList | ChatCommand>(
  CommandClass: new (argv: string[], config: unknown) => T,
  argv: string[] = [],
  flagDefs: Record<string, { char?: string; default?: unknown }> = {}
): { command: T; output: CapturedOutput } {
  const { command, output } = createCommandHarness(CommandClass, argv);

  // Mock parse to return our parsed argv
  const parsed = parseArgv(argv, flagDefs);
  command.parse = vi.fn().mockResolvedValue(parsed) as never;

  return { command, output };
}

/**
 * Run a command and capture its output
 */
async function runCommand<T extends Login | AbilitiesList | ChatCommand>(
  CommandClass: new (argv: string[], config: unknown) => T,
  argv: string[] = [],
  flagDefs: Record<string, { char?: string; default?: unknown }> = {}
): Promise<CapturedOutput> {
  const { command, output } = createCommandWithCapture(CommandClass, argv, flagDefs);

  try {
    await command.run();
  } catch (error) {
    // Check if this is our controlled exit
    if (error instanceof Error && error.message.startsWith('EXIT:')) {
      // Expected exit, output already captured
    } else {
      // Unexpected error - capture it
      output.stderr.push(error instanceof Error ? error.message : String(error));
      output.exitCode = 1;
    }
  }

  return output;
}

// Flag definitions for each command
const LOGIN_FLAGS = {
  json: { default: false },
  profile: { char: 'p' },
  debug: { default: false },
  url: { char: 'u' },
  username: {},
  password: {},
  name: { char: 'n' },
  'skip-ssl-verify': { default: false },
};

const ABILITIES_LIST_FLAGS = {
  json: { default: false },
  profile: { char: 'p' },
  debug: { default: false },
  category: { char: 'c' },
};

const CHAT_FLAGS = {
  json: { default: false },
  profile: { char: 'p' },
  debug: { default: false },
  provider: {},
  model: { char: 'm' },
  'api-key': {},
  'base-url': {},
  'max-turns': { default: 3 },
};

// ============================================================================
// Tests
// ============================================================================

describe('E2E: Command-Level Workflows', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Reset all mock implementations to defaults
    mockProfileStoreGet.mockReset();
    mockProfileStoreGetActive.mockReset();
    mockProfileStoreSave.mockReset().mockResolvedValue(undefined);
    mockProfileStoreList.mockReset().mockResolvedValue([]);
    mockProfileStoreDelete.mockReset().mockResolvedValue(undefined);
    mockProfileStoreSetActive.mockReset().mockResolvedValue(undefined);

    mockKeychainGet.mockReset();
    mockKeychainGetOrThrow.mockReset();
    mockKeychainSet.mockReset().mockResolvedValue({ stored: true, location: 'keychain' });
    mockKeychainDelete.mockReset().mockResolvedValue({ deleted: true });

    mockHttpGet.mockReset();
    mockHttpPost.mockReset();
    mockHttpDelete.mockReset();

    mockExecutorListAbilities.mockReset();
    mockExecutorExecute.mockReset();
    mockExecutorGetAbility.mockReset();

    mockProviderChat.mockReset();

    // Reset readline mocks
    mockRlQuestion.mockReset();
    mockRlClose.mockReset();
    mockRlOn.mockReset().mockReturnThis();
  });

  afterEach(() => {
    vi.clearAllMocks();
    restoreEnvVars();
  });

  // ==========================================================================
  // Login Command Tests
  // ==========================================================================

  describe('Login Command', () => {
    it('authenticates with flags and outputs success message', async () => {
      // Mock successful connection test
      mockHttpGet.mockResolvedValueOnce(
        createMockHttpResponse(200, { abilities: [] })
      );

      const output = await runCommand(Login, [
        '--url', 'https://dashboard.test',
        '--username', 'admin',
        '--password', 'secret123',
        '--name', 'test-profile',
      ], LOGIN_FLAGS);

      // Verify success message in output
      expect(output.stdout.join('\n')).toContain('Logged in as admin');
      expect(output.stdout.join('\n')).toContain('Profile: test-profile');
      expect(output.stdout.join('\n')).toContain('Dashboard: https://dashboard.test');

      // Verify profile was saved
      expect(mockProfileStoreSave).toHaveBeenCalled();
      expect(mockKeychainSet).toHaveBeenCalledWith('test-profile', 'secret123');
    });

    it('outputs JSON envelope with --json flag', async () => {
      mockHttpGet.mockResolvedValueOnce(
        createMockHttpResponse(200, { abilities: [] })
      );

      const output = await runCommand(Login, [
        '--url', 'https://dashboard.test',
        '--username', 'admin',
        '--password', 'secret123',
        '--name', 'json-profile',
        '--json',
      ], LOGIN_FLAGS);

      // Parse and verify JSON output
      const jsonOutput = output.stdout.find((line) => line.includes('"success"'));
      expect(jsonOutput).toBeDefined();

      const parsed = JSON.parse(jsonOutput!);
      expect(parsed.success).toBe(true);
      expect(parsed.data.profile).toBe('json-profile');
      expect(parsed.data.url).toBe('https://dashboard.test');
    });

    it('normalizes URL without protocol', async () => {
      mockHttpGet.mockResolvedValueOnce(
        createMockHttpResponse(200, { abilities: [] })
      );

      const output = await runCommand(Login, [
        '--url', 'dashboard.test',
        '--username', 'admin',
        '--password', 'secret',
        '--json',
      ], LOGIN_FLAGS);

      const jsonOutput = output.stdout.find((line) => line.includes('"success"'));
      const parsed = JSON.parse(jsonOutput!);
      expect(parsed.data.url).toBe('https://dashboard.test');
    });

    it('stores credentials in keychain', async () => {
      mockHttpGet.mockResolvedValueOnce(
        createMockHttpResponse(200, { abilities: [] })
      );

      await runCommand(Login, [
        '--url', 'https://dashboard.test',
        '--username', 'admin',
        '--password', 'mypassword',
        '--name', 'keychain-test',
      ], LOGIN_FLAGS);

      expect(mockKeychainSet).toHaveBeenCalledWith('keychain-test', 'mypassword');
    });

    it('restores an existing credential when profile persistence fails', async () => {
      mockHttpGet.mockResolvedValueOnce(
        createMockHttpResponse(200, { abilities: [] })
      );
      mockProfileStoreGet.mockResolvedValueOnce(createMockProfile({ name: 'existing' }));
      mockKeychainGet.mockResolvedValueOnce('old-password');
      mockProfileStoreSave.mockRejectedValueOnce(new Error('disk full'));

      await runCommand(Login, [
        '--url', 'https://dashboard.test',
        '--username', 'admin',
        '--password', 'new-password',
        '--name', 'existing',
      ], LOGIN_FLAGS);

      expect(mockKeychainSet).toHaveBeenNthCalledWith(1, 'existing', 'new-password');
      expect(mockKeychainSet).toHaveBeenNthCalledWith(2, 'existing', 'old-password');
      expect(mockProfileStoreSetActive).not.toHaveBeenCalled();
    });

    it('handles authentication failure with error exit', async () => {
      const { APIError } = await import('../../utils/errors.js');
      mockHttpGet.mockRejectedValueOnce(
        new APIError('UNAUTHORIZED', 'Invalid credentials', 401)
      );

      const output = await runCommand(Login, [
        '--url', 'https://dashboard.test',
        '--username', 'wrong',
        '--password', 'wrong',
      ], LOGIN_FLAGS);

      expect(output.exitCode).toBe(1);
      expect(output.stderr.join('\n')).toContain('Connection failed');
    });
  });

  // ==========================================================================
  // AbilitiesList Command Tests
  // ==========================================================================

  describe('AbilitiesList Command', () => {
    beforeEach(() => {
      // Setup: Profile exists with credentials
      const mockProfile = createMockProfile({ name: 'test-profile' });
      mockProfileStoreGetActive.mockResolvedValue(mockProfile);
      mockKeychainGetOrThrow.mockResolvedValue('test-password');
    });

    it('lists abilities in human-readable format', async () => {
      const mockAbilities = [
        createMockAbility('list-sites-v1', { readonly: true }),
        createMockAbility('delete-site-v1', { destructive: true }),
        createMockAbility('sync-sites-v1'),
      ];

      mockExecutorListAbilities.mockResolvedValue(mockAbilities);

      const output = await runCommand(AbilitiesList, [], ABILITIES_LIST_FLAGS);

      const stdout = output.stdout.join('\n');
      expect(stdout).toContain('Abilities');
      expect(stdout).toContain('3 total');
      expect(stdout).toContain('list-sites-v1');
      expect(stdout).toContain('delete-site-v1');
    });

    it('outputs JSON envelope with --json flag', async () => {
      const mockAbilities = [
        createMockAbility('list-sites-v1', { readonly: true }),
        createMockAbility('delete-site-v1', { destructive: true }),
      ];

      mockExecutorListAbilities.mockResolvedValue(mockAbilities);

      const output = await runCommand(AbilitiesList, ['--json'], ABILITIES_LIST_FLAGS);

      const jsonOutput = output.stdout.find((line) => line.includes('"success"'));
      expect(jsonOutput).toBeDefined();

      const parsed = JSON.parse(jsonOutput!);
      expect(parsed.success).toBe(true);
      expect(parsed.data.total).toBe(2);
      expect(parsed.data.abilities).toHaveLength(2);

      // Verify ability structure
      const listSites = parsed.data.abilities.find(
        (a: { name: string }) => a.name === 'mainwp/list-sites-v1'
      );
      expect(listSites.readonly).toBe(true);
      expect(listSites.destructive).toBe(false);

      const deleteSite = parsed.data.abilities.find(
        (a: { name: string }) => a.name === 'mainwp/delete-site-v1'
      );
      expect(deleteSite.destructive).toBe(true);
    });

    it('filters by category with --category flag', async () => {
      const mockAbilities = [
        createMockAbility('list-sites-v1', { readonly: true }),
        { ...createMockAbility('list-clients-v1', { readonly: true }), category: 'clients' },
      ];

      mockExecutorListAbilities.mockResolvedValue(mockAbilities);

      const output = await runCommand(AbilitiesList, ['--category', 'test', '--json'], ABILITIES_LIST_FLAGS);

      const jsonOutput = output.stdout.find((line) => line.includes('"success"'));
      const parsed = JSON.parse(jsonOutput!);

      // Only abilities in 'test' category (list-sites-v1 has category 'test' by default)
      expect(parsed.data.total).toBe(1);
      expect(parsed.data.abilities[0].name).toBe('mainwp/list-sites-v1');
    });

    it('shows empty message when no abilities found', async () => {
      mockExecutorListAbilities.mockResolvedValue([]);

      const output = await runCommand(AbilitiesList, [], ABILITIES_LIST_FLAGS);

      expect(output.stdout.join('\n')).toContain('No abilities found');
    });

    it('fails when no profile is configured', async () => {
      // No profile exists
      mockProfileStoreGetActive.mockResolvedValue(null);

      const output = await runCommand(AbilitiesList, [], ABILITIES_LIST_FLAGS);

      expect(output.exitCode).toBe(1);
      expect(output.stderr.join('\n')).toMatch(/No profile|profile configured/i);
    });
  });

  // ==========================================================================
  // ChatCommand Tests
  // ==========================================================================

  describe('ChatCommand', () => {
    beforeEach(() => {
      // Setup: Profile exists with credentials
      const mockProfile = createMockProfile({ name: 'test-profile' });
      mockProfileStoreGetActive.mockResolvedValue(mockProfile);
      mockKeychainGetOrThrow.mockResolvedValue('test-password');

      // Setup: Abilities available
      const abilities = [
        STANDARD_ABILITIES.listSites,
        STANDARD_ABILITIES.deleteSite,
      ];
      mockExecutorListAbilities.mockResolvedValue(abilities);

      // Setup: getAbility returns the correct ability by name
      mockExecutorGetAbility.mockImplementation(async (name: string) => {
        return abilities.find((a) => a.name === name) ?? null;
      });

      // Set API key env var
      setEnvVar('OPENAI_API_KEY', 'test-key');
    });

    it('handles single message mode with readonly tool call', async () => {
      // LLM returns a tool call followed by answer
      mockProviderChat
        .mockResolvedValueOnce(createMockLLMToolCallResponse('mainwp__list-sites-v1', {}))
        .mockResolvedValueOnce(createMockLLMAnswerResponse('Found 3 sites'));

      // Mock tool execution
      mockExecutorExecute.mockResolvedValueOnce({
        success: true,
        data: { sites: [{ id: 1 }, { id: 2 }, { id: 3 }] },
      });

      const output = await runCommand(ChatCommand, ['List my sites'], CHAT_FLAGS);

      const stdout = output.stdout.join('\n');
      // Should show the response from the LLM
      expect(stdout).toContain('Found 3 sites');
    });

    it('shows destructive preview and requires approval in non-interactive mode', async () => {
      // LLM returns a destructive tool call
      mockProviderChat.mockResolvedValueOnce(
        createMockLLMToolCallResponse('mainwp__delete-site-v1', { site_id: 123 })
      );

      // Mock preview execution
      mockExecutorExecute.mockResolvedValueOnce({
        success: true,
        data: { affected: [{ id: 123, name: 'Test Site' }] },
      });

      const output = await runCommand(ChatCommand, ['Delete site 123'], CHAT_FLAGS);

      const stdout = output.stdout.join('\n');
      // Non-interactive mode should mention approval needed
      expect(stdout).toMatch(/preview|approval|interactive|confirm/i);
    });

    it('outputs JSON for tool results with --json flag', { timeout: 10000 }, async () => {
      mockProviderChat
        .mockResolvedValueOnce(createMockLLMToolCallResponse('mainwp__list-sites-v1', {}))
        .mockResolvedValueOnce(createMockLLMAnswerResponse('Done'));

      mockExecutorExecute.mockResolvedValueOnce({
        success: true,
        data: { sites: [{ id: 1 }] },
      });

      const output = await runCommand(ChatCommand, ['--json', 'List sites'], CHAT_FLAGS);

      // Find JSON outputs
      const jsonLines = output.stdout.filter((line) => {
        try {
          JSON.parse(line);
          return true;
        } catch {
          return false;
        }
      });

      expect(jsonLines.length).toBeGreaterThan(0);
    });

    it('fails when no LLM provider is configured', async () => {
      // Clear the provider mock to simulate no provider
      clearEnvVar('OPENAI_API_KEY');
      clearEnvVar('ANTHROPIC_API_KEY');
      clearEnvVar('GOOGLE_API_KEY');
      clearEnvVar('OPENROUTER_API_KEY');
      clearEnvVar('LOCAL_LLM_URL');

      const { resolveProviderSelection } = await import('../../chat/providers/provider.js');
      vi.mocked(resolveProviderSelection).mockReturnValueOnce({
        source: 'none',
        configured: false,
        config: { apiKey: '', timeout: 30000 },
        warnings: [],
      });

      const output = await runCommand(ChatCommand, ['Hello'], CHAT_FLAGS);

      // Exit code 2 is used for auth/config errors in ChatCommand
      expect(output.exitCode).toBe(2);
      expect(output.stderr.join('\n')).toMatch(/No LLM provider|provider/i);
    });
  });

  // ==========================================================================
  // Login → Abilities List Workflow
  // ==========================================================================

  describe('Login → AbilitiesList Workflow', () => {
    it('can list abilities after successful login', async () => {
      // Step 1: Login
      mockHttpGet.mockResolvedValueOnce(
        createMockHttpResponse(200, { abilities: [] })
      );

      const loginOutput = await runCommand(Login, [
        '--url', 'https://workflow.test',
        '--username', 'admin',
        '--password', 'secret',
        '--name', 'workflow-profile',
      ], LOGIN_FLAGS);

      expect(loginOutput.stdout.join('\n')).toContain('Logged in');

      // Step 2: List abilities (profile now exists)
      const mockProfile = createMockProfile({
        name: 'workflow-profile',
        dashboardUrl: 'https://workflow.test',
      });
      mockProfileStoreGetActive.mockResolvedValue(mockProfile);
      mockKeychainGetOrThrow.mockResolvedValue('secret');

      const mockAbilities = [
        createMockAbility('list-sites-v1', { readonly: true }),
        createMockAbility('sync-sites-v1'),
      ];
      mockExecutorListAbilities.mockResolvedValue(mockAbilities);

      const listOutput = await runCommand(AbilitiesList, ['--json'], ABILITIES_LIST_FLAGS);

      const jsonOutput = listOutput.stdout.find((line) => line.includes('"success"'));
      const parsed = JSON.parse(jsonOutput!);

      expect(parsed.success).toBe(true);
      expect(parsed.data.total).toBe(2);
    });

    it('outputs consistent JSON envelopes for both commands', async () => {
      // Login with JSON
      mockHttpGet.mockResolvedValueOnce(
        createMockHttpResponse(200, { abilities: [] })
      );

      const loginOutput = await runCommand(Login, [
        '--url', 'https://json.test',
        '--username', 'admin',
        '--password', 'secret',
        '--json',
      ], LOGIN_FLAGS);

      const loginJson = loginOutput.stdout.find((line) => line.includes('"success"'));
      const loginParsed = JSON.parse(loginJson!);
      expect(loginParsed).toHaveProperty('success', true);
      expect(loginParsed).toHaveProperty('data');

      // Abilities list with JSON
      const mockProfile = createMockProfile({ name: 'json.test' });
      mockProfileStoreGetActive.mockResolvedValue(mockProfile);
      mockKeychainGetOrThrow.mockResolvedValue('secret');
      mockExecutorListAbilities.mockResolvedValue([]);

      const listOutput = await runCommand(AbilitiesList, ['--json'], ABILITIES_LIST_FLAGS);

      const listJson = listOutput.stdout.find((line) => line.includes('"success"'));
      const listParsed = JSON.parse(listJson!);
      expect(listParsed).toHaveProperty('success', true);
      expect(listParsed).toHaveProperty('data');
    });
  });

  // ==========================================================================
  // BaseCommand Initialization Tests
  // ==========================================================================

  describe('BaseCommand Initialization', () => {
    it('parses --profile flag to use specific profile', async () => {
      // Setup: Profile exists by name
      const mockProfile = createMockProfile({
        name: 'profile-2',
        dashboardUrl: 'https://two.test',
      });
      mockProfileStoreGet.mockResolvedValue(mockProfile);
      mockKeychainGetOrThrow.mockResolvedValue('password');
      mockExecutorListAbilities.mockResolvedValue([]);

      // Use --profile to select profile-2
      const output = await runCommand(AbilitiesList, ['--profile', 'profile-2', '--json'], ABILITIES_LIST_FLAGS);

      // The profile store should have been asked for profile-2
      expect(mockProfileStoreGet).toHaveBeenCalledWith('profile-2');

      // Should succeed
      const jsonOutput = output.stdout.find((line) => line.includes('"success"'));
      expect(jsonOutput).toBeDefined();
    });

    it('fails with helpful message when profile not found', async () => {
      // Profile not found
      mockProfileStoreGet.mockResolvedValue(null);

      const output = await runCommand(AbilitiesList, ['--profile', 'nonexistent'], ABILITIES_LIST_FLAGS);

      expect(output.exitCode).toBe(1);
      expect(output.stderr.join('\n')).toMatch(/Profile not found|nonexistent/i);
    });

    it('parses --debug flag', async () => {
      const mockProfile = createMockProfile({ name: 'debug-test' });
      mockProfileStoreGetActive.mockResolvedValue(mockProfile);
      mockKeychainGetOrThrow.mockResolvedValue('password');
      mockExecutorListAbilities.mockResolvedValue([]);

      // --debug flag should be parsed without error
      const output = await runCommand(AbilitiesList, ['--debug'], ABILITIES_LIST_FLAGS);

      // Command should succeed (debug mode doesn't change output format)
      expect(output.exitCode).toBeUndefined(); // No exit = success
    });
  });

  // ==========================================================================
  // Output Envelope Tests
  // ==========================================================================

  describe('Output Envelope Structure', () => {
    beforeEach(() => {
      const mockProfile = createMockProfile({ name: 'envelope-test' });
      mockProfileStoreGetActive.mockResolvedValue(mockProfile);
      mockKeychainGetOrThrow.mockResolvedValue('password');
    });

    it('success envelope has correct structure', async () => {
      mockExecutorListAbilities.mockResolvedValue([createMockAbility('test-v1')]);

      const output = await runCommand(AbilitiesList, ['--json'], ABILITIES_LIST_FLAGS);

      const jsonOutput = output.stdout.find((line) => line.includes('"success"'));
      const parsed = JSON.parse(jsonOutput!);

      expect(parsed).toHaveProperty('success', true);
      expect(parsed).toHaveProperty('data');
      expect(parsed).not.toHaveProperty('error');
    });

    it('error envelope has correct structure on failure', async () => {
      // No profile
      mockProfileStoreGetActive.mockResolvedValue(null);

      const output = await runCommand(AbilitiesList, ['--json'], ABILITIES_LIST_FLAGS);

      // On error, exit code should be set
      expect(output.exitCode).toBe(1);
    });
  });
});
