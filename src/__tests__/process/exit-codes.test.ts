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
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
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
    it('abilities run delete-site-v1 --dry-run --confirm exits 1 with prose on stderr', async () => {
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
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');

      const mentionsExclusion =
        /exclusive/i.test(result.stderr) ||
        /cannot also be provided/i.test(result.stderr) ||
        /mutually exclusive/i.test(result.stderr) ||
        /dry-run.*confirm/i.test(result.stderr);
      expect(mentionsExclusion).toBe(true);
    });

    it('emits exactly one JSON error envelope on stdout for a parse-time error', async () => {
      config = await ConfigDir.create({
        profiles: [
          { name: 'test', dashboardUrl: server.baseUrl, username: 'admin' },
        ],
        activeProfile: 'test',
      });

      const result = await run([
        'abilities', 'run', 'delete-site-v1',
        '--dry-run', '--confirm', '--json',
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe('');
      const envelope = JSON.parse(result.stdout) as {
        success: boolean;
        error?: { message?: string };
      };
      expect(envelope.success).toBe(false);
      expect(envelope.error?.message).toMatch(/confirm|exclusive|provided/i);
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

// -----------------------------------------------------------------------------
// Exit 5 — Internal error: untyped settings I/O failure
// -----------------------------------------------------------------------------

describe('exit 5: unexpected settings read failure', () => {
  let config: ConfigDir;

  afterEach(async () => {
    if (config) await config.cleanup();
  });

  it('abilities list exits 5 when settings.json cannot be read as a file', async () => {
    config = await ConfigDir.create({ profiles: [] });
    await mkdir(join(config.configPath, 'settings.json'));

    const result = await runCLI(['abilities', 'list', '--json'], {
      xdgConfigHome: config.xdgHome,
      env: { MAINWP_APP_PASSWORD: 'test-pass' },
    });

    expect(result.exitCode).toBe(5);
    // stderr carries the human-readable error line; the --json contract
    // guarantees stdout purity, not stderr silence.
    expect(JSON.parse(result.stdout)).toMatchObject({
      success: false,
      error: expect.any(Object),
    });
  });
});

// -----------------------------------------------------------------------------
// Exit 130 — Ctrl-C at an interactive password prompt
// -----------------------------------------------------------------------------

describe('exit 130: password prompt interrupted', () => {
  let config: ConfigDir;

  afterEach(async () => {
    if (config) await config.cleanup();
  });

  it('login exits 130 when Ctrl-C interrupts the password prompt', async () => {
    config = await ConfigDir.create({ profiles: [] });

    const result = await runCLI(
      [
        'login',
        '--url', 'https://dashboard.example.com',
        '--username', 'admin',
      ],
      {
        xdgConfigHome: config.xdgHome,
        env: {},
        // Keep stdin pipe-based for deterministic CI input while emulating the
        // TTY flags checked by login. In raw mode, Ctrl-C arrives as ETX.
        emulateTTY: true,
        stdin: '\u0003',
        stdinWaitFor: 'Application password',
      },
    );

    expect(result.stdout).toContain('Application password');
    expect(result.exitCode).toBe(130);
  });
});
