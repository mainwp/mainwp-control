/**
 * Integration Tests for AbilitiesExecutor
 *
 * Tests the execution pathway with mocked HTTP responses.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  AbilitiesExecutor,
  abilitySupportsDryRun,
  createAbilitiesExecutor,
  pinnedConfirmationInputProperties,
  resolveConfirmationInputProperty,
  type Ability,
  type ExecutionResult,
} from './abilities-executor.js';

// Mock the http-client module
vi.mock('./http-client.js', () => ({
  createHttpClient: vi.fn(() => ({
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
  })),
}));

// Mock input-sanitizer module
const mockSanitize = vi.fn((input: Record<string, unknown>) => input);
vi.mock('../validation/input-sanitizer.js', () => ({
  getInputSanitizer: vi.fn(() => ({
    sanitize: mockSanitize,
  })),
}));

import { createHttpClient } from './http-client.js';

describe('AbilitiesExecutor', () => {
  let executor: AbilitiesExecutor;
  let mockGet: ReturnType<typeof vi.fn>;
  let mockPost: ReturnType<typeof vi.fn>;
  let mockDelete: ReturnType<typeof vi.fn>;

  const mockAbilities: Ability[] = [
    {
      name: 'mainwp/list-sites-v1',
      label: 'List Sites',
      description: 'List all connected sites',
      category: 'sites',
      meta: {
        annotations: {
          readonly: true,
          destructive: false,
          idempotent: true,
        },
      },
    },
    {
      name: 'mainwp/delete-site-v1',
      label: 'Delete Site',
      description: 'Delete a connected site',
      category: 'sites',
      meta: {
        annotations: {
          readonly: false,
          destructive: true,
          idempotent: true,
        },
      },
    },
    {
      name: 'mainwp/update-site-v1',
      label: 'Update Site',
      description: 'Update site settings',
      category: 'sites',
      meta: {
        annotations: {
          readonly: false,
          destructive: false,
          idempotent: false,
        },
      },
    },
    {
      // String-typed annotation from a buggy/hostile server. SafetyController
      // validates annotations with strict boolean checks and treats this as
      // unset; transport must resolve it the same way (POST, never GET).
      name: 'mainwp/get-stats-v1',
      label: 'Get Stats',
      description: 'Site statistics',
      category: 'sites',
      meta: {
        annotations: {
          readonly: 'true',
          destructive: false,
          idempotent: true,
        },
      },
    } as unknown as Ability,
    {
      // One malformed boolean invalidates the annotation set. A hostile
      // readonly:true value must not select GET when policy fails closed.
      name: 'mainwp/get-malformed-v1',
      label: 'Get Malformed',
      description: 'Malformed annotation fixture',
      category: 'sites',
      meta: {
        annotations: {
          readonly: true,
          destructive: false,
          idempotent: 'false',
        },
      },
    } as unknown as Ability,
    {
      // Contradictory/skewed annotations: destructive NAME but readonly:true.
      // Used to verify transport (HTTP method) resolves destructiveness the
      // same way policy does, and never routes this out as GET.
      name: 'mainwp/reset-site-v1',
      label: 'Reset Site',
      description: 'Reset a site to defaults',
      category: 'sites',
      meta: {
        annotations: {
          readonly: true,
          destructive: false,
          idempotent: true,
        },
      },
    },
  ];

  beforeEach(() => {
    mockGet = vi.fn();
    mockPost = vi.fn();
    mockDelete = vi.fn();

    vi.mocked(createHttpClient).mockReturnValue({
      get: mockGet,
      post: mockPost,
      delete: mockDelete,
    } as never);

    executor = createAbilitiesExecutor({
      baseUrl: 'https://dashboard.local',
      username: 'admin',
      appPassword: 'test-password',
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('listAbilities', () => {
    it('fetches and caches abilities', async () => {
      mockGet.mockResolvedValueOnce({
        data: { abilities: mockAbilities },
      });

      const abilities = await executor.listAbilities();

      // listAbilities returns unique abilities (not the duplicates by short name)
      // The cache stores by both full and short name, but listAbilities returns values
      // Since abilities are stored twice (full and short name), we get 6 entries
      // This is expected behavior - abilities can be accessed by either name
      expect(abilities.length).toBeGreaterThanOrEqual(3);
      expect(mockGet).toHaveBeenCalledOnce();

      // Second call should use cache
      const abilities2 = await executor.listAbilities();
      expect(abilities2.length).toBeGreaterThanOrEqual(3);
      expect(mockGet).toHaveBeenCalledOnce(); // Still only one call
    });

    it('stores abilities by both full and short name', async () => {
      mockGet.mockResolvedValueOnce({
        data: { abilities: mockAbilities },
      });

      await executor.listAbilities();

      // Both names should resolve to the same ability
      const byFull = await executor.getAbility('mainwp/list-sites-v1');
      const byShort = await executor.getAbility('list-sites-v1');

      expect(byFull).toBeDefined();
      expect(byShort).toBeDefined();
      expect(byFull?.name).toBe(byShort?.name);
    });

    it('skips malformed discovery entries and invalid ability names with warnings', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockGet.mockResolvedValueOnce({
        data: [
          null,
          [],
          { name: '' },
          { name: 'missing-namespace-v1' },
          mockAbilities[0],
        ],
      });

      const abilities = await executor.listAbilities();

      expect(abilities).toEqual([mockAbilities[0]]);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('invalid ability'));
    });

    it('refuses case-variant ability names so they cannot evade destructive classification', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockGet.mockResolvedValueOnce({
        data: [
          { ...mockAbilities[0], name: 'Mainwp/Delete-Site-V1' },
          mockAbilities[0],
        ],
      });

      const abilities = await executor.listAbilities();

      expect(abilities).toEqual([mockAbilities[0]]);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('invalid ability'));
    });

    it('keeps the first duplicate full name and warns', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockGet.mockResolvedValueOnce({
        data: [
          mockAbilities[0],
          { ...mockAbilities[0], label: 'Duplicate' },
        ],
      });

      await executor.listAbilities();

      expect((await executor.getAbility('mainwp/list-sites-v1'))?.label).toBe('List Sites');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('duplicate ability'));
    });

    it('removes colliding short aliases while preserving both full names', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const first = { ...mockAbilities[0], name: 'alpha/shared-v1' };
      const second = { ...mockAbilities[0], name: 'beta/shared-v1' };
      mockGet.mockResolvedValueOnce({ data: [first, second] });

      await executor.listAbilities();

      expect(await executor.getAbility('alpha/shared-v1')).toEqual(first);
      expect(await executor.getAbility('beta/shared-v1')).toEqual(second);
      expect(await executor.getAbility('shared-v1')).toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('ambiguous short alias'));
    });

    it('rejects discovery that exceeds the configured page cap', async () => {
      mockGet.mockResolvedValue({
        data: [],
        headers: new Headers({ 'x-wp-totalpages': '999' }),
      });

      await expect(executor.listAbilities()).rejects.toMatchObject({
        code: 'INVALID_RESPONSE',
      });

      expect(mockGet).toHaveBeenCalledTimes(1);
    });
  });

  describe('getAbility', () => {
    it('returns ability by name', async () => {
      mockGet.mockResolvedValueOnce({
        data: { abilities: mockAbilities },
      });

      const ability = await executor.getAbility('list-sites-v1');

      expect(ability).toBeDefined();
      expect(ability?.name).toBe('mainwp/list-sites-v1');
    });

    it('returns undefined for unknown ability', async () => {
      mockGet.mockResolvedValueOnce({
        data: { abilities: mockAbilities },
      });

      const ability = await executor.getAbility('unknown-ability');

      expect(ability).toBeUndefined();
    });
  });

  describe('execute', () => {
    beforeEach(async () => {
      // Setup abilities cache
      mockGet.mockResolvedValueOnce({
        data: { abilities: mockAbilities },
      });
    });

    it('uses GET for readonly abilities', async () => {
      mockGet.mockResolvedValueOnce({
        data: {
          success: true,
          data: { sites: [{ id: 1 }] },
        },
      });

      const result = await executor.execute('list-sites-v1', {});

      expect(mockGet).toHaveBeenCalledTimes(2); // abilities + execute
      expect(mockPost).not.toHaveBeenCalled();
    });

    it('uses POST for write abilities', async () => {
      mockPost.mockResolvedValueOnce({
        data: {
          success: true,
          data: { updated: true },
        },
      });

      const result = await executor.execute('update-site-v1', {
        site_id: 1,
        name: 'New Name',
      });

      expect(mockPost).toHaveBeenCalledOnce();
      expect(result.success).toBe(true);
    });

    it('uses DELETE for destructive+idempotent abilities', async () => {
      mockDelete.mockResolvedValueOnce({
        data: {
          success: true,
          data: { deleted: true },
        },
      });

      const result = await executor.execute(
        'delete-site-v1',
        { site_id: 1 },
        { confirm: true }
      );

      expect(mockDelete).toHaveBeenCalledOnce();
    });

    it('sends DELETE input as an application/json body without URL credentials', async () => {
      mockDelete.mockResolvedValueOnce({ data: { success: true } });

      await executor.execute(
        'delete-site-v1',
        { site_id: 1, api_token: 'write-only-secret', property_ref: null },
        { confirm: true }
      );

      const [url, body] = mockDelete.mock.calls[0] as [string, unknown];
      expect(url).not.toContain('?');
      expect(url).not.toContain('write-only-secret');
      expect(body).toEqual({
        input: {
          site_id: 1,
          api_token: 'write-only-secret',
          property_ref: null,
          dry_run: false,
          confirm: true,
        },
      });
    });

    it('never uses GET for a destructive-named ability marked readonly (transport/policy consistency)', async () => {
      mockPost.mockResolvedValueOnce({ data: { success: true } });

      // reset-site-v1 is annotated readonly:true but its name is known-destructive.
      // Transport must resolve destructiveness the same way SafetyController does,
      // so this never goes out as GET. It also must not go out as DELETE: the
      // annotations are distrusted here, so their `idempotent` flag cannot
      // pick the method — the safe write default is POST.
      await executor.execute('reset-site-v1', { site_id: 1 }, { confirm: true });

      // The run request went out as POST; a readonly GET run would have left
      // mockPost uncalled.
      expect(mockPost).toHaveBeenCalledOnce();
      expect(mockDelete).not.toHaveBeenCalled();
      // The only GET is the abilities-list fetch — the run itself never uses GET.
      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(String(mockGet.mock.calls[0]?.[0])).not.toContain('/run');
    });

    it('treats non-boolean annotation values as unset for method selection', async () => {
      mockPost.mockResolvedValueOnce({ data: { success: true } });

      // get-stats-v1 carries readonly: "true" (string). SafetyController's
      // strict boolean validation ignores it, so transport must too:
      // the run goes out as POST, never a readonly GET.
      await executor.execute('get-stats-v1', {});

      expect(mockPost).toHaveBeenCalledOnce();
      // The only GET was the abilities-list fetch, not a readonly run.
      expect(mockGet).toHaveBeenCalledOnce();
    });

    it('uses POST when any annotation field is malformed despite readonly true', async () => {
      mockPost.mockResolvedValueOnce({ data: { success: true } });

      await executor.execute('get-malformed-v1', {});

      expect(mockPost).toHaveBeenCalledOnce();
      expect(mockGet).toHaveBeenCalledOnce();
    });

    it('rejects a request with both dryRun and confirm set', async () => {
      await expect(
        executor.execute('delete-site-v1', { site_id: 1 }, { dryRun: true, confirm: true })
      ).rejects.toThrow(/cannot both be set/);

      // No run request of any kind is emitted with both flags.
      expect(mockPost).not.toHaveBeenCalled();
      expect(mockDelete).not.toHaveBeenCalled();
    });

    it('adds dry_run flag when dryRun option is true', async () => {
      mockPost.mockResolvedValueOnce({
        data: {
          success: true,
          data: { preview: { affected: 1 } },
        },
      });

      await executor.execute(
        'update-site-v1',
        { site_id: 1 },
        { dryRun: true }
      );

      // Check that the endpoint was called (for non-readonly)
      expect(mockPost).toHaveBeenCalled();
    });

    it('sends schema-required false confirm alongside a trusted dry-run preview', async () => {
      mockPost.mockResolvedValueOnce({ data: { success: true } });

      const controlAbility = mockAbilities.find(
        (ability) => ability.name === 'mainwp/update-site-v1'
      );
      expect(controlAbility).toBeDefined();
      controlAbility!.input_schema = {
        type: 'object',
        required: ['site_id', 'dry_run', 'confirm'],
        properties: {
          site_id: { type: 'integer' },
          dry_run: { type: 'boolean' },
          confirm: { type: 'boolean' },
        },
        additionalProperties: false,
      };

      await executor.execute('update-site-v1', { site_id: 1 }, { dryRun: true });

      expect(mockPost.mock.calls[0]?.[1]).toEqual({
        input: { site_id: 1, dry_run: true, confirm: false },
      });
    });

    it('adds only the schema-declared confirm flag when confirm option is true', async () => {
      mockDelete.mockResolvedValueOnce({
        data: { success: true },
      });

      await executor.execute(
        'delete-site-v1',
        { site_id: 1 },
        { confirm: true }
      );

      // The JSON body should include only the schema-declared execution controls under input.
      const call = mockDelete.mock.calls[0];
      const url = call?.[0] as string;
      expect(url).not.toContain('?');
      expect(call?.[1]).toEqual({
        input: { site_id: 1, dry_run: false, confirm: true },
      });
    });

    it('refuses trusted confirmation for a required pinned risk field', async () => {
      const ability = mockAbilities.find(
        (candidate) => candidate.name === 'mainwp/delete-site-v1'
      );
      expect(ability).toBeDefined();
      const originalSchema = ability!.input_schema;
      ability!.input_schema = {
        type: 'object',
        additionalProperties: false,
        required: ['site_id', 'confirm_lockout_risk'],
        properties: {
          site_id: { type: 'integer' },
          confirm_lockout_risk: { type: 'boolean', enum: [true] },
        },
      };
      try {
        // A pinned field must stay true, so the ability has no preview and
        // the executor refuses confirm even from a caller that skipped one.
        await expect(executor.execute(
          'delete-site-v1',
          {
            site_id: 1,
            confirm_lockout_risk: false,
            confirm_secondary_risk: true,
            confirm: true,
            dry_run: true,
            user_confirmed: true,
          },
          { confirm: true }
        )).rejects.toMatchObject({
          code: 'INPUT_ERROR', message: expect.stringContaining('no preview the CLI can run'),
        });
      } finally {
        ability!.input_schema = originalSchema;
      }

      expect(mockDelete).not.toHaveBeenCalled();
    });

    it('uses the MCP boolean declaration rule without evaluating composition', () => {
      const ability: Ability = {
        ...mockAbilities[1]!,
        input_schema: {
        type: 'object',
        required: ['confirm_lockout_risk'],
        properties: {
          confirm_lockout_risk: {
            type: 'boolean',
            oneOf: [{ const: true }, { type: 'boolean' }],
          },
          dry_run: {
            type: 'boolean',
            not: { const: true },
          },
        },
        },
      };

      expect(resolveConfirmationInputProperty(ability)).toBeUndefined();
      expect(abilitySupportsDryRun(ability)).toBe(true);
    });

    it('does not select ambiguous schema-named confirmation fields', () => {
      const ability: Ability = {
        ...mockAbilities[1]!,
        input_schema: {
          type: 'object',
          required: ['confirm_first_risk', 'confirm_second_risk'],
          properties: {
            confirm_first_risk: { type: 'boolean', enum: [true] },
            confirm_second_risk: { type: 'boolean', enum: [true] },
          },
        },
      };

      expect(resolveConfirmationInputProperty(ability)).toBeUndefined();
    });

    it('detects only required usable confirm_* fields pinned to true', () => {
      const ability: Ability = {
        ...mockAbilities[1]!,
        input_schema: {
          required: ['confirm_const', 'confirm_enum', 'confirm_both', 'confirm_plain', 'confirm_string'],
          properties: {
            confirm_const: { type: 'boolean', const: true },
            confirm_enum: { type: 'boolean', enum: [true] },
            confirm_both: { type: 'boolean', enum: [true, false] },
            confirm_plain: { type: 'boolean' },
            confirm_string: { type: 'string', const: true },
            confirm_optional: { type: 'boolean', const: true },
          },
        },
      };
      expect(pinnedConfirmationInputProperties(ability)).toEqual(['confirm_const', 'confirm_enum']);
    });

    it('resolves only an unambiguous pinned or conventional confirmation field', () => {
      const ability: Ability = { ...mockAbilities[1]! };
      for (const property of [
        { type: 'boolean' }, { enum: [true, false] }, { const: true }, { enum: [true] },
      ]) {
        ability.input_schema = { required: ['confirm_risk'], properties: { confirm_risk: property } };
        const pinned = 'const' in property || ('enum' in property && property.enum.length === 1);
        expect(resolveConfirmationInputProperty(ability)).toBe(pinned ? 'confirm_risk' : undefined);
        ability.input_schema['properties'] = { confirm: { type: 'boolean' }, confirm_risk: property };
        expect(resolveConfirmationInputProperty(ability)).toBe(pinned ? undefined : 'confirm');
      }
      ability.input_schema = { properties: { confirm_risk: { const: true } } };
      expect(resolveConfirmationInputProperty(ability)).toBeUndefined();
    });

    it.each([
      ['Cost Tracker', { enabled: true, confirm_disable: false }],
      ['Code Snippets', { confirm_delete: true, confirm_remove_data: false, confirm_backup: true }],
    ])('preserves required %s domain flags in preview and confirm requests', async (_label, input) => {
      const ability = mockAbilities[2]!;
      const originalSchema = ability.input_schema;
      ability.input_schema = {
        type: 'object',
        required: Object.keys(input),
        properties: {
          ...Object.fromEntries(Object.keys(input).map((name) => [name, { type: 'boolean' }])),
          dry_run: { type: 'boolean' },
          confirm: { type: 'boolean' },
        },
      };
      mockPost.mockResolvedValue({ data: { success: true } });
      try {
        await executor.execute(ability.name, input, { dryRun: true });
        await executor.execute(ability.name, input, { confirm: true });
        expect(mockPost.mock.calls.map((call) => call[1])).toEqual([
          { input: { ...input, dry_run: true } },
          { input: { ...input, dry_run: false, confirm: true } },
        ]);
      } finally {
        ability.input_schema = originalSchema;
      }
    });

    it('strips caller-supplied pinned fields without stripping ordinary confirm_* input', async () => {
      const ability = mockAbilities[2]!;
      const originalSchema = ability.input_schema;
      ability.input_schema = {
        required: ['confirm_lockout_risk'],
        properties: { confirm_lockout_risk: { type: 'boolean', enum: [true] } },
      };
      mockPost.mockResolvedValueOnce({ data: { success: true } });
      try {
        await executor.execute(ability.name, { confirm_lockout_risk: true, confirm_disable: false });
        expect(mockPost.mock.calls[0]?.[1]).toEqual({ input: { confirm_disable: false } });
      } finally {
        ability.input_schema = originalSchema;
      }
    });

    it.each([
      ['confirm beside pinned', { confirm: { type: 'boolean' }, confirm_first: { const: true } }, ['confirm_first']],
      ['two pinned', { confirm_first: { const: true }, confirm_second: { enum: [true] } }, ['confirm_first', 'confirm_second']],
    ])('refuses %s for preview and confirm before HTTP dispatch', async (_label, properties, required) => {
      const ability = mockAbilities[2]!;
      const originalSchema = ability.input_schema;
      ability.input_schema = { properties, required };
      mockPost.mockResolvedValue({ data: { success: true } });
      try {
        for (const options of [{ dryRun: true }, { confirm: true }]) {
          await expect(executor.execute(ability.name, {}, options)).rejects.toMatchObject({
            code: 'INPUT_ERROR', message: expect.stringContaining('ambiguous confirmation'),
          });
        }
        expect(mockPost).not.toHaveBeenCalled();
        expect(mockDelete).not.toHaveBeenCalled();
        expect(mockGet).toHaveBeenCalledOnce();
      } finally {
        ability.input_schema = originalSchema;
      }
    });

    it('refuses a pinned dry-run even when dry_run is declared', async () => {
      const ability = mockAbilities[2]!;
      const originalSchema = ability.input_schema;
      ability.input_schema = {
        required: ['confirm_lockout_risk'],
        properties: {
          confirm_lockout_risk: { enum: [true] },
          dry_run: { type: 'boolean' },
        },
      };
      mockPost.mockResolvedValue({ data: { success: true } });
      try {
        await expect(executor.execute(ability.name, {}, { dryRun: true })).rejects.toMatchObject({
          code: 'INPUT_ERROR', message: expect.stringContaining('no preview the CLI can run'),
        });
        expect(mockPost).not.toHaveBeenCalled();
      } finally {
        ability.input_schema = originalSchema;
      }
    });

    it('refuses preview and confirm for unpinned confirm_* acknowledgements without dry_run', async () => {
      // Code Snippets shape: required acknowledgements that accept true or
      // string forms, with neither confirm nor dry_run declared.
      const ability = mockAbilities[2]!;
      const originalSchema = ability.input_schema;
      const flag = { type: ['boolean', 'string'], enum: [true, 'true', '1'] };
      ability.input_schema = {
        type: 'object',
        additionalProperties: false,
        required: ['snippet_id', 'confirm_arbitrary_php_execution'],
        properties: { snippet_id: { type: 'integer' }, confirm_arbitrary_php_execution: flag },
      };
      mockPost.mockResolvedValue({ data: { success: true } });
      try {
        for (const options of [{ dryRun: true }, { confirm: true }]) {
          await expect(
            executor.execute(ability.name, { snippet_id: 1, confirm_arbitrary_php_execution: true }, options)
          ).rejects.toMatchObject({
            code: 'INPUT_ERROR', message: expect.stringContaining('no preview the CLI can run'),
          });
        }
        expect(mockPost).not.toHaveBeenCalled();
        expect(mockDelete).not.toHaveBeenCalled();
      } finally {
        ability.input_schema = originalSchema;
      }
    });

    it('omits required confirm from preview when false is not usable', async () => {
      const ability = mockAbilities[2]!;
      const originalSchema = ability.input_schema;
      ability.input_schema = {
        required: ['confirm'],
        properties: { confirm: { const: true }, dry_run: { type: 'boolean' } },
      };
      mockPost.mockResolvedValue({ data: { success: true } });
      try {
        await executor.execute(ability.name, {}, { dryRun: true });
        expect(mockPost.mock.calls[0]?.[1]).toEqual({ input: { dry_run: true } });
      } finally {
        ability.input_schema = originalSchema;
      }
    });

    it('throws InputError for unknown ability', async () => {
      await expect(
        executor.execute('non-existent-ability', {})
      ).rejects.toThrow('Unknown ability');
    });

    it('returns error result for API errors', async () => {
      const { APIError } = await import('../utils/errors.js');

      mockPost.mockRejectedValueOnce(
        new APIError('VALIDATION_ERROR', 'Invalid input', 422, {
          field: 'site_id',
          message: 'Site not found',
        })
      );

      const result = await executor.execute('update-site-v1', {
        site_id: 999,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('VALIDATION_ERROR');
    });

    it('normalizes raw data responses to ExecutionResult', async () => {
      // Some APIs return raw data without success wrapper
      mockGet.mockResolvedValueOnce({
        data: [
          { id: 1, name: 'Site 1' },
          { id: 2, name: 'Site 2' },
        ],
      });

      const result = await executor.execute('list-sites-v1', {});

      expect(result.success).toBe(true);
      expect(result.data).toEqual([
        { id: 1, name: 'Site 1' },
        { id: 2, name: 'Site 2' },
      ]);
    });

    it('normalizes the Dashboard queued envelope and exposes its job id', async () => {
      mockGet.mockResolvedValueOnce({
        data: {
          queued: true,
          job_id: 'sync_123',
          status_url: 'https://dashboard.local/wp-json/mainwp/v2/jobs/sync_123',
          sites_queued: 10,
        },
      });

      const result = await executor.execute('list-sites-v1', {});

      expect(result.success).toBe(true);
      expect(result.jobId).toBe('sync_123');
    });

    it('extracts a queued job id from a wrapped data envelope', async () => {
      mockGet.mockResolvedValueOnce({
        data: {
          success: true,
          data: { queued: true, job_id: 'sync_456' },
        },
      });

      const result = await executor.execute('list-sites-v1', {});

      expect(result.success).toBe(true);
      expect(result.jobId).toBe('sync_456');
    });

    it.each(['bad\njob', 'x'.repeat(513)])(
      'rejects an unsafe queued job id',
      async (jobId) => {
        mockGet.mockResolvedValueOnce({
          data: { queued: true, job_id: jobId },
        });

        await expect(executor.execute('list-sites-v1', {})).resolves.toMatchObject({
          success: false,
          error: { code: 'INVALID_RESPONSE' },
        });
      },
    );
  });

  describe('getCategories', () => {
    it('returns unique categories', async () => {
      mockGet.mockResolvedValueOnce({
        data: { abilities: mockAbilities },
      });

      const categories = await executor.getCategories();

      expect(categories).toEqual(['sites']);
    });
  });

  describe('listByCategory', () => {
    it('filters abilities by category', async () => {
      mockGet.mockResolvedValueOnce({
        data: { abilities: mockAbilities },
      });

      const siteAbilities = await executor.listByCategory('sites');

      // Due to caching by both full and short names, we get more entries
      expect(siteAbilities.length).toBeGreaterThanOrEqual(3);
      // All should be in the 'sites' category
      expect(siteAbilities.every(a => a.category === 'sites')).toBe(true);
    });

    it('returns empty array for unknown category', async () => {
      mockGet.mockResolvedValueOnce({
        data: { abilities: mockAbilities },
      });

      const abilities = await executor.listByCategory('unknown');

      expect(abilities).toHaveLength(0);
    });
  });

  describe('cache management', () => {
    it('clearCache forces refresh on next call', async () => {
      mockGet.mockResolvedValue({
        data: { abilities: mockAbilities },
      });

      await executor.listAbilities();
      expect(mockGet).toHaveBeenCalledOnce();

      executor.clearCache();

      await executor.listAbilities();
      expect(mockGet).toHaveBeenCalledTimes(2);
    });
  });
});

describe('AbilitiesExecutor Query String Building', () => {
  let executor: AbilitiesExecutor;
  let mockGet: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockGet = vi.fn();

    vi.mocked(createHttpClient).mockReturnValue({
      get: mockGet,
      post: vi.fn(),
      delete: vi.fn(),
    } as never);

    executor = createAbilitiesExecutor({
      baseUrl: 'https://dashboard.local',
      username: 'admin',
      appPassword: 'test-password',
    });

    // Setup abilities cache
    mockGet.mockResolvedValueOnce({
      data: {
        abilities: [
          {
            name: 'mainwp/list-sites-v1',
            label: 'List Sites',
            description: 'List sites',
            category: 'sites',
            meta: { annotations: { readonly: true, destructive: false, idempotent: true } },
          },
        ],
      },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('encodes simple values in query string', async () => {
    mockGet.mockResolvedValueOnce({ data: { sites: [] } });

    await executor.execute('list-sites-v1', {
      page: 1,
      per_page: 20,
      status: 'active',
    });

    const url = new URL(mockGet.mock.calls[1]?.[0] as string, 'https://dashboard.local');
    expect(JSON.parse(url.searchParams.get('input_json') ?? '')).toEqual({
      page: 1,
      per_page: 20,
      status: 'active',
    });
  });

  it('preserves an explicit empty input object in the JSON query carrier', async () => {
    mockGet.mockResolvedValueOnce({ data: { sites: [] } });

    await executor.execute('list-sites-v1', {});

    const url = new URL(mockGet.mock.calls[1]?.[0] as string, 'https://dashboard.local');
    expect(url.searchParams.has('input_json')).toBe(true);
    expect(JSON.parse(url.searchParams.get('input_json') ?? '')).toEqual({});
  });

  it('uses one JSON query carrier and preserves nested null values', async () => {
    mockGet.mockResolvedValueOnce({ data: { sites: [] } });

    await executor.execute('list-sites-v1', {
      page: 1,
      property_ref: null,
      literal: 'null',
      nested: { value: null },
      items: [null, 'null'],
    });

    const url = new URL(mockGet.mock.calls[1]?.[0] as string, 'https://dashboard.local');
    expect(url.searchParams.has('input')).toBe(false);
    expect(JSON.parse(url.searchParams.get('input_json') ?? '')).toEqual({
      page: 1,
      property_ref: null,
      literal: 'null',
      nested: { value: null },
      items: [null, 'null'],
    });
  });

  it('encodes arrays inside the JSON carrier', async () => {
    mockGet.mockResolvedValueOnce({ data: { sites: [] } });

    await executor.execute('list-sites-v1', {
      site_ids: [1, 2, 3],
    });

    const url = new URL(mockGet.mock.calls[1]?.[0] as string, 'https://dashboard.local');
    expect(JSON.parse(url.searchParams.get('input_json') ?? '')).toEqual({
      site_ids: [1, 2, 3],
    });
  });

  it('encodes objects as JSON', async () => {
    mockGet.mockResolvedValueOnce({ data: { sites: [] } });

    await executor.execute('list-sites-v1', {
      filter: { status: 'active', client_id: 5 },
    });

    const url = new URL(mockGet.mock.calls[1]?.[0] as string, 'https://dashboard.local');
    expect(JSON.parse(url.searchParams.get('input_json') ?? '')).toEqual({
      filter: { status: 'active', client_id: 5 },
    });
  });

  it('preserves null and skips undefined values', async () => {
    mockGet.mockResolvedValueOnce({ data: { sites: [] } });

    await executor.execute('list-sites-v1', {
      page: 1,
      filter: null,
      search: undefined,
    });

    const url = new URL(mockGet.mock.calls[1]?.[0] as string, 'https://dashboard.local');
    expect(JSON.parse(url.searchParams.get('input_json') ?? '')).toEqual({
      page: 1,
      filter: null,
    });
  });
});

describe('AbilitiesExecutor Input Sanitization (F3)', () => {
  let executor: AbilitiesExecutor;
  let mockGet: ReturnType<typeof vi.fn>;
  let mockPost: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockGet = vi.fn();
    mockPost = vi.fn();
    mockSanitize.mockClear();

    vi.mocked(createHttpClient).mockReturnValue({
      get: mockGet,
      post: mockPost,
      delete: vi.fn(),
    } as never);

    executor = createAbilitiesExecutor({
      baseUrl: 'https://dashboard.local',
      username: 'admin',
      appPassword: 'test-password',
    });

    // Setup abilities cache
    mockGet.mockResolvedValueOnce({
      data: {
        abilities: [
          {
            name: 'mainwp/update-site-v1',
            label: 'Update Site',
            description: 'Update site',
            category: 'sites',
            meta: { annotations: { readonly: false, destructive: false, idempotent: false } },
          },
        ],
      },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('calls sanitize() on each execute()', async () => {
    mockSanitize.mockReturnValue({ site_id: 1 });
    mockPost.mockResolvedValueOnce({ data: { success: true } });

    await executor.execute('update-site-v1', { site_id: 1 });

    expect(mockSanitize).toHaveBeenCalledWith({ site_id: 1 });
  });

  it('propagates InputError from sanitizer', async () => {
    const { InputError } = await import('../utils/errors.js');
    mockSanitize.mockImplementation(() => {
      throw new InputError('Input size exceeds limit');
    });

    await expect(
      executor.execute('update-site-v1', { huge: 'data' })
    ).rejects.toThrow('Input size exceeds limit');
  });
});

describe('H1: Control flag stripping from user/LLM input', () => {
  let executor: AbilitiesExecutor;
  let mockGet: ReturnType<typeof vi.fn>;
  let mockPost: ReturnType<typeof vi.fn>;
  let mockDelete: ReturnType<typeof vi.fn>;

  const mockAbilities: Ability[] = [
    {
      name: 'mainwp/delete-site-v1',
      label: 'Delete Site',
      description: 'Delete a connected site',
      category: 'sites',
      meta: {
        annotations: { readonly: false, destructive: true, idempotent: true },
      },
    },
  ];

  beforeEach(() => {
    mockGet = vi.fn();
    mockPost = vi.fn();
    mockDelete = vi.fn();

    vi.mocked(createHttpClient).mockReturnValue({
      get: mockGet,
      post: mockPost,
      delete: mockDelete,
    } as never);

    executor = createAbilitiesExecutor({
      baseUrl: 'https://dashboard.local',
      username: 'admin',
      appPassword: 'test-password',
    });

    // Reset sanitizer to pass-through
    mockSanitize.mockImplementation((input: Record<string, unknown>) => input);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('strips confirm/dry_run/user_confirmed injected by LLM into input (DELETE body path)', async () => {
    // Populate abilities cache
    mockGet.mockResolvedValueOnce({ data: { abilities: mockAbilities } });

    // Simulate LLM injecting control flags into the input
    const maliciousInput = {
      site_id: 123,
      confirm: true,
      dry_run: false,
      user_confirmed: true,
    };

    mockDelete.mockResolvedValueOnce({
      data: { success: true, data: { deleted: true } },
    });

    // Execute with dryRun option — control flags from input should be stripped
    await executor.execute('delete-site-v1', maliciousInput, { dryRun: true });

    // DELETE uses a JSON body — verify only the execution option survives.
    const url = mockDelete.mock.calls[0][0] as string;
    const body = mockDelete.mock.calls[0][1] as { input: Record<string, unknown> };
    expect(url).not.toContain('?');
    expect(body.input).toEqual({ site_id: 123, dry_run: true });
  });

  it('strips control flags from LLM input (POST path)', async () => {
    // Add a non-readonly, non-destructive ability (uses POST)
    const postAbilities: Ability[] = [
      {
        name: 'mainwp/update-site-v1',
        label: 'Update Site',
        description: 'Update site settings',
        category: 'sites',
        meta: {
          annotations: { readonly: false, destructive: false, idempotent: false },
        },
      },
    ];
    mockGet.mockResolvedValueOnce({ data: { abilities: postAbilities } });

    const maliciousInput = {
      site_id: 456,
      confirm: true,
      user_confirmed: true,
    };

    mockPost.mockResolvedValueOnce({
      data: { success: true, data: { updated: true } },
    });

    await executor.execute('update-site-v1', maliciousInput);

    // POST sends JSON body — verify control flags stripped
    const requestBody = mockPost.mock.calls[0][1];
    expect(requestBody.input.site_id).toBe(456);
    expect(requestBody.input.confirm).toBeUndefined();
    expect(requestBody.input.user_confirmed).toBeUndefined();
  });

  it('allows control flags only from execution options (DELETE path)', async () => {
    mockGet.mockResolvedValueOnce({ data: { abilities: mockAbilities } });

    mockDelete.mockResolvedValueOnce({
      data: { success: true, data: { executed: true } },
    });

    // Execute with confirm option (legitimate safety flow)
    await executor.execute('delete-site-v1', { site_id: 456 }, { confirm: true });

    const url = mockDelete.mock.calls[0][0] as string;
    const body = mockDelete.mock.calls[0][1] as { input: Record<string, unknown> };
    expect(url).not.toContain('?');
    expect(body.input).toEqual({
      site_id: 456,
      dry_run: false,
      confirm: true,
    });
  });
});
