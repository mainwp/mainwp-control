/**
 * Process-Level Tests: Profile Commands
 *
 * Spawns `node bin/run.js profile list|use` as child processes with
 * isolated config directories. Validates exit codes, stdout content,
 * JSON envelope structure, and on-disk profile state changes.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { MockServer } from './fixtures/mock-server.js';
import { runCLI } from './fixtures/cli-runner.js';
import { ConfigDir } from './fixtures/config-dir.js';

describe('profile commands', () => {
  const server = new MockServer();
  let configDir: ConfigDir;

  beforeAll(async () => {
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(async () => {
    server.reset();
    configDir = await ConfigDir.create({
      profiles: [
        { name: 'prod', dashboardUrl: `http://127.0.0.1:${server.port}`, username: 'admin' },
        { name: 'staging', dashboardUrl: `http://127.0.0.1:${server.port}`, username: 'admin' },
      ],
      activeProfile: 'prod',
    });
  });

  afterEach(async () => {
    if (configDir) await configDir.cleanup();
  });

  // --------------------------------------------------------------------------
  // profile list
  // --------------------------------------------------------------------------

  describe('profile list', () => {
    it('exits 0 and lists both profile names', async () => {
      const result = await runCLI(['profile', 'list'], {
        xdgConfigHome: configDir.xdgHome,
        env: { MAINWP_APP_PASSWORD: 'test-pass' },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('prod');
      expect(result.stdout).toContain('staging');
    });

    it('exits 0 and returns valid JSON with profiles array when --json is passed', async () => {
      const result = await runCLI(['profile', 'list', '--json'], {
        xdgConfigHome: configDir.xdgHome,
        env: { MAINWP_APP_PASSWORD: 'test-pass' },
      });

      expect(result.exitCode).toBe(0);
      expect(result.json).toBeDefined();

      const envelope = result.json as { success: boolean; data: { profiles: { name: string }[] } };
      expect(envelope.success).toBe(true);
      expect(Array.isArray(envelope.data.profiles)).toBe(true);
      expect(envelope.data.profiles.length).toBe(2);

      const names = envelope.data.profiles.map((p) => p.name);
      expect(names).toContain('prod');
      expect(names).toContain('staging');
    });
  });

  // --------------------------------------------------------------------------
  // profile use
  // --------------------------------------------------------------------------

  describe('profile use', () => {
    it('exits 0 and switches the active profile on disk', async () => {
      const result = await runCLI(['profile', 'use', 'staging'], {
        xdgConfigHome: configDir.xdgHome,
        env: { MAINWP_APP_PASSWORD: 'test-pass' },
      });

      expect(result.exitCode).toBe(0);

      // Verify on-disk state reflects the switch
      const profiles = await configDir.readProfiles();
      expect(profiles.activeProfile).toBe('staging');
    });

    it('exits non-zero when the target profile does not exist', async () => {
      const result = await runCLI(['profile', 'use', 'nonexistent'], {
        xdgConfigHome: configDir.xdgHome,
        env: { MAINWP_APP_PASSWORD: 'test-pass' },
      });

      expect(result.exitCode).not.toBe(0);
    });
  });
});
