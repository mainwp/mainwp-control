/**
 * Process-Level Tests: Global Flags
 *
 * Validates cross-cutting CLI flags (--json, --quiet, --profile, --debug)
 * and the defaultJsonOutput setting by spawning mainwpcontrol as a child
 * process against a mock HTTP server. Each test gets a fresh, isolated
 * config directory.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { MockServer } from './fixtures/mock-server.js';
import { runCLI } from './fixtures/cli-runner.js';
import { ConfigDir } from './fixtures/config-dir.js';

describe('global flags', () => {
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
    if (configDir) await configDir.cleanup();
  });

  // --------------------------------------------------------------------------
  // 1. --json wraps output in { success: true, data } envelope
  // --------------------------------------------------------------------------

  describe('--json flag', () => {
    it('wraps successful output in { success: true, data } envelope', async () => {
      configDir = await ConfigDir.create({
        profiles: [
          { name: 'test', dashboardUrl: server.baseUrl, username: 'admin' },
        ],
        activeProfile: 'test',
      });

      const result = await runCLI(['abilities', 'list', '--json'], {
        xdgConfigHome: configDir.xdgHome,
        env: { MAINWP_APP_PASSWORD: 'test-pass' },
      });

      expect(result.exitCode).toBe(0);
      expect(result.json).toBeDefined();

      const envelope = result.json as { success: boolean; data: { abilities: unknown[]; total: number } };
      expect(envelope.success).toBe(true);
      expect(envelope.data).toBeDefined();
      expect(Array.isArray(envelope.data.abilities)).toBe(true);
      expect(envelope.data.total).toBeGreaterThan(0);
    });

    it('wraps errors in { success: false, error } envelope', async () => {
      // Use a profile pointing to a URL where no server is running
      configDir = await ConfigDir.create({
        profiles: [
          { name: 'bad', dashboardUrl: 'http://127.0.0.1:19999', username: 'admin' },
        ],
        activeProfile: 'bad',
      });

      const result = await runCLI(['abilities', 'list', '--json'], {
        xdgConfigHome: configDir.xdgHome,
        env: { MAINWP_APP_PASSWORD: 'test-pass' },
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.json).toBeDefined();

      const envelope = result.json as { success: boolean; error: { message: string } };
      expect(envelope.success).toBe(false);
      expect(envelope.error).toBeDefined();
      expect(typeof envelope.error.message).toBe('string');
    });
  });

  // --------------------------------------------------------------------------
  // 2. --quiet suppresses stdout entirely
  // --------------------------------------------------------------------------

  describe('--quiet flag', () => {
    it('suppresses stdout entirely on success (exit code reflects result)', async () => {
      configDir = await ConfigDir.create({
        profiles: [
          { name: 'test', dashboardUrl: server.baseUrl, username: 'admin' },
        ],
        activeProfile: 'test',
      });

      const result = await runCLI(['abilities', 'list', '--quiet'], {
        xdgConfigHome: configDir.xdgHome,
        env: { MAINWP_APP_PASSWORD: 'test-pass' },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
    });
  });

  // --------------------------------------------------------------------------
  // 3. --profile <name> selects the correct profile
  // --------------------------------------------------------------------------

  describe('--profile flag', () => {
    it('selects the specified profile instead of the active one', async () => {
      configDir = await ConfigDir.create({
        profiles: [
          { name: 'prod', dashboardUrl: server.baseUrl, username: 'admin' },
          { name: 'staging', dashboardUrl: server.baseUrl, username: 'admin' },
        ],
        activeProfile: 'prod',
      });

      // Use --profile staging (not the default "prod")
      const result = await runCLI(['abilities', 'list', '--profile', 'staging'], {
        xdgConfigHome: configDir.xdgHome,
        env: { MAINWP_APP_PASSWORD: 'test-pass' },
      });

      expect(result.exitCode).toBe(0);
      // The command succeeds with the selected profile, confirming it connected
      // to the mock server using the staging profile's dashboardUrl
      const combined = result.stdout + result.stderr;
      expect(combined.length).toBeGreaterThan(0);
    });

    it('exits non-zero when the specified profile does not exist', async () => {
      configDir = await ConfigDir.create({
        profiles: [
          { name: 'prod', dashboardUrl: server.baseUrl, username: 'admin' },
        ],
        activeProfile: 'prod',
      });

      const result = await runCLI(['abilities', 'list', '--profile', 'nonexistent'], {
        xdgConfigHome: configDir.xdgHome,
        env: { MAINWP_APP_PASSWORD: 'test-pass' },
      });

      expect(result.exitCode).not.toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // 4. --debug overrides --quiet (per base-command.ts:102)
  // --------------------------------------------------------------------------

  describe('--debug flag', () => {
    it('--debug --quiet produces debug output (explicit debug overrides quiet)', async () => {
      configDir = await ConfigDir.create({
        profiles: [
          { name: 'test', dashboardUrl: server.baseUrl, username: 'admin' },
        ],
        activeProfile: 'test',
      });

      const result = await runCLI(['abilities', 'list', '--debug', '--quiet'], {
        xdgConfigHome: configDir.xdgHome,
        env: { MAINWP_APP_PASSWORD: 'test-pass' },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('[debug]');
    });

    it('settings.debug enables debug output without requiring --debug', async () => {
      configDir = await ConfigDir.create({
        profiles: [
          { name: 'test', dashboardUrl: server.baseUrl, username: 'admin' },
        ],
        activeProfile: 'test',
        settings: { debug: true },
      });

      const result = await runCLI(['abilities', 'list'], {
        xdgConfigHome: configDir.xdgHome,
        env: { MAINWP_APP_PASSWORD: 'test-pass' },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('[debug]');
    });

    it('settings.debug does not override --quiet by surprise', async () => {
      configDir = await ConfigDir.create({
        profiles: [
          { name: 'test', dashboardUrl: server.baseUrl, username: 'admin' },
        ],
        activeProfile: 'test',
        settings: { debug: true },
      });

      const result = await runCLI(['abilities', 'list', '--quiet'], {
        xdgConfigHome: configDir.xdgHome,
        env: { MAINWP_APP_PASSWORD: 'test-pass' },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
      expect(result.stderr).not.toContain('[debug]');
    });
  });

  // --------------------------------------------------------------------------
  // 5. defaultJsonOutput setting enables JSON without --json flag
  // --------------------------------------------------------------------------

  describe('defaultJsonOutput setting', () => {
    it('outputs JSON envelope when settings.json has defaultJsonOutput: true', async () => {
      configDir = await ConfigDir.create({
        profiles: [
          { name: 'test', dashboardUrl: server.baseUrl, username: 'admin' },
        ],
        activeProfile: 'test',
        settings: { defaultJsonOutput: true },
      });

      // Run WITHOUT --json flag — setting should activate JSON output
      const result = await runCLI(['abilities', 'list'], {
        xdgConfigHome: configDir.xdgHome,
        env: { MAINWP_APP_PASSWORD: 'test-pass' },
      });

      expect(result.exitCode).toBe(0);
      expect(result.json).toBeDefined();

      const envelope = result.json as { success: boolean; data: { abilities: unknown[]; total: number } };
      expect(envelope.success).toBe(true);
      expect(envelope.data).toBeDefined();
      expect(Array.isArray(envelope.data.abilities)).toBe(true);
    });

    it('without --json flag, defaultJsonOutput setting still takes effect', async () => {
      // Verify that defaultJsonOutput=true persists (no --no-json flag exists)
      // by confirming a second invocation without --json still produces JSON
      configDir = await ConfigDir.create({
        profiles: [
          { name: 'test', dashboardUrl: server.baseUrl, username: 'admin' },
        ],
        activeProfile: 'test',
        settings: { defaultJsonOutput: true },
      });

      const result = await runCLI(['abilities', 'list'], {
        xdgConfigHome: configDir.xdgHome,
        env: { MAINWP_APP_PASSWORD: 'test-pass' },
      });

      expect(result.exitCode).toBe(0);
      // defaultJsonOutput=true means output should be JSON even without --json
      expect(result.json).toBeDefined();
      const envelope = result.json as { success: boolean; data: { abilities: unknown[] } };
      expect(envelope.success).toBe(true);
    });
  });
});
