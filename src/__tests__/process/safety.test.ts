import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
      ['abilities', 'run', 'delete-site-v1', '--input', '{"site_id_or_domain":1}', '--dry-run', '--json'],
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
    expect(input).toHaveProperty('site_id_or_domain', 1);

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
        '--input', '{"site_id_or_domain":1}',
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
    expect(confirmInput).toHaveProperty('site_id_or_domain', 1);

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
  //    Parse failures are user input errors → exit 1 (INPUT_ERROR).
  // -------------------------------------------------------------------------
  it('--dry-run and --confirm together are rejected as mutually exclusive', async () => {
    await createConfig();

    const result = await runCLI(
      [
        'abilities', 'run', 'delete-site-v1',
        '--input', '{"site_id_or_domain":1}',
        '--dry-run', '--confirm',
      ],
      {
        xdgConfigHome: config.xdgHome,
        env: { MAINWP_APP_PASSWORD: 'test-pass' },
      },
    );

    // User input error (oclif flag validation) maps to exit code 1
    expect(result.exitCode).toBe(1);

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
        '--input', '{"site_id_or_domain":1}',
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
        '--input', '{"site_id_or_domain":1}',
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

  // -------------------------------------------------------------------------
  // 7. Preview failure blocks destructive execution (fail closed).
  //    A dry_run that errors at the HTTP layer must abort the flow with
  //    exit 4 and must never send a confirm request — even with --force.
  // -------------------------------------------------------------------------
  it('--confirm --force with HTTP-failing preview exits 4 and sends no confirm request', async () => {
    await createConfig();

    const runPath = '/wp-json/wp-abilities/v1/abilities/mainwp/delete-site-v1/run';
    server.addRoute('POST', runPath, (_req, res) => {
      const body = _req.body as Record<string, unknown> | undefined;
      const input = body?.['input'] as Record<string, unknown> | undefined;
      if (input?.['dry_run'] === true) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 'internal_error', message: 'preview exploded' }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(abilityRunSuccess({ deleted: true })));
      }
    });

    const result = await runCLI(
      [
        'abilities', 'run', 'delete-site-v1',
        '--input', '{"site_id_or_domain":1}',
        '--confirm', '--force', '--json',
      ],
      {
        xdgConfigHome: config.xdgHome,
        env: { MAINWP_APP_PASSWORD: 'test-pass' },
      },
    );

    expect(result.exitCode).toBe(4);

    // No confirm request may have reached the server
    const confirmReq = server
      .getRecordedRequests()
      .filter((r) => r.path.includes('delete-site-v1/run'))
      .find((r) => {
        const body = r.body as Record<string, unknown> | undefined;
        const input = body?.['input'] as Record<string, unknown> | undefined;
        return input?.['confirm'] === true;
      });
    expect(confirmReq).toBeUndefined();

    const envelope = result.json as Record<string, unknown>;
    expect(envelope).toHaveProperty('success', false);
    expect(String((envelope['error'] as Record<string, unknown>)?.['message'] ?? '')).toMatch(/preview/i);
  });

  // -------------------------------------------------------------------------
  // 8. Preview returning success:false also fails closed (no confirm request)
  // -------------------------------------------------------------------------
  it('--confirm --force with unsuccessful preview result exits 4 and sends no confirm request', async () => {
    await createConfig();

    const runPath = '/wp-json/wp-abilities/v1/abilities/mainwp/delete-site-v1/run';
    server.addRoute('POST', runPath, (_req, res) => {
      const body = _req.body as Record<string, unknown> | undefined;
      const input = body?.['input'] as Record<string, unknown> | undefined;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (input?.['dry_run'] === true) {
        res.end(JSON.stringify({ success: false, error: { code: 'preview_unavailable', message: 'cannot preview' } }));
      } else {
        res.end(JSON.stringify(abilityRunSuccess({ deleted: true })));
      }
    });

    const result = await runCLI(
      [
        'abilities', 'run', 'delete-site-v1',
        '--input', '{"site_id_or_domain":1}',
        '--confirm', '--force', '--json',
      ],
      {
        xdgConfigHome: config.xdgHome,
        env: { MAINWP_APP_PASSWORD: 'test-pass' },
      },
    );

    expect(result.exitCode).toBe(4);

    const confirmReq = server
      .getRecordedRequests()
      .filter((r) => r.path.includes('delete-site-v1/run'))
      .find((r) => {
        const body = r.body as Record<string, unknown> | undefined;
        const input = body?.['input'] as Record<string, unknown> | undefined;
        return input?.['confirm'] === true;
      });
    expect(confirmReq).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 9. Successful preview is rendered to the operator before execution,
  //    even with --force (which skips only the prompt, never the preview).
  // -------------------------------------------------------------------------
  it('--confirm --force renders the preview before the execution result (human mode)', async () => {
    await createConfig();

    const runPath = '/wp-json/wp-abilities/v1/abilities/mainwp/delete-site-v1/run';
    server.addRoute('POST', runPath, (_req, res) => {
      const body = _req.body as Record<string, unknown> | undefined;
      const input = body?.['input'] as Record<string, unknown> | undefined;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (input?.['dry_run'] === true) {
        res.end(JSON.stringify(abilityDryRunResponse([{ site_id: 1, name: 'Test Site' }])));
      } else {
        res.end(JSON.stringify(abilityRunSuccess({ deleted: true })));
      }
    });

    const result = await runCLI(
      [
        'abilities', 'run', 'delete-site-v1',
        '--input', '{"site_id_or_domain":1}',
        '--confirm', '--force',
      ],
      {
        xdgConfigHome: config.xdgHome,
        env: { MAINWP_APP_PASSWORD: 'test-pass' },
      },
    );

    expect(result.exitCode).toBe(0);

    const previewIdx = result.stdout.indexOf('Preview:');
    const executedIdx = result.stdout.indexOf('Executed:');
    expect(previewIdx).toBeGreaterThanOrEqual(0);
    expect(executedIdx).toBeGreaterThan(previewIdx);
  });

  // -------------------------------------------------------------------------
  // 10. In JSON mode the preview is included in the success envelope
  // -------------------------------------------------------------------------
  it('--confirm --force --json includes preview data in the success envelope', async () => {
    await createConfig();

    const runPath = '/wp-json/wp-abilities/v1/abilities/mainwp/delete-site-v1/run';
    server.addRoute('POST', runPath, (_req, res) => {
      const body = _req.body as Record<string, unknown> | undefined;
      const input = body?.['input'] as Record<string, unknown> | undefined;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (input?.['dry_run'] === true) {
        res.end(JSON.stringify(abilityDryRunResponse([{ site_id: 1, name: 'Test Site' }])));
      } else {
        res.end(JSON.stringify(abilityRunSuccess({ deleted: true })));
      }
    });

    const result = await runCLI(
      [
        'abilities', 'run', 'delete-site-v1',
        '--input', '{"site_id_or_domain":1}',
        '--confirm', '--force', '--json',
      ],
      {
        xdgConfigHome: config.xdgHome,
        env: { MAINWP_APP_PASSWORD: 'test-pass' },
      },
    );

    expect(result.exitCode).toBe(0);

    const envelope = result.json as Record<string, unknown>;
    expect(envelope).toHaveProperty('success', true);
    const data = envelope['data'] as Record<string, unknown>;
    expect(data).toHaveProperty('preview');
    const preview = data['preview'] as Record<string, unknown>;
    expect(preview).toHaveProperty('summary');
    expect(preview).toHaveProperty('affected');
  });

  // -------------------------------------------------------------------------
  // 11. Transport failure AFTER the confirm call is dispatched is an unknown
  //     outcome: OUTCOME_UNKNOWN in the envelope, exit 3, and BOTH audit
  //     entries (dispatch-stage before the call, outcomeUnknown after) are
  //     on disk even though no response ever arrived.
  // -------------------------------------------------------------------------
  it('--confirm --force with connection dropped mid-confirm exits 3 with OUTCOME_UNKNOWN and audits the dispatch', async () => {
    await createConfig();

    const runPath = '/wp-json/wp-abilities/v1/abilities/mainwp/delete-site-v1/run';
    server.addRoute('POST', runPath, (_req, res) => {
      const body = _req.body as Record<string, unknown> | undefined;
      const input = body?.['input'] as Record<string, unknown> | undefined;
      if (input?.['dry_run'] === true) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(abilityDryRunResponse([{ site_id: 1, name: 'Test Site' }])));
      } else {
        // Confirm call: the server got the request, then the connection dies
        // before any response — the Dashboard may have executed the action.
        res.socket?.destroy();
      }
    });

    const result = await runCLI(
      [
        'abilities', 'run', 'delete-site-v1',
        '--input', '{"site_id_or_domain":1}',
        '--confirm', '--force', '--json',
      ],
      {
        xdgConfigHome: config.xdgHome,
        env: { MAINWP_APP_PASSWORD: 'test-pass' },
      },
    );

    // NETWORK_ERROR exit class, but labeled as an unknown outcome
    expect(result.exitCode).toBe(3);
    const envelope = result.json as Record<string, unknown>;
    expect(envelope).toHaveProperty('success', false);
    const error = envelope['error'] as Record<string, unknown>;
    expect(error['code']).toBe('OUTCOME_UNKNOWN');
    expect(String(error['message'])).toContain('may or may not have executed');

    // The confirm request really was dispatched
    const confirmRequests = server
      .getRecordedRequests()
      .filter((r) => r.path.includes('delete-site-v1'))
      .filter((r) => {
        const body = r.body as Record<string, unknown> | undefined;
        const input = body?.['input'] as Record<string, unknown> | undefined;
        return input?.['dry_run'] !== true;
      });
    expect(confirmRequests.length).toBe(1);

    // Audit trail: a dispatch-stage entry written before the confirm call,
    // then an outcomeUnknown entry after the transport failure.
    const auditRaw = await readFile(join(config.configPath, 'audit.log'), 'utf-8');
    const entries = auditRaw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const dispatchEntry = entries.find((e) => e['stage'] === 'dispatch');
    expect(dispatchEntry).toBeDefined();
    expect(dispatchEntry!['userDecision']).toBe('approved');
    expect(dispatchEntry!['abilityName']).toContain('delete-site-v1');
    const unknownEntry = entries.find(
      (e) => (e['execution'] as Record<string, unknown> | undefined)?.['outcomeUnknown'] === true
    );
    expect(unknownEntry).toBeDefined();
    expect(unknownEntry!['userDecision']).toBe('approved');
    expect((unknownEntry!['execution'] as Record<string, unknown>)['success']).toBe(false);
  });
});
