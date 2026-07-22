/**
 * Integration Tests for AbilitiesExecutor
 *
 * Tests the execution pathway with mocked HTTP responses.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  AbilitiesExecutor,
  createAbilitiesExecutor,
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

    it('adds confirm and user_confirmed flags when confirm option is true', async () => {
      mockDelete.mockResolvedValueOnce({
        data: { success: true },
      });

      await executor.execute(
        'delete-site-v1',
        { site_id: 1 },
        { confirm: true }
      );

      // The query params should include confirm and user_confirmed under input[]
      const call = mockDelete.mock.calls[0];
      const url = call?.[0] as string;
      expect(url).toContain('input[confirm]=true');
      expect(url).toContain('input[user_confirmed]=true');
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

    // Input params are nested under input[key] for the WP Abilities API
    const url = mockGet.mock.calls[1]?.[0] as string;
    expect(url).toContain('input[page]=1');
    expect(url).toContain('input[per_page]=20');
    expect(url).toContain('input[status]=active');
  });

  it('encodes arrays with WordPress-style indexing', async () => {
    mockGet.mockResolvedValueOnce({ data: { sites: [] } });

    await executor.execute('list-sites-v1', {
      site_ids: [1, 2, 3],
    });

    const url = mockGet.mock.calls[1]?.[0] as string;
    expect(url).toContain('input[site_ids][0]=1');
    expect(url).toContain('input[site_ids][1]=2');
    expect(url).toContain('input[site_ids][2]=3');
  });

  it('encodes objects as JSON', async () => {
    mockGet.mockResolvedValueOnce({ data: { sites: [] } });

    await executor.execute('list-sites-v1', {
      filter: { status: 'active', client_id: 5 },
    });

    const url = mockGet.mock.calls[1]?.[0] as string;
    expect(url).toContain('input[filter]=');
    // URL-encoded JSON
    expect(decodeURIComponent(url)).toContain('{"status":"active","client_id":5}');
  });

  it('skips null and undefined values', async () => {
    mockGet.mockResolvedValueOnce({ data: { sites: [] } });

    await executor.execute('list-sites-v1', {
      page: 1,
      filter: null,
      search: undefined,
    });

    const url = mockGet.mock.calls[1]?.[0] as string;
    expect(url).toContain('input[page]=1');
    expect(url).not.toContain('filter');
    expect(url).not.toContain('search');
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

  it('strips confirm/dry_run/user_confirmed injected by LLM into input (DELETE/query string path)', async () => {
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

    // DELETE uses query string — verify URL doesn't contain injected flags
    const url = mockDelete.mock.calls[0][0] as string;
    expect(url).toContain('input[site_id]=123');
    expect(url).toContain('input[dry_run]=true');  // From options, not input
    expect(url).not.toContain('input[confirm]');
    expect(url).not.toContain('input[user_confirmed]');
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
    expect(url).toContain('input[site_id]=456');
    expect(url).toContain('input[confirm]=true');
    expect(url).toContain('input[user_confirmed]=true');
  });
});
