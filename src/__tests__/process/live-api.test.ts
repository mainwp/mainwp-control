/**
 * Live Integration Tests for mainwpcontrol
 *
 * Exercises the CLI against a real MainWP Dashboard (local testbed).
 * All destructive abilities use --dry-run only — never executes mutations.
 *
 * Run: npm run test:live
 * Requires: LocalWP dashboard running at https://dashboard6.local
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runCLI, type CLIResult } from './fixtures/cli-runner.js';
import { ConfigDir } from './fixtures/config-dir.js';

// ---------------------------------------------------------------------------
// Credential loading
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

const testbedEnv = loadTestbedEnv(
  '/Users/denni1/github/dev-tools/network-testbed/.env',
);

const DASH_URL =
  process.env['MAINWP_API_URL'] ?? testbedEnv['MAINWP_API_URL'] ?? '';
const DASH_USER =
  process.env['MAINWP_USER'] ?? testbedEnv['MAINWP_USER'] ?? '';
const DASH_PASS =
  process.env['MAINWP_APP_PASSWORD'] ?? testbedEnv['MAINWP_APP_PASSWORD'] ?? '';

// ---------------------------------------------------------------------------
// Connectivity gate
// ---------------------------------------------------------------------------

async function checkDashboard(
  url: string,
  user: string,
  pass: string,
): Promise<boolean> {
  if (!url || !user || !pass) return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    const res = await fetch(`${url}/wp-json/wp-abilities/v1/abilities`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`,
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

// Set for the connectivity check (self-signed cert)
process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

const dashboardOnline = await checkDashboard(DASH_URL, DASH_USER, DASH_PASS);

// ---------------------------------------------------------------------------
// Helpers — typed access to CLI JSON output
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

/** Navigate the CLI JSON envelope: { success, data: { ... } } */
function envelope(r: CLIResult): Json {
  return r.json as Json;
}

/** Get the data field from the CLI JSON envelope */
function envelopeData(r: CLIResult): Json {
  return (r.json as Json)['data'] as Json;
}

/** For ability run commands, the actual API result is nested: data.data */
function runResult(r: CLIResult): Json {
  const outer = envelopeData(r);
  return outer['data'] as Json;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe.skipIf(!dashboardOnline)('live integration tests', () => {
  let configDir: ConfigDir;
  let firstSiteId: number;

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
  });

  afterAll(async () => {
    await configDir.cleanup();
  });

  // ── Group 1: Smoke ──────────────────────────────────────────────────────

  it('smoke: --help exits 0', async () => {
    const r = await cli(['--help']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('mainwpcontrol');
  });

  // ── Group 2: Login ──────────────────────────────────────────────────────

  it('login with real credentials', async () => {
    const r = await cli([
      'login',
      '--url', DASH_URL,
      '--username', DASH_USER,
      '--password', DASH_PASS,
      '--skip-ssl-verify',
      '--json',
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.json).toMatchObject({ success: true });
  });

  // ── Group 3: Doctor ─────────────────────────────────────────────────────

  it('doctor passes critical checks', async () => {
    const r = await cli(['doctor', '--json']);
    expect(r.exitCode).toBe(0);
    const data = envelopeData(r);
    expect(data['summary']).toMatchObject({ failed: 0 });
  });

  // ── Group 4: Profile & Config ───────────────────────────────────────────

  it('profile list shows logged-in profile', async () => {
    const r = await cli(['profile', 'list', '--json']);
    expect(r.exitCode).toBe(0);
    const data = envelopeData(r);
    const profiles = data['profiles'] as unknown[];
    expect(profiles.length).toBeGreaterThanOrEqual(1);
  });

  it('config show includes dashboard URL', async () => {
    const r = await cli(['config', 'show', '--json']);
    expect(r.exitCode).toBe(0);
    expect(envelope(r)['success']).toBe(true);
    expect(JSON.stringify(r.json)).toContain('dashboard6.local');
  });

  // ── Group 5: Abilities Discovery ────────────────────────────────────────

  it('abilities list returns 60+ abilities', async () => {
    const r = await cli(['abilities', 'list', '--json']);
    expect(r.exitCode).toBe(0);
    const data = envelopeData(r);
    const abilities = data['abilities'] as unknown[];
    expect(abilities.length).toBeGreaterThanOrEqual(60);
  });

  it('abilities info shows schema for list-sites-v1', async () => {
    const r = await cli(['abilities', 'info', 'list-sites-v1', '--json']);
    expect(r.exitCode).toBe(0);
    const data = envelopeData(r);
    expect(data).toHaveProperty('name');
    expect(data).toHaveProperty('inputSchema');
  });

  // ── Group 6: Read-Only Execution ────────────────────────────────────────

  it('run list-sites-v1 returns sites', async () => {
    const r = await cli(['abilities', 'run', 'list-sites-v1', '--json']);
    expect(r.exitCode).toBe(0);
    expect(envelope(r)['success']).toBe(true);
    const result = runResult(r);
    const items = result['items'] as Array<Json>;
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(result).toHaveProperty('total');
    // Prefer a connected site (more likely to pass server-side output validation)
    const connected = items.find((s) => s['status'] === 'connected');
    firstSiteId = (connected ?? items[0])['id'] as number;
    expect(firstSiteId).toBeGreaterThan(0);
  });

  it('run count-sites-v1 returns total', async () => {
    const r = await cli(['abilities', 'run', 'count-sites-v1', '--json']);
    expect(r.exitCode).toBe(0);
    const result = runResult(r);
    expect(typeof result['total']).toBe('number');
    expect(result['total'] as number).toBeGreaterThanOrEqual(1);
  });

  it('run get-site-v1 returns site details', async () => {
    const r = await cli([
      'abilities', 'run', 'get-site-v1',
      '--input', JSON.stringify({ site_id_or_domain: firstSiteId }),
      '--json',
    ]);
    expect(r.exitCode).toBe(0);
    const result = runResult(r);
    expect(result).toHaveProperty('id');
    expect(result).toHaveProperty('url');
    expect(result).toHaveProperty('name');
    expect(result).toHaveProperty('status');
  });

  // ── Group 7: Destructive Safety — Dry-Run ──────────────────────────────

  it('dry-run delete-site-v1 previews without executing', async () => {
    const r = await cli([
      'abilities', 'run', 'delete-site-v1',
      '--input', JSON.stringify({ site_id_or_domain: firstSiteId }),
      '--dry-run',
      '--json',
    ]);
    expect(r.exitCode).toBe(0);
    expect(envelope(r)['success']).toBe(true);
    const result = runResult(r);
    expect(result['dry_run']).toBe(true);
    expect(result).toHaveProperty('would_affect');
  });

  // ── Group 8: Destructive Rejection ──────────────────────────────────────

  it('destructive without flags is rejected', async () => {
    const r = await cli([
      'abilities', 'run', 'delete-site-v1',
      '--input', JSON.stringify({ site_id_or_domain: firstSiteId }),
      '--json',
    ]);
    // Safety controller rejects: requires --dry-run or --confirm
    expect(r.exitCode).toBeGreaterThan(0);
    const json = envelope(r);
    expect(json['success']).toBe(false);
    const error = json['error'] as Json;
    expect(error['code']).toBe('CONFIRMATION_REQUIRED');
  });

  it('destructive with --confirm in non-TTY requires --force', async () => {
    const r = await cli([
      'abilities', 'run', 'delete-site-v1',
      '--input', JSON.stringify({ site_id_or_domain: firstSiteId }),
      '--confirm',
      '--json',
    ]);
    expect(r.exitCode).toBe(1);
    const output = (r.stdout + r.stderr).toLowerCase();
    expect(output).toContain('force');
  });

  // ── Group 9: Output Contract ────────────────────────────────────────────

  it('JSON envelope has correct CLIOutput shape', async () => {
    const r = await cli(['abilities', 'list', '--json']);
    expect(r.json).toBeDefined();
    const json = envelope(r);
    expect(typeof json['success']).toBe('boolean');
    expect(json['success']).toBe(true);
    expect(json).toHaveProperty('data');
  });

  // ── Group 10: Exit Code — Auth Error ────────────────────────────────────

  it('bad credentials produce exit code 2', async () => {
    const badConfigDir = await ConfigDir.create({
      profiles: [{
        name: 'bad-auth',
        dashboardUrl: DASH_URL,
        username: DASH_USER,
        skipSSLVerification: true,
      }],
      activeProfile: 'bad-auth',
    });

    try {
      const r = await runCLI(['abilities', 'list', '--json'], {
        xdgConfigHome: badConfigDir.xdgHome,
        env: {
          MAINWP_APP_PASSWORD: 'wrong-password',
          NODE_TLS_REJECT_UNAUTHORIZED: '0',
        },
        timeout: 25_000,
      });
      expect(r.exitCode).toBe(2);
    } finally {
      await badConfigDir.cleanup();
    }
  });

  // ── Group 11: Input via Stdin ───────────────────────────────────────────

  it('stdin input works for get-site-v1', async () => {
    const r = await cli(
      ['abilities', 'run', 'get-site-v1', '--input', '-', '--json'],
      { stdin: JSON.stringify({ site_id_or_domain: firstSiteId }) },
    );
    expect(r.exitCode).toBe(0);
    const result = runResult(r);
    expect(result['id']).toBe(firstSiteId);
  });
});
