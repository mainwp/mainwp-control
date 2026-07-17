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

/**
 * Abilities list response — the real API returns Ability[] (flat array),
 * with pagination via X-WP-Total / X-WP-TotalPages headers.
 */
type AbilitiesListResponse = Ability[];

const MAX_DISCOVERY_PAGES = 20;
const ABILITY_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*-v[1-9]\d*$/i;

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
    const params = this.buildEffectiveParams(input, options);

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
        // For GET requests, nest input under input[key] (WordPress REST style).
        const queryString = this.buildGetQueryString(params);
        const url = queryString ? `${endpoint}?${queryString}` : endpoint;
        response = await this.httpClient.get<ExecutionResult<T>>(url, requestOptions);
      } else if (method === 'DELETE') {
        const queryString = this.buildGetQueryString(params);
        const url = queryString ? `${endpoint}?${queryString}` : endpoint;
        response = await this.httpClient.delete<ExecutionResult<T>>(url, requestOptions);
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
   * Both the POST body and the GET/DELETE query-string path format this same
   * output — this is the single place dry_run/confirm/user_confirmed are applied.
   *
   * SECURITY: strips any dry_run/confirm/user_confirmed present in user/LLM
   * input before applying the ones from `options`. These control flags are
   * set exclusively by execution options (CLI flags or the safety flow) —
   * preserve this strip exactly, do not weaken it.
   */
  private buildEffectiveParams(
    input: Record<string, unknown>,
    options?: ExecutionOptions
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

    delete merged['dry_run'];
    delete merged['confirm'];
    delete merged['user_confirmed'];

    if (options?.dryRun) {
      merged['dry_run'] = true;
    }

    if (options?.confirm) {
      merged['confirm'] = true;
      merged['user_confirmed'] = true;
    }

    return merged;
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
   * Build query string for GET/DELETE requests with WordPress-style nesting.
   * `params` is already the merged output of buildEffectiveParams(), so
   * dry_run/confirm/user_confirmed (if present) are formatted the same as
   * any other param — no separate control-flag handling needed here.
   */
  private buildGetQueryString(params: Record<string, unknown>): string {
    const parts: string[] = [];

    // All params go under input[key] — the API treats input as a single object.
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      const ek = encodeURIComponent(key);

      if (Array.isArray(value)) {
        // WordPress-style: input[key][0]=v0&input[key][1]=v1
        value.forEach((v, i) => {
          parts.push(`input[${ek}][${i}]=${encodeURIComponent(String(v))}`);
        });
      } else if (typeof value === 'object') {
        parts.push(`input[${ek}]=${encodeURIComponent(JSON.stringify(value))}`);
      } else {
        parts.push(`input[${ek}]=${encodeURIComponent(String(value))}`);
      }
    }

    return parts.join('&');
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
