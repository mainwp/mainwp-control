/**
 * Abilities Executor for mainwpcontrol
 *
 * Single execution pathway for all ability calls.
 * INVARIANT: Both commands and chat route through this module.
 */

import { HttpClient, type HttpClientConfig, createHttpClient } from './http-client.js';
import { APIError, InputError } from '../utils/errors.js';
import { getInputSanitizer } from '../validation/input-sanitizer.js';
import { isKnownDestructiveName } from './safety-controller.js';
import { validateJobId } from './job-id.js';

/**
 * Ability annotation metadata
 */
export interface AbilityAnnotations {
  readonly: boolean;
  destructive: boolean;
  idempotent: boolean;
  instructions?: string;
}

/**
 * Ability definition from the API
 */
export interface Ability {
  name: string;
  label: string;
  description: string;
  category: string;
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  meta?: {
    annotations?: AbilityAnnotations;
  };
}

/**
 * Execution options
 */
export interface ExecutionOptions {
  dryRun?: boolean | undefined;
  confirm?: boolean | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * Execution result
 */
export interface ExecutionResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
    hint?: string;
  };
  jobId?: string;
}

type TrueSchemaMatch = 'accept' | 'reject' | 'unknown';

function trueSchemaMatch(value: unknown): TrueSchemaMatch {
  if (value === true) return 'accept';
  if (value === false || value === null || typeof value !== 'object' || Array.isArray(value)) {
    return 'reject';
  }

  const schema = value as Record<string, unknown>;
  if (Object.hasOwn(schema, '$ref') || Object.hasOwn(schema, '$dynamicRef')) return 'unknown';

  const type = schema['type'];
  if (typeof type === 'string' && type !== 'boolean') return 'reject';
  if (Array.isArray(type) && !type.includes('boolean')) return 'reject';
  if (Array.isArray(schema['enum']) && !schema['enum'].includes(true)) return 'reject';
  if (Object.hasOwn(schema, 'const') && schema['const'] !== true) return 'reject';

  const allOf = schema['allOf'];
  if (Array.isArray(allOf)) {
    const matches = allOf.map(trueSchemaMatch);
    if (matches.includes('reject')) return 'reject';
    if (matches.includes('unknown')) return 'unknown';
  }

  const anyOf = schema['anyOf'];
  if (Array.isArray(anyOf)) {
    const matches = anyOf.map(trueSchemaMatch);
    if (!matches.includes('accept')) {
      return matches.includes('unknown') ? 'unknown' : 'reject';
    }
  }

  const oneOf = schema['oneOf'];
  if (Array.isArray(oneOf)) {
    const matches = oneOf.map(trueSchemaMatch);
    if (matches.includes('unknown')) return 'unknown';
    if (matches.filter((match) => match === 'accept').length !== 1) return 'reject';
  }

  if (Object.hasOwn(schema, 'not')) {
    const match = trueSchemaMatch(schema['not']);
    if (match === 'accept') return 'reject';
    if (match === 'unknown') return 'unknown';
  }

  return 'accept';
}

function schemaAcceptsTrue(value: unknown): boolean {
  return trueSchemaMatch(value) === 'accept';
}

/** Resolve the one schema-declared field trusted confirmation may set. */
export function resolveConfirmationInputProperty(ability: Ability | undefined): string | undefined {
  const schema = ability?.input_schema;
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return undefined;
  const properties = schema['properties'];
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
    return undefined;
  }
  const propertyMap = properties as Record<string, unknown>;
  if (Object.hasOwn(propertyMap, 'confirm') && schemaAcceptsTrue(propertyMap['confirm'])) {
    return 'confirm';
  }
  const required = Array.isArray(schema['required']) ? schema['required'] : [];
  const candidates = required.filter(
    (name): name is string =>
      typeof name === 'string' &&
      /^confirm_[a-z0-9_]+$/.test(name) &&
      Object.hasOwn(propertyMap, name) &&
      schemaAcceptsTrue(propertyMap[name])
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** Whether the discovered closed schema can accept a true dry_run control. */
export function abilitySupportsDryRun(ability: Ability | undefined): boolean {
  const schema = ability?.input_schema;
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return false;
  const properties = schema['properties'];
  return properties !== null && typeof properties === 'object' && !Array.isArray(properties) &&
    Object.hasOwn(properties, 'dry_run') &&
    schemaAcceptsTrue((properties as Record<string, unknown>)['dry_run']);
}

/**
 * Abilities list response — the real API returns Ability[] (flat array),
 * with pagination via X-WP-Total / X-WP-TotalPages headers.
 */
type AbilitiesListResponse = Ability[];

const MAX_DISCOVERY_PAGES = 20;
// Deliberately case-SENSITIVE: the Dashboard registers lowercase names, and
// the destructive-name override (DESTRUCTIVE_NAME_PATTERNS) matches lowercase.
// A case-variant like "Mainwp/Delete-Site-V1" is refused at discovery rather
// than normalized, so it can never evade classification or alias a cache key.
const ABILITY_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*-v[1-9]\d*$/;

/**
 * Abilities Executor class
 */
export class AbilitiesExecutor {
  private readonly httpClient: HttpClient;
  private readonly baseEndpoint = '/wp-json/wp-abilities/v1';
  private abilitiesCache: Map<string, Ability> | null = null;
  private cacheExpiry = 0;
  private readonly cacheTTL = 5 * 60 * 1000; // 5 minutes
  /** In-flight cache fill, shared by concurrent callers to avoid a fetch stampede. */
  private cacheFillPromise: Promise<void> | null = null;

  constructor(config: HttpClientConfig) {
    this.httpClient = createHttpClient(config);
  }

  /**
   * List all available abilities
   */
  async listAbilities(): Promise<Ability[]> {
    await this.ensureCache();
    // Return only full-name entries (cache also stores short names for lookups)
    return Array.from(this.abilitiesCache?.entries() ?? [])
      .filter(([key, ability]) => key === ability.name)
      .map(([, ability]) => ability);
  }

  /**
   * Get a single ability by name
   */
  async getAbility(name: string): Promise<Ability | undefined> {
    await this.ensureCache();
    return this.abilitiesCache?.get(this.normalizeName(name));
  }

  /**
   * Execute an ability
   *
   * @param abilityName - The ability name (e.g., "list-sites-v1" or "mainwp/list-sites-v1")
   * @param input - The input parameters
   * @param options - Execution options (dryRun, confirm)
   */
  async execute<T = unknown>(
    abilityName: string,
    input: Record<string, unknown> = {},
    options?: ExecutionOptions
  ): Promise<ExecutionResult<T>> {
    // Defense-in-depth: sanitize input before any processing
    input = getInputSanitizer().sanitize(input);

    const ability = await this.getAbility(abilityName);

    if (!ability) {
      throw new InputError(
        `Unknown ability: ${abilityName}`,
        undefined,
        'List available abilities with `mainwpcontrol abilities list`'
      );
    }

    // Merge execution options into user input — the single place control
    // flags are applied. Both request paths below format this same output.
    const params = this.buildEffectiveParams(input, options, ability);

    // Determine HTTP method based on annotations
    const method = this.getHttpMethod(ability, options);

    // Build the endpoint
    // Ability names contain a namespace slash (e.g. "mainwp/list-sites-v1")
    // which is part of the WordPress REST route — do NOT encode it.
    const endpoint = `${this.baseEndpoint}/abilities/${ability.name}/run`;

    try {
      let response;

      const requestOptions = options?.signal ? { signal: options.signal } : undefined;

      if (method === 'GET') {
        // GET uses one JSON carrier so nested nulls and composite values retain
        // their JSON types through PHP query parsing.
        const queryString = this.buildGetQueryString(params);
        const url = queryString ? `${endpoint}?${queryString}` : endpoint;
        response = await this.httpClient.get<ExecutionResult<T>>(url, requestOptions);
      } else if (method === 'DELETE') {
        // Keep destructive credentials and confirmation data out of URLs.
        response = await this.httpClient.delete<ExecutionResult<T>>(
          endpoint,
          { input: params },
          requestOptions
        );
      } else {
        // POST with JSON body
        response = await this.httpClient.post<ExecutionResult<T>>(
          endpoint,
          { input: params },
          requestOptions
        );
      }

      return this.normalizeResponse(response.data);
    } catch (error) {
      if (error instanceof APIError) {
        const errorObj: ExecutionResult<T>['error'] = {
          code: error.code,
          message: error.message,
          details: error.details,
        };
        if (error.hint) {
          errorObj.hint = error.hint;
        }
        return {
          success: false,
          error: errorObj,
        };
      }
      throw error;
    }
  }

  /**
   * Get ability categories
   */
  async getCategories(): Promise<string[]> {
    const abilities = await this.listAbilities();
    const categories = new Set(abilities.map((a) => a.category));
    return Array.from(categories).sort();
  }

  /**
   * List abilities by category
   */
  async listByCategory(category: string): Promise<Ability[]> {
    const abilities = await this.listAbilities();
    return abilities.filter((a) => a.category.toLowerCase() === category.toLowerCase());
  }

  /**
   * Ensure abilities cache is populated.
   * Concurrent callers share one in-flight fetch instead of each starting
   * their own paginated fetch (plausible in chat's tool-calling loop).
   */
  private async ensureCache(): Promise<void> {
    if (this.abilitiesCache && Date.now() < this.cacheExpiry) {
      return;
    }

    if (this.cacheFillPromise) {
      return this.cacheFillPromise;
    }

    this.cacheFillPromise = this.fillCache().finally(() => {
      this.cacheFillPromise = null;
    });

    return this.cacheFillPromise;
  }

  /**
   * Fetch all ability pages and populate the cache.
   */
  private async fillCache(): Promise<void> {
    const cache = new Map<string, Ability>();
    const aliasOwners = new Map<string, string | null>();

    // Fetch all pages — API returns Ability[] with WP pagination headers.
    let page = 1;
    let totalPages = 1;

    do {
      const response = await this.httpClient.get<AbilitiesListResponse>(
        `${this.baseEndpoint}/abilities?per_page=100&page=${page}`
      );

      const abilities: unknown[] = Array.isArray(response.data)
        ? response.data
        : this.asRecord(response.data)?.['abilities'] instanceof Array
          ? this.asRecord(response.data)?.['abilities'] as unknown[]
          : [];

      for (const entry of abilities) {
        if (!this.isPlainObject(entry) ||
          typeof entry['name'] !== 'string' ||
          !ABILITY_NAME_PATTERN.test(entry['name'])) {
          console.error('Warning: Discovery skipped an invalid ability entry.');
          continue;
        }

        const ability = entry as unknown as Ability;
        if (cache.has(ability.name)) {
          console.error(`Warning: Discovery ignored duplicate ability "${ability.name}".`);
          continue;
        }
        cache.set(ability.name, ability);

        const shortName = this.getShortName(ability.name);
        if (shortName !== ability.name) {
          const existingOwner = aliasOwners.get(shortName);
          if (existingOwner === undefined) {
            aliasOwners.set(shortName, ability.name);
            cache.set(shortName, ability);
          } else if (existingOwner !== null) {
            aliasOwners.set(shortName, null);
            cache.delete(shortName);
            console.error(
              `Warning: Discovery removed ambiguous short alias "${shortName}". Use full ability names.`
            );
          }
        }
      }

      // Read WP pagination header for total pages
      const wpTotalPages = response.headers?.get?.('x-wp-totalpages');
      if (page === 1 && wpTotalPages) {
        const declaredPages = Number.parseInt(wpTotalPages, 10);
        if (Number.isInteger(declaredPages) && declaredPages > 0) {
          if (declaredPages > MAX_DISCOVERY_PAGES) {
            throw new APIError(
              'INVALID_RESPONSE',
              `Discovery declared ${declaredPages} pages, exceeding the ${MAX_DISCOVERY_PAGES}-page limit.`
            );
          }
          totalPages = declaredPages;
        } else {
          console.error('Warning: Discovery returned an invalid pagination header.');
        }
      }

      page++;
    } while (page <= totalPages);

    this.abilitiesCache = cache;
    this.cacheExpiry = Date.now() + this.cacheTTL;
  }

  /**
   * Normalize ability name (handle with/without namespace)
   */
  private normalizeName(name: string): string {
    // Remove leading slash if present
    return name.replace(/^\//, '');
  }

  /**
   * Get short name from full ability name
   */
  private getShortName(fullName: string): string {
    const parts = fullName.split('/');
    return parts[parts.length - 1] ?? fullName;
  }

  /**
   * Merge execution options into user input, producing the final param set.
   * Every transport formats this same output — this is the single place
   * dry_run/confirm are applied.
   *
   * SECURITY: strips any dry_run/confirm/user_confirmed present in user/LLM
   * input before applying the ones from `options`. These control flags are
   * set exclusively by execution options (CLI flags or the safety flow) —
   * preserve this strip exactly, do not weaken it.
   */
  private buildEffectiveParams(
    input: Record<string, unknown>,
    options?: ExecutionOptions,
    ability?: Ability
  ): Record<string, unknown> {
    // INVARIANT: dry_run and confirm are mutually exclusive. Callers enforce
    // this upstream (SafetyController.validateExecutionFlags, oclif exclusive
    // flags); assert here too so no code path can emit a request carrying both.
    if (options?.dryRun && options?.confirm) {
      throw new InputError(
        'dry_run and confirm cannot both be set',
        undefined,
        'This is an internal error — preview and execute are separate steps.'
      );
    }

    const merged = { ...input };
    const confirmationProperty = resolveConfirmationInputProperty(ability);

    delete merged['dry_run'];
    delete merged['confirm'];
    delete merged['user_confirmed'];
    for (const key of Object.keys(merged)) {
      if (/^confirm_[a-z0-9_]+$/.test(key)) {
        delete merged[key];
      }
    }
    if (confirmationProperty) {
      delete merged[confirmationProperty];
    }

    if (options?.dryRun) {
      if (confirmationProperty && !abilitySupportsDryRun(ability)) {
        throw new InputError(
          `Ability "${ability?.name ?? 'unknown'}" does not declare dry_run`,
          undefined,
          'Use the explicit confirmation flow; no upstream preview is available.'
        );
      }
      if (abilitySupportsDryRun(ability) || confirmationProperty === undefined) {
        merged['dry_run'] = true;
      }
      if (this.abilityRequiresInputProperty(ability, 'confirm')) {
        merged['confirm'] = false;
      }
    }

    if (options?.confirm) {
      if (confirmationProperty) {
        if (confirmationProperty === 'confirm' && abilitySupportsDryRun(ability)) {
          merged['dry_run'] = false;
        }
        merged[confirmationProperty] = true;
      } else {
        // Compatibility fallback for older abilities whose discovery schema
        // omitted both control fields but whose execution contract accepts them.
        merged['dry_run'] = false;
        merged['confirm'] = true;
      }
    }

    return merged;
  }

  /** Whether the closed discovered input schema requires one named property. */
  private abilityRequiresInputProperty(ability: Ability | undefined, property: string): boolean {
    const schema = ability?.input_schema;
    if (!this.isPlainObject(schema) || !Array.isArray(schema['required'])) {
      return false;
    }

    return schema['required'].some((item) => item === property);
  }

  /**
   * Determine HTTP method based on ability annotations
   */
  private getHttpMethod(
    ability: Ability,
    _options?: ExecutionOptions
  ): 'GET' | 'POST' | 'DELETE' {
    const annotations = ability.meta?.annotations;
    const annotationsAreValid =
      typeof annotations?.readonly === 'boolean' &&
      typeof annotations.destructive === 'boolean' &&
      typeof annotations.idempotent === 'boolean';

    // Resolve destructiveness the same way SafetyController does — annotations
    // OR a known-destructive name — so transport never disagrees with policy.
    // A name-destructive ability must never go out as GET (readonly transport),
    // even if a hostile/buggy server marks it readonly.
    // Strict === true matches SafetyController.validateAnnotations(): a
    // non-boolean annotation value (e.g. readonly: "true" from a buggy or
    // hostile server) must not be treated as set.
    const annotatedDestructive = annotationsAreValid && annotations.destructive;
    const destructive = annotatedDestructive || isKnownDestructiveName(ability.name);

    // Read-only (and not name-destructive) → GET
    if (annotationsAreValid && annotations.readonly && !destructive) {
      return 'GET';
    }

    // Destructive and idempotent → DELETE. Only when the annotations
    // themselves say destructive: if destructiveness came from the name
    // override, the annotations are already distrusted, so `idempotent`
    // from the same source must not pick the method — fall through to POST.
    if (annotatedDestructive && annotations.idempotent) {
      return 'DELETE';
    }

    // Default to POST for write operations
    return 'POST';
  }

  /**
   * Build the typed JSON query carrier for GET requests.
   * `params` is already the merged output of buildEffectiveParams(), so
   * dry_run/confirm (if present) are carried in the same input
   * object — no separate control-flag handling is needed here.
   */
  private buildGetQueryString(params: Record<string, unknown>): string {
    const inputJson = JSON.stringify(params);
    return `input_json=${encodeURIComponent(inputJson)}`;
  }


  /**
   * Normalize API response to ExecutionResult
   */
  private normalizeResponse<T>(data: unknown): ExecutionResult<T> {
    const record = this.asRecord(data);
    const wrappedData = this.asRecord(record?.['data']);
    const queuedEnvelope = record?.['queued'] === true ? record : wrappedData;
    const queuedJobId = queuedEnvelope?.['queued'] === true
      ? validateJobId(queuedEnvelope['job_id'])
      : undefined;

    // If already in expected format, return as-is
    if (
      record &&
      typeof record['success'] === 'boolean'
    ) {
      return {
        ...(data as ExecutionResult<T>),
        ...(queuedJobId ? { jobId: queuedJobId } : {}),
      };
    }

    // Wrap raw data in success response
    return {
      success: true,
      data: data as T,
      ...(queuedJobId ? { jobId: queuedJobId } : {}),
    };
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return undefined;
    }

    return value as Record<string, unknown>;
  }

  private isPlainObject(value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }

    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  /**
   * Clear the abilities cache
   */
  clearCache(): void {
    this.abilitiesCache = null;
    this.cacheExpiry = 0;
  }
}

/**
 * Create an abilities executor from config
 */
export function createAbilitiesExecutor(config: HttpClientConfig): AbilitiesExecutor {
  return new AbilitiesExecutor(config);
}
