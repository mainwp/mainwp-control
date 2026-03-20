/**
 * Abilities Executor for mainwpctl
 *
 * Single execution pathway for all ability calls.
 * INVARIANT: Both commands and chat route through this module.
 */

import { HttpClient, type HttpClientConfig, createHttpClient } from './http-client.js';
import { APIError, InputError } from '../utils/errors.js';
import { getInputSanitizer } from '../validation/input-sanitizer.js';

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

/**
 * Abilities Executor class
 */
export class AbilitiesExecutor {
  private readonly httpClient: HttpClient;
  private readonly baseEndpoint = '/wp-json/wp-abilities/v1';
  private abilitiesCache: Map<string, Ability> | null = null;
  private cacheExpiry = 0;
  private readonly cacheTTL = 5 * 60 * 1000; // 5 minutes

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
        'List available abilities with `mainwpctl abilities list`'
      );
    }

    // Build the request body
    const body = this.buildRequestBody(input, options);

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
        // Control flags (dry_run, confirm) stay top-level.
        const queryString = this.buildGetQueryString(input, options);
        const url = queryString ? `${endpoint}?${queryString}` : endpoint;
        response = await this.httpClient.get<ExecutionResult<T>>(url, requestOptions);
      } else if (method === 'DELETE') {
        const queryString = this.buildGetQueryString(input, options);
        const url = queryString ? `${endpoint}?${queryString}` : endpoint;
        response = await this.httpClient.delete<ExecutionResult<T>>(url, requestOptions);
      } else {
        // POST with JSON body
        response = await this.httpClient.post<ExecutionResult<T>>(endpoint, body, requestOptions);
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
   * Ensure abilities cache is populated
   */
  private async ensureCache(): Promise<void> {
    if (this.abilitiesCache && Date.now() < this.cacheExpiry) {
      return;
    }

    this.abilitiesCache = new Map();

    // Fetch all pages — API returns Ability[] with WP pagination headers.
    let page = 1;
    let totalPages = 1;

    do {
      const response = await this.httpClient.get<AbilitiesListResponse>(
        `${this.baseEndpoint}/abilities?per_page=100&page=${page}`
      );

      const abilities = Array.isArray(response.data)
        ? response.data
        : (response.data as Record<string, unknown>)['abilities'] as Ability[] ?? [];

      for (const ability of abilities) {
        this.abilitiesCache.set(ability.name, ability);

        const shortName = this.getShortName(ability.name);
        if (shortName !== ability.name) {
          this.abilitiesCache.set(shortName, ability);
        }
      }

      // Read WP pagination header for total pages
      const wpTotalPages = response.headers?.get?.('x-wp-totalpages');
      if (wpTotalPages) {
        totalPages = parseInt(wpTotalPages, 10) || 1;
      }

      page++;
    } while (page <= totalPages);

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
   * Build request body with execution options.
   * The WP Abilities API expects: { input: { ...userInput, dry_run?, confirm? } }
   */
  private buildRequestBody(
    input: Record<string, unknown>,
    options?: ExecutionOptions
  ): Record<string, unknown> {
    const merged = { ...input };

    // SECURITY: Strip control flags from user/LLM-provided input.
    // These are set exclusively from execution options (CLI flags or safety flow).
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

    return { input: merged };
  }

  /**
   * Determine HTTP method based on ability annotations
   */
  private getHttpMethod(
    ability: Ability,
    _options?: ExecutionOptions
  ): 'GET' | 'POST' | 'DELETE' {
    const annotations = ability.meta?.annotations;

    // If readonly, use GET
    if (annotations?.readonly) {
      return 'GET';
    }

    // If destructive and idempotent, use DELETE
    if (annotations?.destructive && annotations?.idempotent) {
      return 'DELETE';
    }

    // Default to POST for write operations
    return 'POST';
  }

  /**
   * Build query string for GET/DELETE requests with WordPress-style nesting.
   * User input goes under input[key]=value; control flags stay top-level.
   */
  private buildGetQueryString(
    input: Record<string, unknown>,
    options?: ExecutionOptions,
  ): string {
    const parts: string[] = [];

    // SECURITY: Control flags managed exclusively by execution options
    const controlFlags = ['dry_run', 'confirm', 'user_confirmed'];

    // All params go under input[key] — the API treats input as a single object.
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined || value === null) continue;
      if (controlFlags.includes(key)) continue;
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

    if (options?.dryRun) parts.push('input[dry_run]=true');
    if (options?.confirm) {
      parts.push('input[confirm]=true');
      parts.push('input[user_confirmed]=true');
    }

    return parts.join('&');
  }


  /**
   * Normalize API response to ExecutionResult
   */
  private normalizeResponse<T>(data: unknown): ExecutionResult<T> {
    // If already in expected format, return as-is
    if (
      typeof data === 'object' &&
      data !== null &&
      'success' in data &&
      typeof (data as Record<string, unknown>)['success'] === 'boolean'
    ) {
      return data as ExecutionResult<T>;
    }

    // Wrap raw data in success response
    return {
      success: true,
      data: data as T,
    };
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
