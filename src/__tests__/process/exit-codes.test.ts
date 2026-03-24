/**
 * Process-level tests for the exit code contract
 *
 * Verifies that mainwpcontrol exits with the correct code for each error category:
 *   0 = Success
 *   1 = Input error
 *   2 = Auth / config error
 *   3 = Network error
 *   4 = API error
 *   5 = Internal error
 *
 * Each test spawns mainwpcontrol as a real child process, so these validate
 * the full error-propagation path from command → base-command catch → exit.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { MockServer } from './fixtures/mock-server.js';
import { runCLI, type CLIResult } from './fixtures/cli-runner.js';
import { ConfigDir } from './fixtures/config-dir.js';
import { abilityRunSuccess } from './fixtures/api-responses.js';

describe('exit code contract', () => {
  const server = new MockServer();
  let config: ConfigDir;

  beforeAll(async () => {
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
  });

  afterEach(async () => {
    if (config) await config.cleanup();
  });

  /** Helper: run CLI with profile pointing at mock server. */
  function run(
    args: string[],
    opts?: { configDir?: ConfigDir; env?: Record<string, string> },
  ): Promise<CLIResult> {
    const cfg = opts?.configDir ?? config;
    return runCLI(args, {
      xdgConfigHome: cfg.xdgHome,
      env: {
        MAINWP_APP_PASSWORD: 'test-pass',
        ...opts?.env,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Exit 0 — Success
  // ---------------------------------------------------------------------------

  describe('exit 0: success', () => {
    it('abilities run list-sites-v1 --json exits 0 on success', async () => {
      config = await ConfigDir.create({
        profiles: [
          { name: 'test', dashboardUrl: server.baseUrl, username: 'admin' },
        ],
        activeProfile: 'test',
      });

      server.setAbilities();
      server.setRunResponse('list-sites-v1', abilityRunSuccess({
        sites: [{ id: 1, name: 'Alpha', url: 'https://alpha.example.com' }],
      }));

      const result = await run(['abilities', 'run', 'list-sites-v1', '--json']);

      expect(result.exitCode).toBe(0);
      expect(result.json).toBeDefined();

      const envelope = result.json as { success: boolean };
      expect(envelope.success).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Exit 1 — Input error: mutually exclusive flags (--dry-run + --confirm)
  // ---------------------------------------------------------------------------

  describe('exit 1: mutually exclusive flags', () => {
    it('abilities run delete-site-v1 --dry-run --confirm exits non-zero with exclusive flag error', async () => {
      config = await ConfigDir.create({
        profiles: [
          { name: 'test', dashboardUrl: server.baseUrl, username: 'admin' },
        ],
        activeProfile: 'test',
      });

      // No need to set up abilities/run routes — oclif rejects before
      // the command's run() method is reached.
      const result = await run([
        'abilities', 'run', 'delete-site-v1',
        '--dry-run', '--confirm',
        '--json',
      ]);

      // oclif throws a CLIError for exclusive flag violations.
      // The exact exit code depends on oclif's internal handling
      // (typically 2 for arg validation), so we assert non-zero and
      // verify the error message references the flag conflict.
      expect(result.exitCode).not.toBe(0);

      const combined = result.stdout + result.stderr;
      const mentionsExclusion =
        /exclusive/i.test(combined) ||
        /cannot also be provided/i.test(combined) ||
        /mutually exclusive/i.test(combined) ||
        /dry-run.*confirm/i.test(combined);
      expect(mentionsExclusion).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Exit 1 — Input error: invalid JSON in --input
  // ---------------------------------------------------------------------------

  describe('exit 1: bad JSON input', () => {
    it('abilities run list-sites-v1 --input "not json" exits 1 (InputError)', async () => {
      config = await ConfigDir.create({
        profiles: [
          { name: 'test', dashboardUrl: server.baseUrl, username: 'admin' },
        ],
        activeProfile: 'test',
      });

      server.setAbilities();

      const result = await run([
        'abilities', 'run', 'list-sites-v1',
        '--input', 'not json',
        '--json',
      ]);

      expect(result.exitCode).toBe(1);

      const envelope = result.json as { success: boolean; error?: { message: string; code: string } };
      expect(envelope.success).toBe(false);
      expect(envelope.error).toBeDefined();
      expect(envelope.error!.message).toMatch(/invalid json/i);
    });
  });

  // ---------------------------------------------------------------------------
  // Exit 2 — Config error: no profile configured
  // ---------------------------------------------------------------------------

  describe('exit 2: no profile configured', () => {
    it('abilities list exits 2 when no profile exists (ConfigError)', async () => {
      config = await ConfigDir.create({ profiles: [] });

      const result = await run(['abilities', 'list', '--json']);

      expect(result.exitCode).toBe(2);

      const envelope = result.json as { success: boolean; error?: { message: string; code: string } };
      expect(envelope.success).toBe(false);
      expect(envelope.error).toBeDefined();
      // The error should mention that no profile is configured
      const mentionsProfile =
        /no profile/i.test(envelope.error!.message) ||
        /profile.*configured/i.test(envelope.error!.message);
      expect(mentionsProfile).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Exit 3 — Network error: connection refused (closed port)
  // ---------------------------------------------------------------------------

  describe('exit 3: connection refused', () => {
    it('abilities list exits 3 when dashboard is unreachable (NetworkError)', async () => {
      // Point the profile at a high port that is definitely not listening.
      // Port 1 gives "bad port" from fetch, so use a port in the valid range.
      config = await ConfigDir.create({
        profiles: [
          {
            name: 'dead',
            dashboardUrl: 'http://127.0.0.1:19999',
            username: 'admin',
          },
        ],
        activeProfile: 'dead',
      });

      const result = await run(['abilities', 'list', '--json']);

      expect(result.exitCode).toBe(3);

      const envelope = result.json as { success: boolean; error?: { message: string } };
      expect(envelope.success).toBe(false);
      expect(envelope.error).toBeDefined();
      // The error should mention connection or refused
      const mentionsNetwork =
        /connection refused/i.test(envelope.error!.message) ||
        /ECONNREFUSED/i.test(envelope.error!.message) ||
        /dashboard running/i.test(envelope.error!.message);
      expect(mentionsNetwork).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Exit 4 — API error: server returns 500
  // ---------------------------------------------------------------------------

  describe('exit 4: server error (500)', () => {
    it('abilities run list-sites-v1 exits 4 when server returns 500 (APIError)', async () => {
      config = await ConfigDir.create({
        profiles: [
          { name: 'test', dashboardUrl: server.baseUrl, username: 'admin' },
        ],
        activeProfile: 'test',
      });

      // Abilities list endpoint succeeds (so the ability lookup works),
      // but the run endpoint returns 500.
      server.setAbilities();
      server.setRunResponse(
        'list-sites-v1',
        { error: 'Internal Server Error' },
        500,
      );

      const result = await run([
        'abilities', 'run', 'list-sites-v1', '--json',
      ]);

      expect(result.exitCode).toBe(4);

      const envelope = result.json as { success: boolean; error?: { message: string } };
      expect(envelope.success).toBe(false);
      expect(envelope.error).toBeDefined();
    });
  });
});
