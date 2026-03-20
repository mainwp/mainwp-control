/**
 * API Response Factories for Process Tests
 *
 * Produces response shapes matching the real MainWP Abilities API.
 */

export interface MockAbilityDef {
  name: string;
  label?: string;
  description?: string;
  category?: string;
  readonly?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  input_schema?: Record<string, unknown>;
}

/**
 * Build a full ability object from a concise definition.
 */
export function mockAbility(def: MockAbilityDef): Record<string, unknown> {
  const shortName = def.name.replace(/^mainwp\//, '');
  return {
    name: def.name.startsWith('mainwp/') ? def.name : `mainwp/${def.name}`,
    label: def.label ?? shortName.replace(/-/g, ' ').replace(/v1$/, '').trim(),
    description: def.description ?? `Ability: ${shortName}`,
    category: def.category ?? 'sites',
    input_schema: def.input_schema ?? { type: 'object', properties: {} },
    meta: {
      annotations: {
        readonly: def.readonly ?? false,
        destructive: def.destructive ?? false,
        idempotent: def.idempotent ?? false,
      },
    },
  };
}

/**
 * Build the list-abilities API response (flat array, matching real API).
 */
export function abilitiesListResponse(
  abilities: Record<string, unknown>[],
): Record<string, unknown>[] {
  return abilities;
}

/**
 * A successful ability-run result.
 */
export function abilityRunSuccess(data: unknown): Record<string, unknown> {
  return { success: true, data };
}

/**
 * A dry-run preview result.
 */
export function abilityDryRunResponse(
  affected: unknown[],
): Record<string, unknown> {
  return { success: true, data: { affected } };
}

/**
 * A batch-job-started result.
 */
export function abilityRunBatch(jobId: string): Record<string, unknown> {
  return { success: true, jobId };
}

/**
 * A batch job status response.
 */
export function jobStatus(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    success: true,
    data: {
      job_id: 'job_test123',
      status: 'pending',
      progress: 0,
      total: 10,
      processed: 0,
      results: [],
      errors: [],
      ...overrides,
    },
  };
}

/**
 * Standard test abilities matching the real API namespace.
 */
export const STANDARD_ABILITIES = [
  mockAbility({ name: 'mainwp/list-sites-v1', readonly: true, category: 'sites' }),
  mockAbility({
    name: 'mainwp/get-site-v1',
    readonly: true,
    category: 'sites',
    input_schema: {
      type: 'object',
      properties: { site_id: { type: 'integer', description: 'Site ID' } },
      required: ['site_id'],
    },
  }),
  mockAbility({
    name: 'mainwp/delete-site-v1',
    destructive: true,
    category: 'sites',
    input_schema: {
      type: 'object',
      properties: { site_id: { type: 'integer', description: 'Site ID' } },
      required: ['site_id'],
    },
  }),
  mockAbility({ name: 'mainwp/sync-sites-v1', category: 'sites' }),
  mockAbility({ name: 'mainwp/run-updates-v1', destructive: true, category: 'updates' }),
  mockAbility({ name: 'mainwp/list-updates-v1', readonly: true, category: 'updates' }),
  mockAbility({
    name: 'mainwp/get-site-plugins-v1',
    readonly: true,
    category: 'plugins',
    input_schema: {
      type: 'object',
      properties: { site_id: { type: 'integer', description: 'Site ID' } },
      required: ['site_id'],
    },
  }),
  mockAbility({
    name: 'mainwp/get-batch-job-status-v1',
    readonly: true,
    category: 'system',
  }),
];
