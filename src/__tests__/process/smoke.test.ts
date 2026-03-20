import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { MockServer } from './fixtures/mock-server.js';
import { runCLI } from './fixtures/cli-runner.js';
import { ConfigDir } from './fixtures/config-dir.js';

describe('smoke tests', () => {
  const server = new MockServer();
  let configWithProfile: ConfigDir;
  let configWithoutProfile: ConfigDir;

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
    if (configWithProfile) await configWithProfile.cleanup();
    if (configWithoutProfile) await configWithoutProfile.cleanup();
  });

  it('mainwpctl --help exits 0 and shows usage info', async () => {
    // --help does not require a profile, so an empty config dir is fine
    configWithoutProfile = await ConfigDir.create({ profiles: [] });

    const result = await runCLI(['--help'], {
      xdgConfigHome: configWithoutProfile.xdgHome,
    });

    expect(result.exitCode).toBe(0);
    const combined = result.stdout + result.stderr;
    const hasUsageInfo =
      /usage/i.test(combined) ||
      /commands/i.test(combined) ||
      /mainwpctl/i.test(combined);
    expect(hasUsageInfo).toBe(true);
  });

  it('mainwpctl abilities --help exits 0', async () => {
    configWithoutProfile = await ConfigDir.create({ profiles: [] });

    const result = await runCLI(['abilities', '--help'], {
      xdgConfigHome: configWithoutProfile.xdgHome,
    });

    expect(result.exitCode).toBe(0);
  });

  it('mainwpctl nonexistent exits non-zero with error on stderr', async () => {
    configWithoutProfile = await ConfigDir.create({ profiles: [] });

    const result = await runCLI(['nonexistent'], {
      xdgConfigHome: configWithoutProfile.xdgHome,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it('bare mainwpctl in non-TTY shows help and exits 0', async () => {
    // When no command is provided, oclif shows the top-level help and exits 0
    // (the default "chat" command is not invoked for bare invocation)
    configWithProfile = await ConfigDir.create({
      profiles: [
        {
          name: 'test',
          dashboardUrl: server.baseUrl,
          username: 'admin',
        },
      ],
      activeProfile: 'test',
    });

    const result = await runCLI([], {
      xdgConfigHome: configWithProfile.xdgHome,
      env: {
        MAINWP_APP_PASSWORD: 'test-pass',
      },
    });

    expect(result.exitCode).toBe(0);
    const combined = result.stdout + result.stderr;
    // Should show help with commands list
    expect(combined).toMatch(/commands/i);
  });

  it('bare mainwpctl in non-TTY without profile also shows help and exits 0', async () => {
    // Even without a profile, bare invocation shows help (no command runs)
    configWithoutProfile = await ConfigDir.create({ profiles: [] });

    const result = await runCLI([], {
      xdgConfigHome: configWithoutProfile.xdgHome,
    });

    expect(result.exitCode).toBe(0);
  });

  it('mainwpctl "some message" exits 2 with command-not-found error', async () => {
    // oclif treats the argument as a command name lookup, not as a chat message arg.
    // Since there is no command called "some message", oclif exits with a command-not-found error.
    configWithProfile = await ConfigDir.create({
      profiles: [
        {
          name: 'test',
          dashboardUrl: server.baseUrl,
          username: 'admin',
        },
      ],
      activeProfile: 'test',
    });

    const result = await runCLI(['some message'], {
      xdgConfigHome: configWithProfile.xdgHome,
      env: {
        MAINWP_APP_PASSWORD: 'test-pass',
      },
    });

    expect(result.exitCode).toBe(2);
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/not found/i);
  });
});
