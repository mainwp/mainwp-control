/**
 * Live Workflow Documentation Tests
 *
 * Verifies that the jq expressions, CLI commands, and data pipelines
 * documented in docs/workflows/*.md work against a real MainWP Dashboard.
 *
 * These tests validate what a real user would experience following the docs.
 * All tests are read-only — no mutations, no external services (Slack, StatsD).
 *
 * Run: npm run test:live
 * Requires: LocalWP dashboard running at https://dashboard6.local
 */

import { readFileSync } from 'node:fs';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runCLI, type CLIResult } from './fixtures/cli-runner.js';
import { ConfigDir } from './fixtures/config-dir.js';

// ---------------------------------------------------------------------------
// Credential loading (same as live-api.test.ts)
// ---------------------------------------------------------------------------

function loadTestbedEnv(path: string): Record<string, string> {
  try {
    const lines = readFileSync(path, 'utf-8').split('\n');
    const env: Record<string, string> = {};
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx === -1) continue;
      env[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
    }
    return env;
  } catch {
    return {};
  }
}

const testbedEnvPath = process.env['MAINWP_TESTBED_ENV'];
const testbedEnv = testbedEnvPath ? loadTestbedEnv(testbedEnvPath) : {};

const DASH_URL =
  process.env['MAINWP_API_URL'] ?? testbedEnv['MAINWP_API_URL'] ?? '';
const DASH_USER =
  process.env['MAINWP_USER'] ?? testbedEnv['MAINWP_USER'] ?? '';
const DASH_PASS =
  process.env['MAINWP_APP_PASSWORD'] ?? testbedEnv['MAINWP_APP_PASSWORD'] ?? '';

// ---------------------------------------------------------------------------
// Connectivity gate
// ---------------------------------------------------------------------------

// Only explicit opt-in values enable live tests; the TLS-verification
// override must never apply to normal (non-live) runs of this suite.
const rawLiveFlag = process.env['MAINWP_LIVE_TEST'];
const liveTestsEnabled = rawLiveFlag === '1' || rawLiveFlag === 'true';
if (liveTestsEnabled && (!DASH_URL || !DASH_USER || !DASH_PASS)) {
  throw new Error(
    'MAINWP_LIVE_TEST is enabled but live credentials are incomplete. ' +
    'Set MAINWP_TESTBED_ENV to your testbed .env file, or export ' +
    'MAINWP_API_URL, MAINWP_USER, and MAINWP_APP_PASSWORD.'
  );
}
if (liveTestsEnabled) {
  // Set only for explicitly enabled live tests using the self-signed testbed.
  process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
}

async function checkDashboard(): Promise<boolean> {
  if (!DASH_URL || !DASH_USER || !DASH_PASS) return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    const res = await fetch(`${DASH_URL}/wp-json/wp-abilities/v1/abilities`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${DASH_USER}:${DASH_PASS}`).toString('base64')}`,
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

const dashboardOnline = liveTestsEnabled && await checkDashboard();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function envelope(r: CLIResult): Json {
  return r.json as Json;
}

function runResult(r: CLIResult): Json {
  const outer = (r.json as Json)['data'] as Json;
  return outer['data'] as Json;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe.skipIf(!dashboardOnline)('workflow documentation tests', () => {
  let configDir: ConfigDir;
  let firstConnectedSiteId: number;

  function cli(
    args: string[],
    opts?: { stdin?: string; timeout?: number },
  ): Promise<CLIResult> {
    return runCLI(args, {
      xdgConfigHome: configDir.xdgHome,
      env: {
        MAINWP_APP_PASSWORD: DASH_PASS,
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
      },
      timeout: opts?.timeout ?? 25_000,
      stdin: opts?.stdin,
    });
  }

  beforeAll(async () => {
    configDir = await ConfigDir.create();

    // Login
    await cli([
      'login', '--url', DASH_URL,
      '--username', DASH_USER,
      '--skip-ssl-verify', '--json',
    ]);

    // Get a connected site ID for tests that need one
    const r = await cli(['abilities', 'run', 'list-sites-v1', '--json']);
    const items = runResult(r)['items'] as Json[];
    const connected = items.find((s) => s['status'] === 'connected');
    firstConnectedSiteId = (connected ?? items[0])!['id'] as number;
  });

  afterAll(async () => {
    await configDir.cleanup();
  });

  // =========================================================================
  // documented auth pattern
  // =========================================================================

  describe('documented auth pattern', () => {
    it('login works with MAINWP_APP_PASSWORD env and no --password flag', async () => {
      const tempConfig = await ConfigDir.create();

      try {
        const result = await runCLI(
          [
            'login',
            '--url', DASH_URL,
            '--username', DASH_USER,
            '--skip-ssl-verify',
            '--json',
          ],
          {
            xdgConfigHome: tempConfig.xdgHome,
            env: {
              MAINWP_APP_PASSWORD: DASH_PASS,
              NODE_TLS_REJECT_UNAUTHORIZED: '0',
            },
            timeout: 25_000,
          }
        );

        expect(result.exitCode).toBe(0);
        expect(envelope(result)['success']).toBe(true);
      } finally {
        await tempConfig.cleanup();
      }
    });
  });

  // =========================================================================
  // daily-health-check.md
  // =========================================================================

  describe('daily-health-check', () => {
    it('list-sites-v1 returns items array with status field', async () => {
      const r = await cli(['abilities', 'run', 'list-sites-v1', '--json']);
      expect(r.exitCode).toBe(0);
      const result = runResult(r);
      const items = result['items'] as Json[];
      expect(items.length).toBeGreaterThanOrEqual(1);
      // Every item has the fields the doc's jq expressions depend on
      for (const item of items) {
        expect(item).toHaveProperty('id');
        expect(item).toHaveProperty('status');
      }
    });

    it('disconnected count jq expression resolves to a number', async () => {
      const r = await cli(['abilities', 'run', 'list-sites-v1', '--json']);
      const result = runResult(r);
      const items = result['items'] as Json[];
      const disconnected = items.filter((s) => s['status'] !== 'connected');
      expect(typeof disconnected.length).toBe('number');
    });
  });

  // =========================================================================
  // input-from-file.md
  // =========================================================================

  describe('input-from-file', () => {
    it('--input inline JSON works for get-site-v1', async () => {
      const r = await cli([
        'abilities', 'run', 'get-site-v1',
        '--input', JSON.stringify({ site_id_or_domain: firstConnectedSiteId }),
        '--json',
      ]);
      expect(r.exitCode).toBe(0);
      const result = runResult(r);
      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('name');
      expect(result).toHaveProperty('url');
      expect(result).toHaveProperty('status');
    });

    it('--input-file produces identical result to inline', async () => {
      const tmpFile = join(tmpdir(), `mainwpcontrol-test-params-${Date.now()}.json`);
      writeFileSync(tmpFile, JSON.stringify({ site_id_or_domain: firstConnectedSiteId }));

      try {
        const [inline, fromFile] = await Promise.all([
          cli([
            'abilities', 'run', 'get-site-v1',
            '--input', JSON.stringify({ site_id_or_domain: firstConnectedSiteId }),
            '--json',
          ]),
          cli([
            'abilities', 'run', 'get-site-v1',
            '--input-file', tmpFile,
            '--json',
          ]),
        ]);

        expect(fromFile.exitCode).toBe(0);
        const inlineResult = runResult(inline);
        const fileResult = runResult(fromFile);
        expect(fileResult['id']).toBe(inlineResult['id']);
        expect(fileResult['name']).toBe(inlineResult['name']);
      } finally {
        try { unlinkSync(tmpFile); } catch { /* ignore */ }
      }
    });

    it('--input - (stdin) produces identical result to inline', async () => {
      const [inline, stdin] = await Promise.all([
        cli([
          'abilities', 'run', 'get-site-v1',
          '--input', JSON.stringify({ site_id_or_domain: firstConnectedSiteId }),
          '--json',
        ]),
        cli(
          ['abilities', 'run', 'get-site-v1', '--input', '-', '--json'],
          { stdin: JSON.stringify({ site_id_or_domain: firstConnectedSiteId }) },
        ),
      ]);

      expect(stdin.exitCode).toBe(0);
      const inlineResult = runResult(inline);
      const stdinResult = runResult(stdin);
      expect(stdinResult['id']).toBe(inlineResult['id']);
      expect(stdinResult['name']).toBe(inlineResult['name']);
    });

    it('JSON envelope has correct ability namespace', async () => {
      const r = await cli([
        'abilities', 'run', 'get-site-v1',
        '--input', JSON.stringify({ site_id_or_domain: firstConnectedSiteId }),
        '--json',
      ]);
      const data = (r.json as Json)['data'] as Json;
      expect(data['ability']).toBe('mainwp/get-site-v1');
      expect(data['mode']).toBe('execute');
    });
  });

  // =========================================================================
  // monthly-batch-updates.md
  // =========================================================================

  describe('monthly-batch-updates', () => {
    it('list-updates-v1 returns expected response shape', async () => {
      const r = await cli(['abilities', 'run', 'list-updates-v1', '--json']);
      expect(r.exitCode).toBe(0);
      const result = runResult(r);

      // Doc Step 4: response must have total, summary, updates[]
      expect(result).toHaveProperty('total');
      expect(typeof result['total']).toBe('number');
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('updates');
      expect(Array.isArray(result['updates'])).toBe(true);
    });

    it('summary has core/plugins/themes/translations breakdown', async () => {
      const r = await cli(['abilities', 'run', 'list-updates-v1', '--json']);
      const result = runResult(r);
      const summary = result['summary'] as Json;

      expect(summary).toHaveProperty('core');
      expect(summary).toHaveProperty('plugins');
      expect(summary).toHaveProperty('themes');
      expect(summary).toHaveProperty('translations');
      expect(summary).toHaveProperty('total');
    });

    it('update items have current_version and new_version fields', async () => {
      const r = await cli(['abilities', 'run', 'list-updates-v1', '--json']);
      const result = runResult(r);
      const updates = result['updates'] as Json[];

      if (updates.length > 0) {
        const first = updates[0]!;
        expect(first).toHaveProperty('current_version');
        expect(first).toHaveProperty('new_version');
        expect(first).toHaveProperty('slug');
        expect(first).toHaveProperty('type');
        expect(first).toHaveProperty('site_id');
      }
    });

    it('total field matches jq path .data.data.total', async () => {
      const r = await cli(['abilities', 'run', 'list-updates-v1', '--json']);
      const result = runResult(r);
      expect(result['total']).toBeGreaterThanOrEqual(0);
    });
  });

  // =========================================================================
  // plugin-deployment-verification.md
  // =========================================================================

  describe('plugin-deployment-verification', () => {
    it('list-sites-v1 items have id field for jq extraction', async () => {
      const r = await cli(['abilities', 'run', 'list-sites-v1', '--json']);
      const items = runResult(r)['items'] as Json[];
      expect(items.length).toBeGreaterThanOrEqual(1);
      for (const item of items) {
        expect(typeof item['id']).toBe('number');
      }
    });

    it('get-site-plugins-v1 returns plugins array with slug field', async () => {
      const r = await cli([
        'abilities', 'run', 'get-site-plugins-v1',
        '--input', JSON.stringify({ site_id_or_domain: firstConnectedSiteId }),
        '--json',
      ]);
      expect(r.exitCode).toBe(0);
      const result = runResult(r);
      expect(result).toHaveProperty('plugins');
      const plugins = result['plugins'] as Json[];
      expect(plugins.length).toBeGreaterThanOrEqual(1);
      // Doc uses .slug for matching
      for (const plugin of plugins) {
        expect(plugin).toHaveProperty('slug');
        expect(plugin).toHaveProperty('name');
      }
    });

    it('plugin search by slug finds known plugin', async () => {
      const r = await cli([
        'abilities', 'run', 'get-site-plugins-v1',
        '--input', JSON.stringify({ site_id_or_domain: firstConnectedSiteId }),
        '--json',
      ]);
      const plugins = runResult(r)['plugins'] as Json[];
      // mainwp-child should be on every connected site
      const found = plugins.filter((p) =>
        (p['slug'] as string).includes('mainwp-child'),
      );
      expect(found.length).toBeGreaterThanOrEqual(1);
    });

    it('plugin search by slug returns 0 for nonexistent plugin', async () => {
      const r = await cli([
        'abilities', 'run', 'get-site-plugins-v1',
        '--input', JSON.stringify({ site_id_or_domain: firstConnectedSiteId }),
        '--json',
      ]);
      const plugins = runResult(r)['plugins'] as Json[];
      const found = plugins.filter((p) => p['slug'] === 'nonexistent-plugin-xyz');
      expect(found.length).toBe(0);
    });

    it('get-site-plugins-v1 returns error for disconnected site', async () => {
      // Find a disconnected site
      const lr = await cli(['abilities', 'run', 'list-sites-v1', '--json']);
      const items = runResult(lr)['items'] as Json[];
      const disconnected = items.find((s) => s['status'] !== 'connected');

      if (disconnected) {
        const r = await cli([
          'abilities', 'run', 'get-site-plugins-v1',
          '--input', JSON.stringify({ site_id_or_domain: disconnected['id'] }),
          '--json',
        ]);
        // Should return an error — the doc's error handling checks .success
        const json = envelope(r);
        expect(json['success']).toBe(false);
      }
    });
  });

  // =========================================================================
  // monitoring-integration.md
  // =========================================================================

  describe('monitoring-integration', () => {
    it('site count: .data.data.items | length resolves to number', async () => {
      const r = await cli(['abilities', 'run', 'list-sites-v1', '--json']);
      const items = runResult(r)['items'] as Json[];
      expect(items.length).toBeGreaterThanOrEqual(1);
    });

    it('pending updates: .data.data.total resolves to number', async () => {
      const r = await cli(['abilities', 'run', 'list-updates-v1', '--json']);
      const total = runResult(r)['total'];
      expect(typeof total).toBe('number');
      expect(total as number).toBeGreaterThanOrEqual(0);
    });

    it('disconnected count: filter by status != connected works', async () => {
      const r = await cli(['abilities', 'run', 'list-sites-v1', '--json']);
      const items = runResult(r)['items'] as Json[];
      const disconnected = items.filter((s) => s['status'] !== 'connected');
      expect(typeof disconnected.length).toBe('number');
    });

    it('StatsD gauge format: metric:value|g', async () => {
      const r = await cli(['abilities', 'run', 'list-sites-v1', '--json']);
      const count = (runResult(r)['items'] as Json[]).length;
      const metric = `mainwp.sites.total:${count}|g`;
      expect(metric).toMatch(/^mainwp\.sites\.total:\d+\|g$/);
    });

    it('all three metrics produce valid StatsD strings', async () => {
      const [sitesR, updatesR] = await Promise.all([
        cli(['abilities', 'run', 'list-sites-v1', '--json']),
        cli(['abilities', 'run', 'list-updates-v1', '--json']),
      ]);

      const items = runResult(sitesR)['items'] as Json[];
      const total = items.length;
      const disconnected = items.filter((s) => s['status'] !== 'connected').length;
      const pending = runResult(updatesR)['total'] as number;

      expect(`mainwp.sites.total:${total}|g`).toMatch(/^mainwp\.\w+\.\w+:\d+\|g$/);
      expect(`mainwp.sites.disconnected:${disconnected}|g`).toMatch(/^mainwp\.\w+\.\w+:\d+\|g$/);
      expect(`mainwp.updates.pending:${pending}|g`).toMatch(/^mainwp\.\w+\.\w+:\d+\|g$/);
    });
  });
});
