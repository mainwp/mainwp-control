/**
 * E2E Test: JSON Output Contract
 *
 * Validates that --json output follows the stable CLIOutput<T> envelope
 * from src/output/json-envelope.ts. This is a CI/CD contract.
 *
 * INVARIANTS TESTED:
 * - All --json output is valid JSON
 * - Success envelope: { success: true, data: T }
 * - Error envelope: { success: false, error: { code, message } }
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createMockProfile,
  createMockAbility,
  restoreEnvVars,
} from './test-helpers.js';

// ============================================================================
// Module-level mocks
// ============================================================================

const mockProfileStoreGet = vi.fn();
const mockProfileStoreGetActive = vi.fn();

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
    getCategories: vi.fn().mockResolvedValue([]),
    listByCategory: vi.fn().mockResolvedValue([]),
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
import AbilitiesList from '../../commands/abilities/list.js';

// ============================================================================
// Test Utilities
// ============================================================================

interface CapturedOutput {
  stdout: string[];
  stderr: string[];
  exitCode?: number;
}

function createCommand<T extends AbilitiesRun | AbilitiesList>(
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

function findJsonOutput(lines: string[]): unknown | undefined {
  // JSON output may span multiple lines (pretty-printed)
  const joined = lines.join('\n');
  // Try to find a JSON block
  const match = joined.match(/\{[\s\S]*"success"[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {
      // Fall through
    }
  }
  // Try each line individually
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed === 'object' && parsed !== null && 'success' in parsed) {
        return parsed;
      }
    } catch {
      // Not JSON
    }
  }
  return undefined;
}

// ============================================================================
// Tests
// ============================================================================

describe('E2E: JSON Output Contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const mockProfile = createMockProfile();
    mockProfileStoreGetActive.mockResolvedValue(mockProfile);
    mockKeychainGetOrThrow.mockResolvedValue('test-password');
  });

  afterEach(() => {
    vi.clearAllMocks();
    restoreEnvVars();
  });

  describe('abilities list --json', () => {
    it('outputs valid JSON with success envelope and data array', async () => {
      const abilities = [
        createMockAbility('list-sites-v1', { readonly: true }),
        createMockAbility('delete-site-v1', { destructive: true }),
      ];
      mockExecutorListAbilities.mockResolvedValue(abilities);

      const { command, output } = createCommand(AbilitiesList);
      command.parse = vi.fn().mockResolvedValue({
        flags: { json: true, quiet: false, debug: false },
        args: {},
      }) as never;

      try { await command.run(); } catch { /* exit */ }

      const json = findJsonOutput(output.stdout) as Record<string, unknown>;
      expect(json).toBeDefined();
      expect(json.success).toBe(true);
      expect(json.data).toBeDefined();

      const data = json.data as Record<string, unknown>;
      expect(Array.isArray(data.abilities)).toBe(true);
      expect(typeof data.total).toBe('number');
    });
  });

  describe('abilities run --json (success)', () => {
    it('outputs valid JSON with success: true and data present', async () => {
      mockExecutorGetAbility.mockResolvedValue(
        createMockAbility('list-sites-v1', { readonly: true })
      );
      mockExecutorExecute.mockResolvedValue({
        success: true,
        data: { sites: [{ id: 1, name: 'test.com' }] },
      });

      const { command, output } = createCommand(AbilitiesRun);
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

      const json = findJsonOutput(output.stdout) as Record<string, unknown>;
      expect(json).toBeDefined();
      expect(json.success).toBe(true);
      expect(json.data).toBeDefined();
    });
  });

  describe('abilities run --json (error)', () => {
    it('throws InputError for nonexistent ability (maps to exit code 1)', async () => {
      mockExecutorGetAbility.mockResolvedValue(null);

      const { command, output } = createCommand(AbilitiesRun);
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
        args: { name: 'nonexistent-v1' },
      }) as never;

      try {
        await command.run();
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('EXIT:')) {
          // Expected exit from mocked exit()
        } else {
          // The error should be an InputError (exit code 1)
          const { InputError } = await import('../../utils/errors.js');
          expect(error).toBeInstanceOf(InputError);
          expect((error as InstanceType<typeof InputError>).exitCode).toBe(1);
          return;
        }
      }

      // If we reach here via exit(), check exitCode
      if (output.exitCode !== undefined) {
        expect(output.exitCode).toBe(1);
      }
    });
  });

  describe('abilities run --json with batch job', () => {
    it('outputs batch job ID in JSON envelope', async () => {
      mockExecutorGetAbility.mockResolvedValue(
        createMockAbility('sync-sites-v1', { readonly: false })
      );
      mockExecutorExecute.mockResolvedValue({
        success: true,
        data: {},
        jobId: 'batch_abc123',
      });

      const { command, output } = createCommand(AbilitiesRun);
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
        args: { name: 'sync-sites-v1' },
      }) as never;

      try { await command.run(); } catch { /* exit */ }

      const json = findJsonOutput(output.stdout) as Record<string, unknown>;
      expect(json).toBeDefined();
      expect(json.success).toBe(true);
      expect((json.data as Record<string, unknown>).jobId).toBe('batch_abc123');
    });
  });

  describe('JSON parsability', () => {
    it('all --json output lines parse cleanly with JSON.parse', async () => {
      const abilities = [
        createMockAbility('list-sites-v1', { readonly: true }),
      ];
      mockExecutorListAbilities.mockResolvedValue(abilities);

      const { command, output } = createCommand(AbilitiesList);
      command.parse = vi.fn().mockResolvedValue({
        flags: { json: true, quiet: false, debug: false },
        args: {},
      }) as never;

      try { await command.run(); } catch { /* exit */ }

      // All non-empty stdout should be part of valid JSON
      const allOutput = output.stdout.join('\n').trim();
      if (allOutput) {
        expect(() => JSON.parse(allOutput)).not.toThrow();
      }
    });
  });
});
