import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { MockServer } from './fixtures/mock-server.js';
import { runCLI } from './fixtures/cli-runner.js';
import { ConfigDir } from './fixtures/config-dir.js';
import { abilityDryRunResponse, abilityRunSuccess } from './fixtures/api-responses.js';

describe('safety / destructive action handling', () => {
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
    server.setAbilities();
  });

  afterEach(async () => {
    if (config) await config.cleanup();
  });

  /**
   * Helper to create a config dir with a profile pointing at the mock server.
   */
  async function createConfig(): Promise<ConfigDir> {
    config = await ConfigDir.create({
      profiles: [
        {
          name: 'test',
          dashboardUrl: server.baseUrl,
          username: 'admin',
        },
      ],
      activeProfile: 'test',
    });
    return config;
  }

  // -------------------------------------------------------------------------
  // 1. --dry-run sends dry_run: true in POST body and exits 0
  // -------------------------------------------------------------------------
  it('--dry-run on destructive ability sends dry_run:true via POST and exits 0', async () => {
    await createConfig();

    // Register the run endpoint to return a dry-run preview
    server.setRunResponse(
      'delete-site-v1',
      abilityDryRunResponse([{ site_id: 1, name: 'Test Site' }]),
    );

    const result = await runCLI(
      ['abilities', 'run', 'delete-site-v1', '--input', '{"site_id":1}', '--dry-run', '--json'],
      {
        xdgConfigHome: config.xdgHome,
        env: { MAINWP_APP_PASSWORD: 'test-pass' },
      },
    );

    expect(result.exitCode).toBe(0);

    // Verify the server received a POST request (delete-site-v1 is destructive + not idempotent → POST)
    const runRequests = server
      .getRecordedRequests()
      .filter((r) => r.path.includes('/run'));

    expect(runRequests.length).toBeGreaterThanOrEqual(1);

    const runReq = runRequests[runRequests.length - 1]!;
    expect(runReq.method).toBe('POST');

    // Input is nested under body.input (WP Abilities API format)
    const body = runReq.body as Record<string, unknown>;
    const input = body['input'] as Record<string, unknown>;
    expect(input).toHaveProperty('dry_run', true);
    expect(input).toHaveProperty('site_id', 1);

    // confirm must NOT be present
    expect(input).not.toHaveProperty('confirm');
    expect(input).not.toHaveProperty('user_confirmed');

    // JSON output should include preview data
    expect(result.json).toBeDefined();
    const envelope = result.json as Record<string, unknown>;
    expect(envelope).toHaveProperty('success', true);
  });

  // -------------------------------------------------------------------------
  // 2. --confirm --force sends confirm:true + user_confirmed:true and exits 0
  //    The executor makes TWO calls: first a dry_run preview (for audit),
  //    then the actual execution with confirm.
  // -------------------------------------------------------------------------
  it('--confirm --force on destructive ability sends confirm and user_confirmed via POST', async () => {
    await createConfig();

    // The run endpoint will be called twice:
    //   1. dry_run preview (for audit logging in executeDestructive)
    //   2. confirm execution
    // Use addRoute with a handler that always returns success.
    const runPath = '/wp-json/wp-abilities/v1/abilities/mainwp/delete-site-v1/run';

    server.addRoute('POST', runPath, (_req, res) => {
      const body = _req.body as Record<string, unknown> | undefined;
      const input = body?.['input'] as Record<string, unknown> | undefined;
      if (input?.['dry_run'] === true) {
        // First call: dry_run preview for audit
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(abilityDryRunResponse([{ site_id: 1, name: 'Test Site' }])));
      } else {
        // Second call: actual execution with confirm
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(abilityRunSuccess({ deleted: true })));
      }
    });

    const result = await runCLI(
      [
        'abilities', 'run', 'delete-site-v1',
        '--input', '{"site_id":1}',
        '--confirm', '--force', '--json',
      ],
      {
        xdgConfigHome: config.xdgHome,
        env: { MAINWP_APP_PASSWORD: 'test-pass' },
      },
    );

    expect(result.exitCode).toBe(0);

    // Collect all POST requests to the run endpoint
    const runRequests = server
      .getRecordedRequests()
      .filter((r) => r.path.includes('/run') && r.path.includes('delete-site-v1'));

    // Should have at least 2 POST requests: dry_run preview + confirm execution
    expect(runRequests.length).toBeGreaterThanOrEqual(2);

    // Find the confirm request (the one with confirm: true in body.input)
    const confirmReq = runRequests.find((r) => {
      const body = r.body as Record<string, unknown> | undefined;
      const input = body?.['input'] as Record<string, unknown> | undefined;
      return input?.['confirm'] === true;
    });
    expect(confirmReq).toBeDefined();
    expect(confirmReq!.method).toBe('POST');

    const confirmInput = (confirmReq!.body as Record<string, unknown>)['input'] as Record<string, unknown>;
    expect(confirmInput).toHaveProperty('confirm', true);
    expect(confirmInput).toHaveProperty('user_confirmed', true);
    expect(confirmInput).toHaveProperty('site_id', 1);

    // The dry_run request should also be present
    const dryRunReq = runRequests.find((r) => {
      const body = r.body as Record<string, unknown> | undefined;
      const input = body?.['input'] as Record<string, unknown> | undefined;
      return input?.['dry_run'] === true;
    });
    expect(dryRunReq).toBeDefined();
    expect(dryRunReq!.method).toBe('POST');

    // JSON output should indicate success
    const envelope = result.json as Record<string, unknown>;
    expect(envelope).toHaveProperty('success', true);
  });

  // -------------------------------------------------------------------------
  // 3. --dry-run --confirm together → oclif rejects at flag parsing time
  //    oclif's exclusive flag validation fires before the command runs.
  //    The FailedFlagValidationError lacks an exitCode property, so
  //    BaseCommand.catch defaults to ExitCode.INTERNAL_ERROR (5).
  // -------------------------------------------------------------------------
  it('--dry-run and --confirm together are rejected as mutually exclusive', async () => {
    await createConfig();

    const result = await runCLI(
      [
        'abilities', 'run', 'delete-site-v1',
        '--input', '{"site_id":1}',
        '--dry-run', '--confirm',
      ],
      {
        xdgConfigHome: config.xdgHome,
        env: { MAINWP_APP_PASSWORD: 'test-pass' },
      },
    );

    // Exit code is non-zero (oclif flag validation error)
    expect(result.exitCode).not.toBe(0);

    // Error output should mention the mutual exclusion
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/cannot also be provided|mutually exclusive/i);

    // No requests should have reached the server for ability execution
    const runRequests = server
      .getRecordedRequests()
      .filter((r) => r.path.includes('delete-site-v1/run'));
    expect(runRequests).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 4. Destructive ability without --dry-run or --confirm →
  //    ConfirmationRequiredError → exit code 4 (API_ERROR)
  // -------------------------------------------------------------------------
  it('destructive ability without --dry-run or --confirm exits 4 (confirmation required)', async () => {
    await createConfig();

    const result = await runCLI(
      [
        'abilities', 'run', 'delete-site-v1',
        '--input', '{"site_id":1}',
        '--json',
      ],
      {
        xdgConfigHome: config.xdgHome,
        env: { MAINWP_APP_PASSWORD: 'test-pass' },
      },
    );

    expect(result.exitCode).toBe(4);

    // Error output should mention confirmation requirement
    const envelope = result.json as Record<string, unknown>;
    expect(envelope).toHaveProperty('success', false);

    const error = envelope['error'] as Record<string, unknown> | undefined;
    expect(error).toBeDefined();
    const errorMessage = String(error?.['message'] ?? '');
    expect(errorMessage).toMatch(/dry-run|confirm|destructive/i);
  });

  // -------------------------------------------------------------------------
  // 5. Non-TTY + --confirm without --force → exit 1 (InputError)
  //    In non-interactive mode, executeDestructive requires --force.
  // -------------------------------------------------------------------------
  it('non-TTY with --confirm but without --force exits 1 (input error)', async () => {
    await createConfig();

    // Register the run endpoint so the dry_run preview in executeDestructive succeeds
    server.setRunResponse(
      'delete-site-v1',
      abilityDryRunResponse([{ site_id: 1, name: 'Test Site' }]),
    );

    const result = await runCLI(
      [
        'abilities', 'run', 'delete-site-v1',
        '--input', '{"site_id":1}',
        '--confirm', '--json',
      ],
      {
        xdgConfigHome: config.xdgHome,
        env: { MAINWP_APP_PASSWORD: 'test-pass' },
      },
    );

    // InputError maps to exit code 1
    expect(result.exitCode).toBe(1);

    // Error should mention non-interactive / --force requirement
    const envelope = result.json as Record<string, unknown>;
    expect(envelope).toHaveProperty('success', false);

    const error = envelope['error'] as Record<string, unknown> | undefined;
    expect(error).toBeDefined();
    const errorMessage = String(error?.['message'] ?? '');
    expect(errorMessage).toMatch(/interactive|force|non-interactive/i);
  });

  // -------------------------------------------------------------------------
  // 6. Read-only ability executes directly without --dry-run or --confirm
  // -------------------------------------------------------------------------
  it('read-only ability executes directly via GET without safety flags', async () => {
    await createConfig();

    server.setRunResponse(
      'list-sites-v1',
      abilityRunSuccess([
        { id: 1, name: 'Site A' },
        { id: 2, name: 'Site B' },
      ]),
    );

    const result = await runCLI(
      ['abilities', 'run', 'list-sites-v1', '--json'],
      {
        xdgConfigHome: config.xdgHome,
        env: { MAINWP_APP_PASSWORD: 'test-pass' },
      },
    );

    expect(result.exitCode).toBe(0);

    // Read-only ability uses GET (annotations.readonly = true)
    const runRequests = server
      .getRecordedRequests()
      .filter((r) => r.path.includes('list-sites-v1/run'));
    expect(runRequests.length).toBeGreaterThanOrEqual(1);

    const runReq = runRequests[runRequests.length - 1]!;
    expect(runReq.method).toBe('GET');

    // No dry_run or confirm in the request
    expect(runReq.query).not.toHaveProperty('input[dry_run]');
    expect(runReq.query).not.toHaveProperty('input[confirm]');
  });
});
