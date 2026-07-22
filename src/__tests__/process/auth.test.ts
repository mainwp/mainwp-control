/**
 * Process-level tests for the login command
 *
 * Verifies authentication flow end-to-end by spawning mainwpcontrol as a child
 * process against a mock HTTP server. Each test gets a fresh, empty config
 * directory to ensure isolation.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { MockServer } from './fixtures/mock-server.js';
import { runCLI } from './fixtures/cli-runner.js';
import { ConfigDir } from './fixtures/config-dir.js';

describe('login command', () => {
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

  // -------------------------------------------------------------------------
  // 1. Successful login → exit 0, profile persisted
  // -------------------------------------------------------------------------

  it('login with valid credentials exits 0 and stores profile', async () => {
    configDir = await ConfigDir.create({ profiles: [] });

    const result = await runCLI(
      [
        'login',
        '--url', server.baseUrl,
        '--username', 'admin',
        '--password', 'test-pass',
      ],
      {
        xdgConfigHome: configDir.xdgHome,
        env: { MAINWP_APP_PASSWORD: 'test-pass' },
      },
    );

    expect(result.exitCode).toBe(0);

    // Verify profile was persisted
    const profiles = await configDir.readProfiles();
    expect(profiles.profiles).toHaveLength(1);

    const profile = profiles.profiles[0]!;
    expect(profile.dashboardUrl).toBe(server.baseUrl);
    expect(profile.username).toBe('admin');
    // Profile name defaults to hostname when --name is not provided
    expect(profile.name).toBe('127.0.0.1');
    // Should be set as active
    expect(profiles.activeProfile).toBe(profile.name);
  });

  it('login uses MAINWP_APP_PASSWORD in non-interactive mode when --password is omitted', async () => {
    configDir = await ConfigDir.create({ profiles: [] });

    const result = await runCLI(
      [
        'login',
        '--url', server.baseUrl,
        '--username', 'admin',
      ],
      {
        xdgConfigHome: configDir.xdgHome,
        env: { MAINWP_APP_PASSWORD: 'test-pass' },
      },
    );

    expect(result.exitCode).toBe(0);

    const profiles = await configDir.readProfiles();
    expect(profiles.profiles).toHaveLength(1);
    expect(profiles.profiles[0]!.username).toBe('admin');
  });

  // -------------------------------------------------------------------------
  // 2. Successful login with --json → JSON envelope
  // -------------------------------------------------------------------------

  it('login with --json outputs success envelope with profile data', async () => {
    configDir = await ConfigDir.create({ profiles: [] });

    const result = await runCLI(
      [
        'login',
        '--url', server.baseUrl,
        '--username', 'admin',
        '--password', 'test-pass',
        '--json',
      ],
      {
        xdgConfigHome: configDir.xdgHome,
        env: { MAINWP_APP_PASSWORD: 'test-pass' },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.json).toBeDefined();

    const envelope = result.json as {
      success: boolean;
      data: {
        profile: string;
        url: string;
        username: string;
        credentialStorage: string;
      };
    };

    expect(envelope.success).toBe(true);
    expect(envelope.data).toBeDefined();
    expect(envelope.data.profile).toBe('127.0.0.1');
    expect(envelope.data.url).toBe(server.baseUrl);
    expect(envelope.data.username).toBe('admin');
    expect(envelope.data.credentialStorage).toBeDefined();
  });

  it('login in non-interactive mode without a password source exits with actionable guidance', async () => {
    configDir = await ConfigDir.create({ profiles: [] });

    const result = await runCLI(
      [
        'login',
        '--url', server.baseUrl,
        '--username', 'admin',
      ],
      {
        xdgConfigHome: configDir.xdgHome,
        env: {},
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/MAINWP_APP_PASSWORD|--password/);

    const profiles = await configDir.readProfiles();
    expect(profiles.profiles).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 3. Bad credentials (401) → non-zero exit, stderr mentions auth failure
  // -------------------------------------------------------------------------

  it('login with bad credentials exits non-zero with auth error', async () => {
    configDir = await ConfigDir.create({ profiles: [] });

    // Set server to expect different credentials so auth check returns 401
    server.setCredentials('admin', 'correct-password');

    const result = await runCLI(
      [
        'login',
        '--url', server.baseUrl,
        '--username', 'admin',
        '--password', 'wrong-password',
      ],
      {
        xdgConfigHome: configDir.xdgHome,
        env: { MAINWP_APP_PASSWORD: 'wrong-password' },
      },
    );

    expect(result.exitCode).not.toBe(0);

    const combined = result.stdout + result.stderr;
    const mentionsAuthFailure =
      /failed/i.test(combined) || /authentication/i.test(combined);
    expect(mentionsAuthFailure).toBe(true);

    // Verify no profile was stored
    const profiles = await configDir.readProfiles();
    expect(profiles.profiles).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 4. --name custom → profile created with custom name
  // -------------------------------------------------------------------------

  it('login with --name creates profile with custom name', async () => {
    configDir = await ConfigDir.create({ profiles: [] });

    const result = await runCLI(
      [
        'login',
        '--url', server.baseUrl,
        '--username', 'admin',
        '--password', 'test-pass',
        '--name', 'custom',
      ],
      {
        xdgConfigHome: configDir.xdgHome,
        env: { MAINWP_APP_PASSWORD: 'test-pass' },
      },
    );

    expect(result.exitCode).toBe(0);

    const profiles = await configDir.readProfiles();
    expect(profiles.profiles).toHaveLength(1);
    expect(profiles.profiles[0]!.name).toBe('custom');
    expect(profiles.activeProfile).toBe('custom');
  });

  it('login with --password warns that the password is process-visible', async () => {
    configDir = await ConfigDir.create({ profiles: [] });

    const result = await runCLI(
      [
        'login',
        '--url', server.baseUrl,
        '--username', 'admin',
        '--password', 'test-pass',
      ],
      {
        xdgConfigHome: configDir.xdgHome,
        env: {},
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toMatch(/process list|MAINWP_APP_PASSWORD/);
  });

  // -------------------------------------------------------------------------
  // 4b. URL with embedded userinfo → rejected before any connection attempt
  // -------------------------------------------------------------------------

  it.each([
    ['user and password', (base: string) => base.replace('://', '://user:pass@')],
    ['user only', (base: string) => base.replace('://', '://user@')],
  ])(
    'login with embedded credentials in URL (%s) exits 2 without contacting the server',
    async (_label, embed) => {
      configDir = await ConfigDir.create({ profiles: [] });

      const result = await runCLI(
        [
          'login',
          '--url', embed(server.baseUrl),
          '--username', 'admin',
          '--password', 'test-pass',
        ],
        {
          xdgConfigHome: configDir.xdgHome,
          env: { MAINWP_APP_PASSWORD: 'test-pass' },
        },
      );

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('Embedded credentials');

      // Rejected at intake: nothing may reach the server
      expect(server.getRecordedRequests()).toHaveLength(0);

      const profiles = await configDir.readProfiles();
      expect(profiles.profiles).toHaveLength(0);
    },
  );

  // -------------------------------------------------------------------------
  // 5. URL normalization: protocol-less URL gets https:// prefix
  // -------------------------------------------------------------------------

  it('URL without protocol gets https:// prefix and fails connecting to http server', async () => {
    configDir = await ConfigDir.create({ profiles: [] });

    // Use a URL without protocol. The login command will prepend https://,
    // which means it won't connect to our http:// mock server and the
    // connection will fail.
    const result = await runCLI(
      [
        'login',
        '--url', `127.0.0.1:${server.port}`,
        '--username', 'admin',
        '--password', 'test-pass',
      ],
      {
        xdgConfigHome: configDir.xdgHome,
        env: { MAINWP_APP_PASSWORD: 'test-pass' },
      },
    );

    // Connection will fail because https:// can't reach our http server
    expect(result.exitCode).not.toBe(0);

    // The error should mention connection failure
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/failed|error|refused/i);

    // Verify no profile was stored (connection test failed)
    const profiles = await configDir.readProfiles();
    expect(profiles.profiles).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 5b. URL with explicit http:// protocol is stored as-is (trailing slash stripped)
  // -------------------------------------------------------------------------

  it('URL with explicit protocol stores correctly with trailing slash stripped', async () => {
    configDir = await ConfigDir.create({ profiles: [] });

    // Pass URL with trailing slash
    const result = await runCLI(
      [
        'login',
        '--url', `${server.baseUrl}/`,
        '--username', 'admin',
        '--password', 'test-pass',
      ],
      {
        xdgConfigHome: configDir.xdgHome,
        env: { MAINWP_APP_PASSWORD: 'test-pass' },
      },
    );

    expect(result.exitCode).toBe(0);

    const profiles = await configDir.readProfiles();
    const stored = profiles.profiles[0]!;
    // Trailing slash should be stripped
    expect(stored.dashboardUrl).toBe(server.baseUrl);
    expect(stored.dashboardUrl.endsWith('/')).toBe(false);
  });
});
