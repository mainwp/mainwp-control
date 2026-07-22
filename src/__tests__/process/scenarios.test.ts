/**
 * Process-level multi-step scenario tests
 *
 * Tests realistic multi-command workflows by spawning mainwpcontrol as a child
 * process against a mock HTTP server. Each scenario simulates a real user
 * session: login, then run a sequence of abilities, verifying data flows
 * correctly between steps.
 *
 * INVARIANTS TESTED:
 * - Login creates a profile that subsequent commands can use
 * - JSON envelope structure is consistent across commands
 * - Data shapes match what jq extraction would produce
 * - Batch job lifecycle: dry-run → confirm → wait → completion
 * - All three input methods (--input, --input-file, --input -) produce equivalent results
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MockServer } from './fixtures/mock-server.js';
import { runCLI, type CLIResult } from './fixtures/cli-runner.js';
import { ConfigDir } from './fixtures/config-dir.js';
import {
  STANDARD_ABILITIES,
  abilityRunSuccess,
  abilityDryRunResponse,
  dashboardQueuedResponse,
  jobStatus,
} from './fixtures/api-responses.js';

// =============================================================================
// Shared Helpers
// =============================================================================

/** Login via CLI and return the result. */
async function loginCLI(
  server: MockServer,
  config: ConfigDir,
): Promise<CLIResult> {
  return runCLI(
    ['login', '--url', server.baseUrl, '--username', 'admin', '--password', 'test-pass'],
    {
      xdgConfigHome: config.xdgHome,
      env: { MAINWP_APP_PASSWORD: 'test-pass' },
    },
  );
}

/** Run a CLI command against a logged-in profile. */
function runWithProfile(
  args: string[],
  config: ConfigDir,
  extra?: { stdin?: string; env?: Record<string, string> },
): Promise<CLIResult> {
  return runCLI(args, {
    xdgConfigHome: config.xdgHome,
    env: {
      MAINWP_APP_PASSWORD: 'test-pass',
      ...extra?.env,
    },
    stdin: extra?.stdin,
  });
}

// =============================================================================
// 1. Health Check Scenario
// =============================================================================

describe('Scenario: Health Check', () => {
  const server = new MockServer();
  let config: ConfigDir;

  const sitesPayload = {
    sites: [
      { id: 1, name: 'Alpha', url: 'https://alpha.example.com', status: 'connected' },
      { id: 2, name: 'Bravo', url: 'https://bravo.example.com', status: 'connected' },
      { id: 3, name: 'Charlie', url: 'https://charlie.example.com', status: 'disconnected' },
    ],
  };

  beforeAll(async () => {
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(async () => {
    server.reset();
    server.setAbilities(STANDARD_ABILITIES);
    // Start with an empty config to test login → use flow
    config = await ConfigDir.create({ profiles: [] });
  });

  afterEach(async () => {
    if (config) await config.cleanup();
  });

  it('step 1: login exits 0 and creates a usable profile', async () => {
    const result = await loginCLI(server, config);

    expect(result.exitCode).toBe(0);

    // Verify profile was persisted
    const profiles = await config.readProfiles();
    expect(profiles.profiles.length).toBeGreaterThanOrEqual(1);
    expect(profiles.activeProfile).toBeDefined();
  });

  it('step 2: list-sites-v1 --json exits 0 with valid data.sites array', async () => {
    // Login first
    const loginResult = await loginCLI(server, config);
    expect(loginResult.exitCode).toBe(0);

    // Set up the list-sites response
    server.setRunResponse('list-sites-v1', abilityRunSuccess(sitesPayload));

    // Run list-sites
    const result = await runWithProfile(
      ['abilities', 'run', 'list-sites-v1', '--json'],
      config,
    );

    expect(result.exitCode).toBe(0);
    expect(result.json).toBeDefined();

    const envelope = result.json as { success: boolean; data: Record<string, unknown> };
    expect(envelope.success).toBe(true);
    expect(envelope.data).toBeDefined();
  });

  it('step 3: data shape matches jq .data.sites[] extraction', async () => {
    // Login first
    const loginResult = await loginCLI(server, config);
    expect(loginResult.exitCode).toBe(0);

    // Set up the list-sites response
    server.setRunResponse('list-sites-v1', abilityRunSuccess(sitesPayload));

    // Run list-sites
    const result = await runWithProfile(
      ['abilities', 'run', 'list-sites-v1', '--json'],
      config,
    );

    expect(result.exitCode).toBe(0);

    // The CLI wraps the API response: { success, data: { data: { sites: [...] } } }
    const envelope = result.json as {
      success: boolean;
      data: { data: { sites: Array<{ id: number; name: string; url: string; status: string }> } };
    };

    // Simulate jq '.data.sites[]' — verify each site has expected fields
    const sites = envelope.data.data.sites;
    expect(Array.isArray(sites)).toBe(true);
    expect(sites).toHaveLength(3);

    for (const site of sites) {
      expect(site).toHaveProperty('id');
      expect(site).toHaveProperty('name');
      expect(site).toHaveProperty('url');
      expect(typeof site.id).toBe('number');
      expect(typeof site.name).toBe('string');
      expect(typeof site.url).toBe('string');
    }

    // Verify specific values
    expect(sites[0]).toMatchObject({ id: 1, name: 'Alpha', url: 'https://alpha.example.com' });
    expect(sites[1]).toMatchObject({ id: 2, name: 'Bravo', url: 'https://bravo.example.com' });
    expect(sites[2]).toMatchObject({ id: 3, name: 'Charlie', url: 'https://charlie.example.com' });
  });
});

// =============================================================================
// 2. Batch Update Scenario
// =============================================================================

describe('Scenario: Batch Update', () => {
  const server = new MockServer();
  let config: ConfigDir;

  const BATCH_JOB_ID = 'batch_update_001';

  const previewPayload = [
    { site_id: 1, name: 'Alpha', updates: [{ type: 'plugin', name: 'akismet', from: '5.0', to: '5.1' }] },
    { site_id: 2, name: 'Bravo', updates: [{ type: 'core', from: '6.4', to: '6.5' }] },
  ];

  const updatesListPayload = {
    updates: [
      { site_id: 1, type: 'plugin', name: 'akismet', current: '5.1', available: null },
      { site_id: 2, type: 'core', current: '6.5', available: null },
    ],
  };

  beforeAll(async () => {
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(async () => {
    server.reset();
    server.setAbilities(STANDARD_ABILITIES);

    config = await ConfigDir.create({
      profiles: [
        { name: 'test', dashboardUrl: server.baseUrl, username: 'admin' },
      ],
      activeProfile: 'test',
    });
  });

  afterEach(async () => {
    if (config) await config.cleanup();
  });

  it('step 1: --dry-run returns preview of affected items', async () => {
    // run-updates-v1 is destructive → POST, dry_run: true in body
    server.setRunResponse('run-updates-v1', abilityDryRunResponse(previewPayload));

    const result = await runWithProfile(
      ['abilities', 'run', 'run-updates-v1', '--dry-run', '--json'],
      config,
    );

    expect(result.exitCode).toBe(0);
    expect(result.json).toBeDefined();

    const envelope = result.json as {
      success: boolean;
      data: Record<string, unknown>;
      mode?: string;
    };
    expect(envelope.success).toBe(true);

    // Verify the server received a POST with dry_run: true
    const req = server.getLastRequest('/run');
    expect(req).toBeDefined();
    expect(req!.method).toBe('POST');

    // dry_run should be in the body.input for POST requests
    const body = req!.body as Record<string, unknown>;
    const input = body['input'] as Record<string, unknown>;
    expect(input['dry_run']).toBe(true);
  });

  it('step 2: --confirm --force --wait executes and waits for job completion', async () => {
    // The run-updates-v1 --confirm returns a batch job
    server.setRunResponse('run-updates-v1', dashboardQueuedResponse(BATCH_JOB_ID));

    // Set up job status progression: pending → running → completed
    server.setJobProgression(BATCH_JOB_ID, [
      jobStatus({ job_id: BATCH_JOB_ID, status: 'pending', progress: 0, processed: 0, total: 2 }),
      jobStatus({ job_id: BATCH_JOB_ID, status: 'running', progress: 50, processed: 1, total: 2 }),
      jobStatus({
        job_id: BATCH_JOB_ID,
        status: 'completed',
        progress: 100,
        processed: 2,
        total: 2,
        results: [
          { site_id: 1, updated: true },
          { site_id: 2, updated: true },
        ],
      }),
    ]);

    const result = await runWithProfile(
      [
        'abilities', 'run', 'run-updates-v1',
        '--confirm', '--force', '--wait',
        '--wait-timeout', '30',
        '--json',
      ],
      config,
    );

    expect(result.exitCode).toBe(0);
    expect(result.json).toBeDefined();

    const envelope = result.json as {
      success: boolean;
      status?: string;
      job_id?: string;
      jobId?: string;
    };
    expect(envelope.success).toBe(true);
  });

  it('step 3: list-updates-v1 after update returns current state', async () => {
    // list-updates-v1 is readonly → GET
    server.setRunResponse('list-updates-v1', abilityRunSuccess(updatesListPayload));

    const result = await runWithProfile(
      ['abilities', 'run', 'list-updates-v1', '--json'],
      config,
    );

    expect(result.exitCode).toBe(0);
    expect(result.json).toBeDefined();

    const envelope = result.json as {
      success: boolean;
      data: { data: { updates: Array<{ site_id: number; type: string }> } };
    };
    expect(envelope.success).toBe(true);
    expect(envelope.data.data.updates).toBeDefined();
    expect(Array.isArray(envelope.data.data.updates)).toBe(true);

    // Verify the server received a GET (readonly)
    const req = server.getLastRequest('/run');
    expect(req).toBeDefined();
    expect(req!.method).toBe('GET');
  });

  it('full lifecycle: dry-run → confirm+wait → verify', async () => {
    // Step 1: dry-run preview
    server.setRunResponse('run-updates-v1', abilityDryRunResponse(previewPayload));

    const previewResult = await runWithProfile(
      ['abilities', 'run', 'run-updates-v1', '--dry-run', '--json'],
      config,
    );
    expect(previewResult.exitCode).toBe(0);

    // Step 2: reset routes and set up for confirm+wait
    server.reset();
    server.setAbilities(STANDARD_ABILITIES);
    server.setRunResponse('run-updates-v1', dashboardQueuedResponse(BATCH_JOB_ID));
    server.setJobProgression(BATCH_JOB_ID, [
      jobStatus({ job_id: BATCH_JOB_ID, status: 'pending', progress: 0, processed: 0, total: 2 }),
      jobStatus({ job_id: BATCH_JOB_ID, status: 'completed', progress: 100, processed: 2, total: 2, results: [{ ok: true }] }),
    ]);

    const executeResult = await runWithProfile(
      [
        'abilities', 'run', 'run-updates-v1',
        '--confirm', '--force', '--wait',
        '--wait-timeout', '30',
        '--json',
      ],
      config,
    );
    expect(executeResult.exitCode).toBe(0);

    // Step 3: reset routes and verify final state
    server.reset();
    server.setAbilities(STANDARD_ABILITIES);
    server.setRunResponse('list-updates-v1', abilityRunSuccess(updatesListPayload));

    const verifyResult = await runWithProfile(
      ['abilities', 'run', 'list-updates-v1', '--json'],
      config,
    );
    expect(verifyResult.exitCode).toBe(0);

    const envelope = verifyResult.json as {
      success: boolean;
      data: { data: { updates: unknown[] } };
    };
    expect(envelope.success).toBe(true);
    expect(envelope.data.data.updates).toHaveLength(2);
  });
});

// =============================================================================
// 3. Plugin Deployment Verification Scenario
// =============================================================================

describe('Scenario: Plugin Deployment Verification', () => {
  const server = new MockServer();
  let config: ConfigDir;

  const sitesPayload = {
    sites: [
      { id: 1, name: 'Alpha', url: 'https://alpha.example.com' },
      { id: 2, name: 'Bravo', url: 'https://bravo.example.com' },
    ],
  };

  const site1Plugins = {
    plugins: [
      { name: 'akismet', version: '5.1', active: true, update_available: false },
      { name: 'jetpack', version: '12.0', active: true, update_available: true },
      { name: 'woocommerce', version: '8.5', active: false, update_available: false },
    ],
  };

  beforeAll(async () => {
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(async () => {
    server.reset();
    server.setAbilities(STANDARD_ABILITIES);
    // Start with empty config — login flow
    config = await ConfigDir.create({ profiles: [] });
  });

  afterEach(async () => {
    if (config) await config.cleanup();
  });

  it('step 1: login succeeds', async () => {
    const result = await loginCLI(server, config);
    expect(result.exitCode).toBe(0);
  });

  it('step 2: list-sites-v1 returns site IDs', async () => {
    await loginCLI(server, config);
    server.setRunResponse('list-sites-v1', abilityRunSuccess(sitesPayload));

    const result = await runWithProfile(
      ['abilities', 'run', 'list-sites-v1', '--json'],
      config,
    );

    expect(result.exitCode).toBe(0);

    const envelope = result.json as {
      success: boolean;
      data: { data: { sites: Array<{ id: number; name: string }> } };
    };
    expect(envelope.success).toBe(true);

    const sites = envelope.data.data.sites;
    expect(sites).toHaveLength(2);

    // Extract site IDs — this is what a script would do
    const siteIds = sites.map((s) => s.id);
    expect(siteIds).toEqual([1, 2]);
  });

  it('step 3: get-site-plugins-v1 returns plugin data for a site', async () => {
    await loginCLI(server, config);
    server.setRunResponse('get-site-plugins-v1', abilityRunSuccess(site1Plugins));

    const result = await runWithProfile(
      [
        'abilities', 'run', 'get-site-plugins-v1',
        '--input', '{"site_id_or_domain": 1}',
        '--json',
      ],
      config,
    );

    expect(result.exitCode).toBe(0);

    const envelope = result.json as {
      success: boolean;
      data: {
        data: {
          plugins: Array<{
            name: string;
            version: string;
            active: boolean;
            update_available: boolean;
          }>;
        };
      };
    };
    expect(envelope.success).toBe(true);

    const plugins = envelope.data.data.plugins;
    expect(Array.isArray(plugins)).toBe(true);
    expect(plugins).toHaveLength(3);

    // Verify each plugin has the expected shape
    for (const plugin of plugins) {
      expect(plugin).toHaveProperty('name');
      expect(plugin).toHaveProperty('version');
      expect(plugin).toHaveProperty('active');
      expect(typeof plugin.name).toBe('string');
      expect(typeof plugin.version).toBe('string');
      expect(typeof plugin.active).toBe('boolean');
    }

    // Verify specific plugins
    expect(plugins[0]).toMatchObject({ name: 'akismet', version: '5.1', active: true });
    expect(plugins[1]).toMatchObject({ name: 'jetpack', version: '12.0', active: true });
    expect(plugins[2]).toMatchObject({ name: 'woocommerce', version: '8.5', active: false });
  });

  it('site_id_or_domain is sent as query param (GET for readonly)', async () => {
    await loginCLI(server, config);
    server.setRunResponse('get-site-plugins-v1', abilityRunSuccess(site1Plugins));

    await runWithProfile(
      [
        'abilities', 'run', 'get-site-plugins-v1',
        '--input', '{"site_id_or_domain": 1}',
        '--json',
      ],
      config,
    );

    // get-site-plugins-v1 is readonly → GET with query params
    const req = server.getLastRequest('/run');
    expect(req).toBeDefined();
    expect(req!.method).toBe('GET');
    expect(req!.query['input[site_id_or_domain]']).toBe('1');
  });

  it('full flow: login → list sites → get plugins for first site', async () => {
    // Step 1: Login
    const loginResult = await loginCLI(server, config);
    expect(loginResult.exitCode).toBe(0);

    // Step 2: List sites
    server.setRunResponse('list-sites-v1', abilityRunSuccess(sitesPayload));
    const sitesResult = await runWithProfile(
      ['abilities', 'run', 'list-sites-v1', '--json'],
      config,
    );
    expect(sitesResult.exitCode).toBe(0);

    // Extract the first site ID from the response
    const sitesEnvelope = sitesResult.json as {
      success: boolean;
      data: { data: { sites: Array<{ id: number }> } };
    };
    const firstSiteId = sitesEnvelope.data.data.sites[0]!.id;
    expect(firstSiteId).toBe(1);

    // Step 3: Get plugins for that site (using the extracted ID)
    server.setRunResponse('get-site-plugins-v1', abilityRunSuccess(site1Plugins));
    const pluginsResult = await runWithProfile(
      [
        'abilities', 'run', 'get-site-plugins-v1',
        '--input', JSON.stringify({ site_id_or_domain: firstSiteId }),
        '--json',
      ],
      config,
    );
    expect(pluginsResult.exitCode).toBe(0);

    const pluginsEnvelope = pluginsResult.json as {
      success: boolean;
      data: { data: { plugins: Array<{ name: string }> } };
    };
    expect(pluginsEnvelope.success).toBe(true);
    expect(pluginsEnvelope.data.data.plugins).toHaveLength(3);
  });
});

// =============================================================================
// 4. Input Methods Scenario
// =============================================================================

describe('Scenario: Input Methods Equivalence', () => {
  const server = new MockServer();
  let config: ConfigDir;

  const singleSitePayload = {
    site: { id: 5, name: 'Echo', url: 'https://echo.example.com', status: 'connected' },
  };

  /** Temp file for --input-file tests. */
  let tmpFilePath: string;

  /** Records of received query params, keyed by input method. */
  const receivedParams: Record<string, Record<string, string>> = {};

  beforeAll(async () => {
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(async () => {
    server.reset();
    server.setAbilities(STANDARD_ABILITIES);

    config = await ConfigDir.create({
      profiles: [
        { name: 'test', dashboardUrl: server.baseUrl, username: 'admin' },
      ],
      activeProfile: 'test',
    });

    tmpFilePath = join(tmpdir(), `mwpctl-scenario-params-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);

    // Clear recorded params
    receivedParams['inline'] = {};
    receivedParams['file'] = {};
    receivedParams['stdin'] = {};
  });

  afterEach(async () => {
    if (config) await config.cleanup();
    try {
      await unlink(tmpFilePath);
    } catch {
      // File may not exist if test failed before creation
    }
  });

  it('method 1: --input inline JSON exits 0 with correct data', async () => {
    server.setRunResponse('get-site-v1', abilityRunSuccess(singleSitePayload));

    const result = await runWithProfile(
      [
        'abilities', 'run', 'get-site-v1',
        '--input', '{"site_id_or_domain": 5}',
        '--json',
      ],
      config,
    );

    expect(result.exitCode).toBe(0);
    expect(result.json).toBeDefined();

    const envelope = result.json as { success: boolean; data: Record<string, unknown> };
    expect(envelope.success).toBe(true);

    // Record what the server received
    const req = server.getLastRequest('/run');
    expect(req).toBeDefined();
    receivedParams['inline'] = { ...req!.query };
  });

  it('method 2: --input-file exits 0 with correct data', async () => {
    await writeFile(tmpFilePath, JSON.stringify({ site_id_or_domain: 5 }), 'utf-8');
    server.setRunResponse('get-site-v1', abilityRunSuccess(singleSitePayload));

    const result = await runWithProfile(
      [
        'abilities', 'run', 'get-site-v1',
        '--input-file', tmpFilePath,
        '--json',
      ],
      config,
    );

    expect(result.exitCode).toBe(0);
    expect(result.json).toBeDefined();

    const envelope = result.json as { success: boolean; data: Record<string, unknown> };
    expect(envelope.success).toBe(true);

    // Record what the server received
    const req = server.getLastRequest('/run');
    expect(req).toBeDefined();
    receivedParams['file'] = { ...req!.query };
  });

  it('method 3: --input - (stdin pipe) exits 0 with correct data', async () => {
    server.setRunResponse('get-site-v1', abilityRunSuccess(singleSitePayload));

    const result = await runWithProfile(
      [
        'abilities', 'run', 'get-site-v1',
        '--input', '-',
        '--json',
      ],
      config,
      { stdin: '{"site_id_or_domain": 5}' },
    );

    expect(result.exitCode).toBe(0);
    expect(result.json).toBeDefined();

    const envelope = result.json as { success: boolean; data: Record<string, unknown> };
    expect(envelope.success).toBe(true);

    // Record what the server received
    const req = server.getLastRequest('/run');
    expect(req).toBeDefined();
    receivedParams['stdin'] = { ...req!.query };
  });

  it('all 3 methods produce equivalent server-side params', async () => {
    const inputJson = '{"site_id_or_domain": 5}';
    const results: Array<{ method: string; query: Record<string, string>; response: unknown }> = [];

    // Method 1: --input inline
    server.setRunResponse('get-site-v1', abilityRunSuccess(singleSitePayload));
    const inlineResult = await runWithProfile(
      ['abilities', 'run', 'get-site-v1', '--input', inputJson, '--json'],
      config,
    );
    expect(inlineResult.exitCode).toBe(0);
    const inlineReq = server.getLastRequest('/run');
    results.push({
      method: 'inline',
      query: { ...inlineReq!.query },
      response: inlineResult.json,
    });

    // Method 2: --input-file
    await writeFile(tmpFilePath, inputJson, 'utf-8');
    server.setRunResponse('get-site-v1', abilityRunSuccess(singleSitePayload));
    const fileResult = await runWithProfile(
      ['abilities', 'run', 'get-site-v1', '--input-file', tmpFilePath, '--json'],
      config,
    );
    expect(fileResult.exitCode).toBe(0);
    const fileReq = server.getLastRequest('/run');
    results.push({
      method: 'file',
      query: { ...fileReq!.query },
      response: fileResult.json,
    });

    // Method 3: --input - (stdin)
    server.setRunResponse('get-site-v1', abilityRunSuccess(singleSitePayload));
    const stdinResult = await runWithProfile(
      ['abilities', 'run', 'get-site-v1', '--input', '-', '--json'],
      config,
      { stdin: inputJson },
    );
    expect(stdinResult.exitCode).toBe(0);
    const stdinReq = server.getLastRequest('/run');
    results.push({
      method: 'stdin',
      query: { ...stdinReq!.query },
      response: stdinResult.json,
    });

    // All three should have sent the same query params to the server
    expect(results[0]!.query['input[site_id_or_domain]']).toBe('5');
    expect(results[1]!.query['input[site_id_or_domain]']).toBe('5');
    expect(results[2]!.query['input[site_id_or_domain]']).toBe('5');

    // All three query objects should be equivalent
    expect(results[0]!.query).toEqual(results[1]!.query);
    expect(results[1]!.query).toEqual(results[2]!.query);

    // All three responses should have the same envelope shape
    for (const r of results) {
      const envelope = r.response as { success: boolean; data: { data: unknown } };
      expect(envelope.success).toBe(true);
      expect(envelope.data.data).toEqual(singleSitePayload);
    }
  });

  it('all 3 methods use GET for readonly ability', async () => {
    const inputJson = '{"site_id_or_domain": 5}';
    const methods: string[] = [];

    // Inline
    server.setRunResponse('get-site-v1', abilityRunSuccess(singleSitePayload));
    await runWithProfile(
      ['abilities', 'run', 'get-site-v1', '--input', inputJson, '--json'],
      config,
    );
    methods.push(server.getLastRequest('/run')!.method);

    // File
    await writeFile(tmpFilePath, inputJson, 'utf-8');
    server.setRunResponse('get-site-v1', abilityRunSuccess(singleSitePayload));
    await runWithProfile(
      ['abilities', 'run', 'get-site-v1', '--input-file', tmpFilePath, '--json'],
      config,
    );
    methods.push(server.getLastRequest('/run')!.method);

    // Stdin
    server.setRunResponse('get-site-v1', abilityRunSuccess(singleSitePayload));
    await runWithProfile(
      ['abilities', 'run', 'get-site-v1', '--input', '-', '--json'],
      config,
      { stdin: inputJson },
    );
    methods.push(server.getLastRequest('/run')!.method);

    // All should be GET (readonly ability)
    expect(methods).toEqual(['GET', 'GET', 'GET']);
  });
});
