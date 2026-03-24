/**
 * Process-level tests for batch job waiting
 *
 * Verifies --wait flag on `abilities run` and `jobs watch` by spawning
 * mainwpcontrol as a child process against a mock HTTP server that returns
 * progressive batch job statuses.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { MockServer } from './fixtures/mock-server.js';
import { runCLI } from './fixtures/cli-runner.js';
import { ConfigDir } from './fixtures/config-dir.js';
import { abilityRunBatch, jobStatus } from './fixtures/api-responses.js';

describe('batch job waiting', () => {
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

  /**
   * Create a config dir with a profile pointing to the mock server.
   */
  async function createConfig(): Promise<ConfigDir> {
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
    return configDir;
  }

  // ---------------------------------------------------------------------------
  // 1. abilities run sync-sites-v1 --wait --json → exit 0, JSON has final results
  // ---------------------------------------------------------------------------

  it('abilities run --wait --json exits 0 with completed batch results', async () => {
    const cfg = await createConfig();

    // Register the ability run endpoint to return a batch job
    server.setRunResponse('sync-sites-v1', abilityRunBatch('sync_123'));

    // Register the batch status progression: running → completed
    server.setJobProgression('sync_123', [
      jobStatus({ job_id: 'sync_123', status: 'running', progress: 50, processed: 5, total: 10 }),
      jobStatus({ job_id: 'sync_123', status: 'completed', progress: 100, processed: 10, total: 10, results: [{ id: 1 }, { id: 2 }] }),
    ]);

    const result = await runCLI(
      ['abilities', 'run', 'sync-sites-v1', '--wait', '--json'],
      {
        xdgConfigHome: cfg.xdgHome,
        env: { MAINWP_APP_PASSWORD: 'test-pass' },
        timeout: 30_000,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.json).toBeDefined();

    const envelope = result.json as {
      success: boolean;
      data: {
        mode: string;
        jobId: string;
        timedOut: boolean;
        status: string;
        results?: unknown[];
        processed?: number;
        total?: number;
      };
    };

    expect(envelope.success).toBe(true);
    expect(envelope.data.mode).toBe('batch');
    expect(envelope.data.jobId).toBe('sync_123');
    expect(envelope.data.timedOut).toBe(false);
    expect(envelope.data.status).toBe('completed');
    expect(envelope.data.results).toBeDefined();
    expect(Array.isArray(envelope.data.results)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 2. abilities run sync-sites-v1 --wait --wait-timeout 2 → timeout → exit 4
  // ---------------------------------------------------------------------------

  it('abilities run --wait with timeout exits 4 (BATCH_TIMEOUT)', async () => {
    const cfg = await createConfig();

    server.setRunResponse('sync-sites-v1', abilityRunBatch('sync_123'));

    // Job never completes: stays running forever (last status repeated)
    server.setJobProgression('sync_123', [
      jobStatus({ job_id: 'sync_123', status: 'running', progress: 10, processed: 1, total: 10 }),
    ]);

    const result = await runCLI(
      ['abilities', 'run', 'sync-sites-v1', '--wait', '--wait-timeout', '2', '--json'],
      {
        xdgConfigHome: cfg.xdgHome,
        env: { MAINWP_APP_PASSWORD: 'test-pass' },
        timeout: 30_000,
      },
    );

    // APIError with code BATCH_TIMEOUT maps to exit code 4
    expect(result.exitCode).toBe(4);

    // stdout contains partial results + error envelope (two JSON objects)
    // Verify that BATCH_TIMEOUT appears in the output
    expect(result.stdout).toContain('BATCH_TIMEOUT');
  });

  // ---------------------------------------------------------------------------
  // 3. jobs watch sync_123 --json → exit 0, valid JSON with job status
  // ---------------------------------------------------------------------------

  it('jobs watch --json exits 0 with completed job status', async () => {
    const cfg = await createConfig();

    // jobs watch polls get-batch-job-status-v1 directly
    server.setJobProgression('sync_123', [
      jobStatus({ job_id: 'sync_123', status: 'completed', progress: 100, processed: 10, total: 10, results: [{ id: 1 }] }),
    ]);

    const result = await runCLI(
      ['jobs', 'watch', 'sync_123', '--json', '--initial-delay', '100'],
      {
        xdgConfigHome: cfg.xdgHome,
        env: { MAINWP_APP_PASSWORD: 'test-pass' },
        timeout: 15_000,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.json).toBeDefined();

    const envelope = result.json as {
      success: boolean;
      data: {
        job_id: string;
        status: string;
        timedOut: boolean;
        progress?: number;
        processed?: number;
        total?: number;
        results?: unknown[];
      };
    };

    expect(envelope.success).toBe(true);
    expect(envelope.data.job_id).toBe('sync_123');
    expect(envelope.data.status).toBe('completed');
    expect(envelope.data.timedOut).toBe(false);
    expect(envelope.data.results).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // 4. jobs watch sync_123 --timeout 5 → exit 0 (custom timeout, job completes)
  // ---------------------------------------------------------------------------

  it('jobs watch with --timeout exits 0 when job completes within timeout', async () => {
    const cfg = await createConfig();

    // Job completes on second poll
    server.setJobProgression('sync_123', [
      jobStatus({ job_id: 'sync_123', status: 'running', progress: 50, processed: 5, total: 10 }),
      jobStatus({ job_id: 'sync_123', status: 'completed', progress: 100, processed: 10, total: 10, results: [{ id: 1 }, { id: 2 }] }),
    ]);

    const result = await runCLI(
      ['jobs', 'watch', 'sync_123', '--timeout', '5', '--initial-delay', '100'],
      {
        xdgConfigHome: cfg.xdgHome,
        env: { MAINWP_APP_PASSWORD: 'test-pass' },
        timeout: 15_000,
      },
    );

    expect(result.exitCode).toBe(0);

    // Verify some output was produced (human-readable mode, no --json)
    const combined = result.stdout + result.stderr;
    expect(combined.length).toBeGreaterThan(0);
    // Should mention completion or the job ID
    const mentionsJob = /sync_123/i.test(combined) || /completed/i.test(combined);
    expect(mentionsJob).toBe(true);
  });
});
