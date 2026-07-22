/**
 * E2E Test: Exit Code Verification
 *
 * Validates the exit code contract for CI/CD pipelines.
 * Exit codes are stable and documented — do not change without updating docs.
 *
 * INVARIANTS TESTED:
 * - Exit code 0: success
 * - Exit code 1: user/input/schema error
 * - Exit code 2: auth/config error
 * - Exit code 4: API/ability error
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createMockProfile,
  createMockAbility,
  createMockHttpResponse,
  restoreEnvVars,
  STANDARD_ABILITIES,
  createCommandHarness,
  type CapturedOutput,
} from './test-helpers.js';

// ============================================================================
// Module-level mocks
// ============================================================================

const mockProfileStoreGet = vi.fn();
const mockProfileStoreGetActive = vi.fn();
const mockProfileStoreSave = vi.fn();
const mockProfileStoreList = vi.fn();
const mockProfileStoreDelete = vi.fn();
const mockProfileStoreSetActive = vi.fn();

vi.mock('../../config/profile-store.js', () => ({
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

const mockKeychainGetOrThrow = vi.fn();
const mockKeychainSet = vi.fn();

vi.mock('../../config/keychain.js', () => ({
  getKeychain: vi.fn(() => ({
    get: vi.fn(),
    getOrThrow: mockKeychainGetOrThrow,
    set: mockKeychainSet,
    delete: vi.fn(),
    isAvailable: vi.fn().mockResolvedValue(true),
  })),
  Keychain: vi.fn(),
}));

const mockHttpGet = vi.fn();
const mockHttpPost = vi.fn();

vi.mock('../../core/http-client.js', () => ({
  createHttpClient: vi.fn(() => ({
    get: mockHttpGet,
    post: mockHttpPost,
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
}));

vi.mock('node:readline', () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn(),
    close: vi.fn(),
    on: vi.fn().mockReturnThis(),
  })),
}));

vi.mock('../../config/settings.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../config/settings.js')>();
  return {
    ...original,
    loadSettings: vi.fn().mockResolvedValue({}),
  };
});

// ============================================================================
// Imports (after mocks)
// ============================================================================

import AbilitiesRun from '../../commands/abilities/run.js';

// ============================================================================
// Test Utilities
// ============================================================================

function createRunCommand(
  argv: string[] = []
): { command: AbilitiesRun; output: CapturedOutput } {
  return createCommandHarness(AbilitiesRun, argv);
}

async function runAbilitiesRun(
  argv: string[],
  parsedFlags: Record<string, unknown>,
  parsedArgs: Record<string, string>
): Promise<CapturedOutput> {
  const { command, output } = createRunCommand(argv);

  command.parse = vi.fn().mockResolvedValue({
    flags: {
      json: false,
      quiet: false,
      debug: false,
      'dry-run': false,
      confirm: false,
      force: false,
      input: '{}',
      wait: false,
      'wait-timeout': 300,
      ...parsedFlags,
    },
    args: parsedArgs,
  }) as never;

  try {
    await command.run();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('EXIT:')) {
      // Expected exit
    } else {
      // Call the command's catch handler to map exit codes
      try {
        await (command as any).catch(error);
      } catch {
        // catch handler calls this.exit() which throws
      }
    }
  }

  return output;
}

// ============================================================================
// Tests
// ============================================================================

describe('E2E: Exit Code Contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProfileStoreGet.mockReset();
    mockProfileStoreGetActive.mockReset();
    mockKeychainGetOrThrow.mockReset();
    mockExecutorListAbilities.mockReset();
    mockExecutorExecute.mockReset();
    mockExecutorGetAbility.mockReset();
    mockHttpGet.mockReset();
    mockHttpPost.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
    restoreEnvVars();
  });

  // Success case (exit code 0)
  it('exits with code 0 on successful read-only ability', async () => {
    const mockProfile = createMockProfile();
    mockProfileStoreGetActive.mockResolvedValue(mockProfile);
    mockKeychainGetOrThrow.mockResolvedValue('test-password');
    mockExecutorGetAbility.mockResolvedValue(
      createMockAbility('list-sites-v1', { readonly: true })
    );
    mockExecutorExecute.mockResolvedValue({
      success: true,
      data: { sites: [] },
    });

    const output = await runAbilitiesRun(
      ['list-sites-v1'],
      {},
      { name: 'list-sites-v1' }
    );

    // No exit code set = success (0)
    expect(output.exitCode).toBeUndefined();
  });

  // Input error (exit code 1): nonexistent ability
  it('exits with code 1 for nonexistent ability', async () => {
    const mockProfile = createMockProfile();
    mockProfileStoreGetActive.mockResolvedValue(mockProfile);
    mockKeychainGetOrThrow.mockResolvedValue('test-password');
    mockExecutorGetAbility.mockResolvedValue(null);

    const output = await runAbilitiesRun(
      ['nonexistent-ability-v1'],
      {},
      { name: 'nonexistent-ability-v1' }
    );

    expect(output.exitCode).toBe(1);
  });

  // Input error (exit code 1): bad JSON input
  it('exits with code 1 for invalid JSON input', async () => {
    const mockProfile = createMockProfile();
    mockProfileStoreGetActive.mockResolvedValue(mockProfile);
    mockKeychainGetOrThrow.mockResolvedValue('test-password');
    mockExecutorGetAbility.mockResolvedValue(
      createMockAbility('list-sites-v1', { readonly: true })
    );

    const output = await runAbilitiesRun(
      ['list-sites-v1', '--input', 'bad json'],
      { input: 'bad json' },
      { name: 'list-sites-v1' }
    );

    expect(output.exitCode).toBe(1);
  });

  // Input error (exit code 1): mutual exclusion --dry-run + --confirm
  it('exits with code 1 when --dry-run and --confirm both provided', async () => {
    const mockProfile = createMockProfile();
    mockProfileStoreGetActive.mockResolvedValue(mockProfile);
    mockKeychainGetOrThrow.mockResolvedValue('test-password');
    mockExecutorGetAbility.mockResolvedValue(
      createMockAbility('delete-site-v1', { destructive: true })
    );

    const output = await runAbilitiesRun(
      ['delete-site-v1', '--dry-run', '--confirm'],
      { 'dry-run': true, confirm: true },
      { name: 'delete-site-v1' }
    );

    expect(output.exitCode).toBe(1);
  });

  // Config error (exit code 2): no profile configured
  it('exits with code 2 when no profile is configured', async () => {
    mockProfileStoreGetActive.mockResolvedValue(null);

    const output = await runAbilitiesRun(
      ['list-sites-v1'],
      {},
      { name: 'list-sites-v1' }
    );

    expect(output.exitCode).toBe(2);
  });

  // API error (exit code 4): API returns error response
  it('handles API error response from execution', async () => {
    const mockProfile = createMockProfile();
    mockProfileStoreGetActive.mockResolvedValue(mockProfile);
    mockKeychainGetOrThrow.mockResolvedValue('test-password');
    mockExecutorGetAbility.mockResolvedValue(
      createMockAbility('list-sites-v1', { readonly: true })
    );
    mockExecutorExecute.mockResolvedValue({
      success: false,
      error: { code: 'API_ERROR', message: 'Something went wrong' },
    });

    const output = await runAbilitiesRun(
      ['list-sites-v1'],
      {},
      { name: 'list-sites-v1' }
    );

    expect(output.exitCode).toBe(4);
  });

  // Destructive without flags → ConfirmationRequiredError (exit code 4)
  it('exits with error for destructive ability without --dry-run or --confirm', async () => {
    const mockProfile = createMockProfile();
    mockProfileStoreGetActive.mockResolvedValue(mockProfile);
    mockKeychainGetOrThrow.mockResolvedValue('test-password');
    mockExecutorGetAbility.mockResolvedValue(
      createMockAbility('delete-site-v1', { destructive: true })
    );

    const output = await runAbilitiesRun(
      ['delete-site-v1'],
      {},
      { name: 'delete-site-v1' }
    );

    // ConfirmationRequiredError has exit code 4 (API_ERROR)
    expect(output.exitCode).toBe(4);
  });
});
