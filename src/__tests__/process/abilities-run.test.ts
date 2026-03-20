/**
 * Process-level tests for `mainwpctl abilities run`
 *
 * Spawns the CLI as a child process against a mock HTTP server
 * to verify the full request/response lifecycle: input resolution,
 * HTTP method selection, query-param encoding, JSON envelope output,
 * and error handling for missing files.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MockServer } from './fixtures/mock-server.js';
import { runCLI, type CLIResult } from './fixtures/cli-runner.js';
import { ConfigDir } from './fixtures/config-dir.js';
import { abilityRunSuccess } from './fixtures/api-responses.js';

describe('abilities run', () => {
  const server = new MockServer();
  let config: ConfigDir;

  // Reusable mock data
  const sitesPayload = {
    sites: [
      { id: 1, name: 'Alpha', url: 'https://alpha.example.com' },
      { id: 2, name: 'Bravo', url: 'https://bravo.example.com' },
    ],
  };

  const singleSitePayload = {
    site: { id: 5, name: 'Echo', url: 'https://echo.example.com' },
  };

  beforeAll(async () => {
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(async () => {
    server.reset();
    server.setAbilities(); // registers GET /wp-json/wp-abilities/v1/abilities

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
  });

  afterEach(async () => {
    if (config) await config.cleanup();
  });

  /** Helper: run CLI with profile + app password wired to mock server. */
  function run(args: string[], extra?: { stdin?: string; env?: Record<string, string> }): Promise<CLIResult> {
    return runCLI(args, {
      xdgConfigHome: config.xdgHome,
      env: {
        MAINWP_APP_PASSWORD: 'test-pass',
        ...extra?.env,
      },
      stdin: extra?.stdin,
    });
  }

  // -------------------------------------------------------------------------
  // 1. list-sites-v1 --json → exit 0, valid JSON envelope
  // -------------------------------------------------------------------------
  describe('list-sites-v1 --json (readonly, no input)', () => {
    it('exits 0 and returns a valid JSON envelope with sites data', async () => {
      server.setRunResponse('list-sites-v1', abilityRunSuccess(sitesPayload));

      const result = await run(['abilities', 'run', 'list-sites-v1', '--json']);

      expect(result.exitCode).toBe(0);
      expect(result.json).toBeDefined();

      const envelope = result.json as { success: boolean; data: Record<string, unknown> };
      expect(envelope.success).toBe(true);
      expect(envelope.data).toBeDefined();

      // The executor wraps the API response inside the CLI envelope.
      // data.data holds the inner payload from abilityRunSuccess().
      const inner = envelope.data as { data: typeof sitesPayload };
      expect(inner.data).toBeDefined();
      expect(inner.data.sites).toHaveLength(2);
      expect(inner.data.sites[0]).toMatchObject({ id: 1, name: 'Alpha' });
    });

    it('sends a GET request because list-sites-v1 is readonly', async () => {
      server.setRunResponse('list-sites-v1', abilityRunSuccess(sitesPayload));

      await run(['abilities', 'run', 'list-sites-v1', '--json']);

      const req = server.getLastRequest('/run');
      expect(req).toBeDefined();
      expect(req!.method).toBe('GET');
    });
  });

  // -------------------------------------------------------------------------
  // 2. get-site-v1 --input '{"site_id": 5}' --json → GET with query params
  // -------------------------------------------------------------------------
  describe('get-site-v1 --input (inline JSON)', () => {
    it('exits 0 and sends input as query params on a GET request', async () => {
      server.setRunResponse('get-site-v1', abilityRunSuccess(singleSitePayload));

      const result = await run([
        'abilities', 'run', 'get-site-v1',
        '--input', '{"site_id": 5}',
        '--json',
      ]);

      expect(result.exitCode).toBe(0);

      const envelope = result.json as { success: boolean; data: Record<string, unknown> };
      expect(envelope.success).toBe(true);

      // Verify the server received a GET with site_id as a query param
      const req = server.getLastRequest('/run');
      expect(req).toBeDefined();
      expect(req!.method).toBe('GET');
      expect(req!.query['input[site_id]']).toBe('5');
    });
  });

  // -------------------------------------------------------------------------
  // 3. get-site-v1 --input-file /tmp/params.json --json
  // -------------------------------------------------------------------------
  describe('get-site-v1 --input-file (file input)', () => {
    const tmpFile = join(tmpdir(), `mwpctl-test-params-${Date.now()}.json`);

    afterEach(async () => {
      try {
        await unlink(tmpFile);
      } catch {
        // file may not exist if test failed before creation
      }
    });

    it('reads input from the specified file and sends it as query params', async () => {
      await writeFile(tmpFile, JSON.stringify({ site_id: 5 }), 'utf-8');
      server.setRunResponse('get-site-v1', abilityRunSuccess(singleSitePayload));

      const result = await run([
        'abilities', 'run', 'get-site-v1',
        '--input-file', tmpFile,
        '--json',
      ]);

      expect(result.exitCode).toBe(0);

      const envelope = result.json as { success: boolean; data: Record<string, unknown> };
      expect(envelope.success).toBe(true);

      // Verify the server received site_id in query params (GET for readonly)
      const req = server.getLastRequest('/run');
      expect(req).toBeDefined();
      expect(req!.method).toBe('GET');
      expect(req!.query['input[site_id]']).toBe('5');
    });
  });

  // -------------------------------------------------------------------------
  // 4. echo '{"site_id": 5}' | mainwpctl abilities run get-site-v1 --input - --json
  // -------------------------------------------------------------------------
  describe('get-site-v1 --input - (stdin pipe)', () => {
    it('reads input from stdin and sends it as query params', async () => {
      server.setRunResponse('get-site-v1', abilityRunSuccess(singleSitePayload));

      const result = await run(
        ['abilities', 'run', 'get-site-v1', '--input', '-', '--json'],
        { stdin: '{"site_id": 5}' },
      );

      expect(result.exitCode).toBe(0);

      const envelope = result.json as { success: boolean; data: Record<string, unknown> };
      expect(envelope.success).toBe(true);

      // Verify the server received site_id in query params (GET for readonly)
      const req = server.getLastRequest('/run');
      expect(req).toBeDefined();
      expect(req!.method).toBe('GET');
      expect(req!.query['input[site_id]']).toBe('5');
    });
  });

  // -------------------------------------------------------------------------
  // 5. --input-file nonexistent.json → exit 1, stderr mentions "not found"
  // -------------------------------------------------------------------------
  describe('--input-file with nonexistent file', () => {
    it('exits 1 with an error mentioning "not found"', async () => {
      const result = await run([
        'abilities', 'run', 'get-site-v1',
        '--input-file', '/tmp/this-file-does-not-exist-mwpctl-test.json',
        '--json',
      ]);

      expect(result.exitCode).toBe(1);

      // In --json mode the error is in stdout as a JSON envelope
      const envelope = result.json as { success: boolean; error?: { message: string } };
      expect(envelope.success).toBe(false);
      expect(envelope.error).toBeDefined();
      expect(envelope.error!.message).toMatch(/not found/i);
    });
  });
});
