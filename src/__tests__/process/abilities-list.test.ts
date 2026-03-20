/**
 * Process-level tests for the `abilities list` command
 *
 * Verifies that `mainwpctl abilities list` correctly fetches and displays
 * abilities from the Dashboard API. Each test runs mainwpctl as a child
 * process against a mock HTTP server with an isolated config directory.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { MockServer } from './fixtures/mock-server.js';
import { runCLI } from './fixtures/cli-runner.js';
import { ConfigDir } from './fixtures/config-dir.js';
import { STANDARD_ABILITIES } from './fixtures/api-responses.js';

describe('abilities list command', () => {
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
    server.setAbilities(STANDARD_ABILITIES);
  });

  afterEach(async () => {
    if (configDir) {
      await configDir.cleanup();
    }
  });

  // ---------------------------------------------------------------------------
  // 1. Human-readable output: exit 0, stdout contains ability names
  // ---------------------------------------------------------------------------

  it('abilities list exits 0 and shows ability names', async () => {
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

    const result = await runCLI(['abilities', 'list'], {
      xdgConfigHome: configDir.xdgHome,
      env: { MAINWP_APP_PASSWORD: 'test-pass' },
    });

    expect(result.exitCode).toBe(0);

    const output = result.stdout;

    // Verify known ability names appear in the output
    expect(output).toContain('list-sites-v1');
    expect(output).toContain('get-site-v1');
    expect(output).toContain('delete-site-v1');
    expect(output).toContain('sync-sites-v1');
    expect(output).toContain('run-updates-v1');
    expect(output).toContain('list-updates-v1');
    expect(output).toContain('get-site-plugins-v1');
  });

  // ---------------------------------------------------------------------------
  // 2. JSON output: exit 0, valid JSON with abilities envelope
  // ---------------------------------------------------------------------------

  it('abilities list --json exits 0 with valid JSON envelope', async () => {
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

    const result = await runCLI(['abilities', 'list', '--json'], {
      xdgConfigHome: configDir.xdgHome,
      env: { MAINWP_APP_PASSWORD: 'test-pass' },
    });

    expect(result.exitCode).toBe(0);
    expect(result.json).toBeDefined();

    const envelope = result.json as {
      success: boolean;
      data: {
        abilities: Array<{
          name: string;
          label: string;
          category: string;
          readonly: boolean;
          destructive: boolean;
        }>;
        total: number;
        categories: string[];
      };
    };

    // Verify envelope structure
    expect(envelope.success).toBe(true);
    expect(envelope.data).toBeDefined();

    // Verify abilities array
    expect(Array.isArray(envelope.data.abilities)).toBe(true);
    expect(envelope.data.abilities.length).toBe(STANDARD_ABILITIES.length);

    // Verify total matches ability count
    expect(envelope.data.total).toBe(STANDARD_ABILITIES.length);

    // Verify categories are present and sorted
    expect(Array.isArray(envelope.data.categories)).toBe(true);
    expect(envelope.data.categories.length).toBeGreaterThan(0);
    // Standard abilities span sites, updates, plugins, system categories
    expect(envelope.data.categories).toContain('sites');
    expect(envelope.data.categories).toContain('updates');
    expect(envelope.data.categories).toContain('plugins');

    // Verify individual ability shape
    const listSites = envelope.data.abilities.find(
      (a) => a.name === 'mainwp/list-sites-v1',
    );
    expect(listSites).toBeDefined();
    expect(listSites!.category).toBe('sites');
    expect(listSites!.readonly).toBe(true);
    expect(listSites!.destructive).toBe(false);

    // Verify destructive ability is flagged correctly
    const deleteSite = envelope.data.abilities.find(
      (a) => a.name === 'mainwp/delete-site-v1',
    );
    expect(deleteSite).toBeDefined();
    expect(deleteSite!.destructive).toBe(true);
    expect(deleteSite!.readonly).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // 3. Category filter: --category narrows results
  // ---------------------------------------------------------------------------

  it('abilities list --category filters to matching category', async () => {
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

    const result = await runCLI(
      ['abilities', 'list', '--category', 'updates', '--json'],
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
        abilities: Array<{ name: string; category: string }>;
        total: number;
        categories: string[];
      };
    };

    expect(envelope.success).toBe(true);

    // Only "updates" abilities should be included
    expect(envelope.data.abilities.length).toBe(2); // run-updates-v1, list-updates-v1
    for (const ability of envelope.data.abilities) {
      expect(ability.category).toBe('updates');
    }
    expect(envelope.data.total).toBe(2);
    expect(envelope.data.categories).toEqual(['updates']);
  });

  // ---------------------------------------------------------------------------
  // 4. No profile configured: exit 2 (auth/config error)
  // ---------------------------------------------------------------------------

  it('abilities list without profile exits 2', async () => {
    configDir = await ConfigDir.create({ profiles: [] });

    const result = await runCLI(['abilities', 'list'], {
      xdgConfigHome: configDir.xdgHome,
    });

    expect(result.exitCode).toBe(2);
  });
});
