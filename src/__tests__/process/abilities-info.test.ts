/**
 * Process-level tests for the `abilities info` command
 *
 * Verifies that `mainwpctl abilities info <name>` correctly fetches and
 * displays details for a specific ability. The command populates its cache
 * by calling listAbilities, then looks up the requested ability by name.
 * Each test runs mainwpctl as a child process against a mock HTTP server.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { MockServer } from './fixtures/mock-server.js';
import { runCLI } from './fixtures/cli-runner.js';
import { ConfigDir } from './fixtures/config-dir.js';
import { STANDARD_ABILITIES } from './fixtures/api-responses.js';

describe('abilities info command', () => {
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
  // 1. Human-readable output: exit 0, stdout shows ability details
  // ---------------------------------------------------------------------------

  it('abilities info list-sites-v1 exits 0 and shows name/description', async () => {
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

    const result = await runCLI(['abilities', 'info', 'list-sites-v1'], {
      xdgConfigHome: configDir.xdgHome,
      env: { MAINWP_APP_PASSWORD: 'test-pass' },
    });

    expect(result.exitCode).toBe(0);

    const output = result.stdout;

    // The command shows the ability name and description
    expect(output).toContain('mainwp/list-sites-v1');
    expect(output).toContain('list-sites-v1');

    // Annotations section should be present
    expect(output).toMatch(/readonly/i);
    expect(output).toMatch(/destructive/i);
    expect(output).toMatch(/idempotent/i);

    // Category should appear
    expect(output).toContain('sites');
  });

  // ---------------------------------------------------------------------------
  // 2. JSON output: exit 0, valid JSON with ability details
  // ---------------------------------------------------------------------------

  it('abilities info list-sites-v1 --json exits 0 with valid JSON envelope', async () => {
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
      ['abilities', 'info', 'list-sites-v1', '--json'],
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
        name: string;
        label: string;
        description: string;
        category: string;
        annotations: {
          readonly: boolean;
          destructive: boolean;
          idempotent: boolean;
        };
        inputSchema: Record<string, unknown>;
      };
    };

    // Verify envelope structure
    expect(envelope.success).toBe(true);
    expect(envelope.data).toBeDefined();

    // Verify ability details
    expect(envelope.data.name).toBe('mainwp/list-sites-v1');
    expect(envelope.data.category).toBe('sites');
    expect(typeof envelope.data.label).toBe('string');
    expect(typeof envelope.data.description).toBe('string');

    // Verify annotations
    expect(envelope.data.annotations).toBeDefined();
    expect(envelope.data.annotations.readonly).toBe(true);
    expect(envelope.data.annotations.destructive).toBe(false);
    expect(envelope.data.annotations.idempotent).toBe(false);

    // Input schema should be present (even if minimal)
    expect(envelope.data.inputSchema).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // 3. JSON output for ability with input schema details
  // ---------------------------------------------------------------------------

  it('abilities info get-site-v1 --json includes input schema with required fields', async () => {
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
      ['abilities', 'info', 'get-site-v1', '--json'],
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
        name: string;
        inputSchema: {
          type: string;
          properties: Record<string, unknown>;
          required: string[];
        };
      };
    };

    expect(envelope.success).toBe(true);
    expect(envelope.data.name).toBe('mainwp/get-site-v1');

    // get-site-v1 has site_id as a required input parameter
    expect(envelope.data.inputSchema.type).toBe('object');
    expect(envelope.data.inputSchema.properties).toHaveProperty('site_id');
    expect(envelope.data.inputSchema.required).toContain('site_id');
  });

  // ---------------------------------------------------------------------------
  // 4. Full namespace name also works
  // ---------------------------------------------------------------------------

  it('abilities info mainwp/delete-site-v1 resolves fully-qualified name', async () => {
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
      ['abilities', 'info', 'mainwp/delete-site-v1', '--json'],
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
        name: string;
        annotations: {
          destructive: boolean;
        };
      };
    };

    expect(envelope.success).toBe(true);
    expect(envelope.data.name).toBe('mainwp/delete-site-v1');
    expect(envelope.data.annotations.destructive).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 5. Nonexistent ability: exit 1 (INPUT_ERROR)
  // ---------------------------------------------------------------------------

  it('abilities info nonexistent-v1 exits 1', async () => {
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

    const result = await runCLI(['abilities', 'info', 'nonexistent-v1'], {
      xdgConfigHome: configDir.xdgHome,
      env: { MAINWP_APP_PASSWORD: 'test-pass' },
    });

    expect(result.exitCode).toBe(1);

    // Error output should mention the ability was not found
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/not found/i);
  });

  // ---------------------------------------------------------------------------
  // 6. Nonexistent ability with --json: exit 1, JSON error envelope
  // ---------------------------------------------------------------------------

  it('abilities info nonexistent-v1 --json exits 1 with error envelope', async () => {
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
      ['abilities', 'info', 'nonexistent-v1', '--json'],
      {
        xdgConfigHome: configDir.xdgHome,
        env: { MAINWP_APP_PASSWORD: 'test-pass' },
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.json).toBeDefined();

    const envelope = result.json as {
      success: boolean;
      error: {
        code: string;
        message: string;
      };
    };

    expect(envelope.success).toBe(false);
    expect(envelope.error).toBeDefined();
    expect(envelope.error.code).toBe('INPUT_ERROR');
    expect(envelope.error.message).toMatch(/not found/i);
  });
});
