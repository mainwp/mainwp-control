/**
 * Process-level tests for the doctor command
 *
 * Verifies diagnostic checks end-to-end by spawning mainwpcontrol as a child
 * process against a mock HTTP server. Each test gets a fresh config
 * directory to ensure isolation.
 *
 * Doctor checks (in order):
 *   Profiles, Keychain, Active Profile, Credentials,
 *   Dashboard Connection, Abilities API, LLM Provider
 *
 * Critical checks (affect ready flag):
 *   Profiles, Active Profile, Credentials, Dashboard Connection
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { MockServer } from './fixtures/mock-server.js';
import { runCLI } from './fixtures/cli-runner.js';
import { ConfigDir } from './fixtures/config-dir.js';

describe('doctor command', () => {
  const server = new MockServer();
  let configDir: ConfigDir;

  beforeAll(async () => {
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
    server.setAbilities();
  });

  afterEach(async () => {
    if (configDir) {
      await configDir.cleanup();
    }
  });

  // ---------------------------------------------------------------------------
  // 1. Valid profile + reachable server -> exit 0, stdout contains check results
  // ---------------------------------------------------------------------------

  it('doctor with valid profile and reachable server exits 0', async () => {
    configDir = await ConfigDir.create({
      profiles: [
        {
          name: 'test',
          dashboardUrl: server.baseUrl,
          username: 'admin',
        },
      ],
      activeProfile: 'test',
    });

    const result = await runCLI(['doctor'], {
      xdgConfigHome: configDir.xdgHome,
      env: {
        MAINWP_APP_PASSWORD: 'test-pass',
        // Clear LLM keys to avoid host leakage (LLM is warn, not critical)
        ANTHROPIC_API_KEY: '',
        OPENAI_API_KEY: '',
        GOOGLE_API_KEY: '',
        OPENROUTER_API_KEY: '',
        LOCAL_LLM_URL: '',
        MAINWP_LLM_PROVIDER: '',
      },
    });

    expect(result.exitCode).toBe(0);

    const combined = result.stdout + result.stderr;
    // Human output includes "ready" when all critical checks pass
    expect(combined).toMatch(/ready/i);
    // Should mention the checks ran (profile name, abilities count, etc.)
    expect(combined).toMatch(/profile/i);
  });

  // ---------------------------------------------------------------------------
  // 2. doctor --json -> structured JSON envelope with checks array and ready flag
  // ---------------------------------------------------------------------------

  it('doctor --json outputs structured report with checks, summary, and ready flag', async () => {
    configDir = await ConfigDir.create({
      profiles: [
        {
          name: 'test',
          dashboardUrl: server.baseUrl,
          username: 'admin',
        },
      ],
      activeProfile: 'test',
    });

    const result = await runCLI(['doctor', '--json'], {
      xdgConfigHome: configDir.xdgHome,
      env: {
        MAINWP_APP_PASSWORD: 'test-pass',
        ANTHROPIC_API_KEY: '',
        OPENAI_API_KEY: '',
        GOOGLE_API_KEY: '',
        OPENROUTER_API_KEY: '',
        LOCAL_LLM_URL: '',
        MAINWP_LLM_PROVIDER: '',
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.json).toBeDefined();

    const envelope = result.json as {
      success: boolean;
      data: {
        checks: Array<{
          name: string;
          status: 'pass' | 'warn' | 'fail';
          message: string;
          details?: string;
        }>;
        summary: {
          passed: number;
          warnings: number;
          failed: number;
        };
        ready: boolean;
      };
    };

    expect(envelope.success).toBe(true);
    expect(envelope.data).toBeDefined();

    // Validate checks array structure
    expect(Array.isArray(envelope.data.checks)).toBe(true);
    expect(envelope.data.checks.length).toBe(7);

    // Every check should have name, status, and message
    for (const check of envelope.data.checks) {
      expect(check.name).toBeDefined();
      expect(['pass', 'warn', 'fail']).toContain(check.status);
      expect(check.message).toBeDefined();
    }

    // Validate specific check names are present
    const checkNames = envelope.data.checks.map((c) => c.name);
    expect(checkNames).toContain('Profiles');
    expect(checkNames).toContain('Keychain');
    expect(checkNames).toContain('Active Profile');
    expect(checkNames).toContain('Credentials');
    expect(checkNames).toContain('Dashboard Connection');
    expect(checkNames).toContain('Abilities API');
    expect(checkNames).toContain('LLM Provider');

    // Critical checks should all pass with valid config + reachable server
    const criticalChecks = ['Profiles', 'Active Profile', 'Credentials', 'Dashboard Connection'];
    for (const name of criticalChecks) {
      const check = envelope.data.checks.find((c) => c.name === name);
      expect(check?.status).toBe('pass');
    }

    // LLM Provider should be 'warn' (no LLM env vars set)
    const llmCheck = envelope.data.checks.find((c) => c.name === 'LLM Provider');
    expect(llmCheck?.status).toBe('warn');

    // Summary should reflect the counts
    expect(envelope.data.summary).toBeDefined();
    expect(envelope.data.summary.passed).toBeGreaterThanOrEqual(4);
    expect(typeof envelope.data.summary.warnings).toBe('number');
    expect(typeof envelope.data.summary.failed).toBe('number');
    expect(envelope.data.summary.failed).toBe(0);

    // System should be ready since all critical checks pass
    expect(envelope.data.ready).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 3. No profile configured -> exit 1 (INPUT_ERROR)
  // ---------------------------------------------------------------------------

  it('doctor with no profiles configured exits 1', async () => {
    configDir = await ConfigDir.create({ profiles: [] });

    const result = await runCLI(['doctor'], {
      xdgConfigHome: configDir.xdgHome,
      env: {
        ANTHROPIC_API_KEY: '',
        OPENAI_API_KEY: '',
        GOOGLE_API_KEY: '',
        OPENROUTER_API_KEY: '',
        LOCAL_LLM_URL: '',
        MAINWP_LLM_PROVIDER: '',
      },
    });

    // Doctor exits with ExitCode.INPUT_ERROR (1) when not ready
    expect(result.exitCode).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 3b. No profile configured + --json -> structured failure report
  // ---------------------------------------------------------------------------

  it('doctor --json with no profiles shows failed critical checks and ready=false', async () => {
    configDir = await ConfigDir.create({ profiles: [] });

    const result = await runCLI(['doctor', '--json'], {
      xdgConfigHome: configDir.xdgHome,
      env: {
        ANTHROPIC_API_KEY: '',
        OPENAI_API_KEY: '',
        GOOGLE_API_KEY: '',
        OPENROUTER_API_KEY: '',
        LOCAL_LLM_URL: '',
        MAINWP_LLM_PROVIDER: '',
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.json).toBeDefined();

    const envelope = result.json as {
      success: boolean;
      data: {
        checks: Array<{
          name: string;
          status: 'pass' | 'warn' | 'fail';
          message: string;
          details?: string;
        }>;
        summary: {
          passed: number;
          warnings: number;
          failed: number;
        };
        ready: boolean;
      };
    };

    expect(envelope.success).toBe(true);
    expect(envelope.data).toBeDefined();
    expect(envelope.data.ready).toBe(false);

    // Profiles check should fail (no profiles)
    const profilesCheck = envelope.data.checks.find((c) => c.name === 'Profiles');
    expect(profilesCheck?.status).toBe('fail');

    // Active Profile check should fail (no active profile)
    const activeProfileCheck = envelope.data.checks.find((c) => c.name === 'Active Profile');
    expect(activeProfileCheck?.status).toBe('fail');

    // Credentials check should fail (no profile to check)
    const credentialsCheck = envelope.data.checks.find((c) => c.name === 'Credentials');
    expect(credentialsCheck?.status).toBe('fail');

    // Dashboard Connection should fail (no profile to check)
    const dashboardCheck = envelope.data.checks.find((c) => c.name === 'Dashboard Connection');
    expect(dashboardCheck?.status).toBe('fail');

    // Summary should reflect failures
    expect(envelope.data.summary.failed).toBeGreaterThanOrEqual(4);
  });

  // ---------------------------------------------------------------------------
  // 4. No legacy warning leakage in doctor output
  // ---------------------------------------------------------------------------

  it('doctor output does not contain legacy console.warn strings', async () => {
    configDir = await ConfigDir.create({
      profiles: [
        {
          name: 'test',
          dashboardUrl: server.baseUrl,
          username: 'admin',
        },
      ],
      activeProfile: 'test',
    });

    const result = await runCLI(['doctor'], {
      xdgConfigHome: configDir.xdgHome,
      env: {
        MAINWP_APP_PASSWORD: 'test-pass',
        ANTHROPIC_API_KEY: '',
        OPENAI_API_KEY: '',
        GOOGLE_API_KEY: '',
        OPENROUTER_API_KEY: '',
        LOCAL_LLM_URL: '',
        MAINWP_LLM_PROVIDER: '',
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain('Could not read from keychain');
    expect(result.stderr).not.toContain('WARNING: Using HTTP');
    expect(result.stderr).not.toContain('WARNING: SSL verification');
  });

  // ---------------------------------------------------------------------------
  // 4b. Human output strips escape sequences from check messages/details
  // ---------------------------------------------------------------------------

  it('doctor human output strips terminal escape sequences from config-derived text', async () => {
    // A profile name with an embedded CSI clear-screen sequence, as a stand-in
    // for any hostile/corrupted text reaching a check's message or details
    // (profiles.json is user-editable on disk, so this needs no login-path bypass).
    configDir = await ConfigDir.create({
      profiles: [
        {
          name: 'evil\u001b[2Jpwn',
          dashboardUrl: server.baseUrl,
          username: 'admin',
        },
      ],
      activeProfile: 'evil\u001b[2Jpwn',
    });

    const result = await runCLI(['doctor', '-v'], {
      xdgConfigHome: configDir.xdgHome,
      env: {
        MAINWP_APP_PASSWORD: 'test-pass',
        ANTHROPIC_API_KEY: '',
        OPENAI_API_KEY: '',
        GOOGLE_API_KEY: '',
        OPENROUTER_API_KEY: '',
        LOCAL_LLM_URL: '',
        MAINWP_LLM_PROVIDER: '',
      },
    });

    const combined = result.stdout + result.stderr;
    // The escape sequence must not survive to the terminal...
    expect(combined).not.toContain('\u001b[2J');
    // ...but the surrounding profile-name text still renders (Active Profile check).
    expect(combined).toContain('evilpwn');
  });

  // ---------------------------------------------------------------------------
  // 5. Doctor --json stability with env var fallback
  // ---------------------------------------------------------------------------

  it('doctor --json envelope is stable with env var credential fallback', async () => {
    configDir = await ConfigDir.create({
      profiles: [
        {
          name: 'test',
          dashboardUrl: server.baseUrl,
          username: 'admin',
        },
      ],
      activeProfile: 'test',
    });

    const result = await runCLI(['doctor', '--json'], {
      xdgConfigHome: configDir.xdgHome,
      env: {
        MAINWP_APP_PASSWORD: 'test-pass',
        ANTHROPIC_API_KEY: '',
        OPENAI_API_KEY: '',
        GOOGLE_API_KEY: '',
        OPENROUTER_API_KEY: '',
        LOCAL_LLM_URL: '',
        MAINWP_LLM_PROVIDER: '',
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.json).toBeDefined();

    const envelope = result.json as {
      success: boolean;
      data: {
        checks: Array<{ name: string; status: string; message: string }>;
        summary: { passed: number; warnings: number; failed: number };
        ready: boolean;
      };
    };

    // Envelope structure
    expect(envelope.data.checks).toBeDefined();
    expect(envelope.data.summary).toBeDefined();
    expect(typeof envelope.data.ready).toBe('boolean');
    expect(envelope.data.ready).toBe(true);

    // All 7 check names present
    const checkNames = envelope.data.checks.map((c) => c.name);
    expect(checkNames).toEqual(
      expect.arrayContaining([
        'Profiles',
        'Keychain',
        'Active Profile',
        'Credentials',
        'Dashboard Connection',
        'Abilities API',
        'LLM Provider',
      ])
    );
  });

  it('masks userinfo from a legacy profile in JSON mode', async () => {
    configDir = await ConfigDir.create({
      profiles: [
        {
          name: 'legacy',
          dashboardUrl: 'https://legacy:secret@dashboard.example.com',
          username: 'admin',
        },
      ],
      activeProfile: 'legacy',
    });

    const result = await runCLI(['doctor', '--json'], {
      xdgConfigHome: configDir.xdgHome,
      env: {
        MAINWP_APP_PASSWORD: 'test-pass',
        ANTHROPIC_API_KEY: '',
        OPENAI_API_KEY: '',
        GOOGLE_API_KEY: '',
        OPENROUTER_API_KEY: '',
        LOCAL_LLM_URL: '',
        MAINWP_LLM_PROVIDER: '',
      },
    });

    const envelope = result.json as {
      data: { checks: Array<{ name: string; details?: string }> };
    };
    const activeProfile = envelope.data.checks.find(
      (check) => check.name === 'Active Profile'
    );
    expect(activeProfile?.details).toBe('https://***:***@dashboard.example.com');
    expect(result.stdout).not.toContain('legacy:secret');
  });

  it('redacts sensitive URL parameters echoed by a connection failure', async () => {
    // The transport echoes an unparseable redirect Location verbatim, so a
    // URL carrying ?access_token= reaches the Dashboard Connection details.
    // reset() drops the beforeEach abilities route so this one matches first.
    server.reset();
    server.addRoute('GET', '/wp-json/wp-abilities/v1/abilities', (_req, res) => {
      res.writeHead(302, { Location: 'http://[::1?access_token=SECRET' });
      res.end();
    });

    configDir = await ConfigDir.create({
      profiles: [
        {
          name: 'test',
          dashboardUrl: server.baseUrl,
          username: 'admin',
        },
      ],
      activeProfile: 'test',
    });

    const result = await runCLI(['doctor', '--json'], {
      xdgConfigHome: configDir.xdgHome,
      env: {
        MAINWP_APP_PASSWORD: 'test-pass',
        ANTHROPIC_API_KEY: '',
        OPENAI_API_KEY: '',
        GOOGLE_API_KEY: '',
        OPENROUTER_API_KEY: '',
        LOCAL_LLM_URL: '',
        MAINWP_LLM_PROVIDER: '',
      },
    });

    const envelope = result.json as {
      data: { checks: Array<{ name: string; details?: string }> };
    };
    const connection = envelope.data.checks.find(
      (check) => check.name === 'Dashboard Connection'
    );
    expect(connection?.details).toContain('access_token=[REDACTED]');
    expect(connection?.details).not.toContain('SECRET');
    expect(result.stdout + result.stderr).not.toContain('SECRET');
  });
});
