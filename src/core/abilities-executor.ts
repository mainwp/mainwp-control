/**
 * Abilities Executor for mainwpctl
 *
 * Single execution pathway for all ability calls.
 * INVARIANT: Both commands and chat route through this module.
 */

import { HttpClient, type HttpClientConfig, createHttpClient } from './http-client.js';
import { APIError, InputError } from '../utils/errors.js';

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
 * Abilities list response
 */
interface AbilitiesListResponse {
  abilities: Ability[];
  total?: number;
  page?: number;
  per_page?: number;
}

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
    return Array.from(this.abilitiesCache?.values() ?? []);
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
    const endpoint = `${this.baseEndpoint}/abilities/${encodeURIComponent(ability.name)}/run`;

    try {
      let response;

      const requestOptions = options?.signal ? { signal: options.signal } : undefined;

      if (method === 'GET') {
        // For GET requests, encode input as query params
        const queryString = this.buildQueryString(body);
        const url = queryString ? `${endpoint}?${queryString}` : endpoint;
        response = await this.httpClient.get<ExecutionResult<T>>(url, requestOptions);
      } else if (method === 'DELETE') {
        // DELETE with body in query params
        const queryString = this.buildQueryString(body);
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

    const response = await this.httpClient.get<AbilitiesListResponse>(
      `${this.baseEndpoint}/abilities`
    );

    this.abilitiesCache = new Map();

    for (const ability of response.data.abilities) {
      // Store by full name and short name
      this.abilitiesCache.set(ability.name, ability);

      // Also store by short name (without namespace)
      const shortName = this.getShortName(ability.name);
      if (shortName !== ability.name) {
        this.abilitiesCache.set(shortName, ability);
      }
    }

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
   * Build request body with execution options
   */
  private buildRequestBody(
    input: Record<string, unknown>,
    options?: ExecutionOptions
  ): Record<string, unknown> {
    const body = { ...input };

    if (options?.dryRun) {
      body['dry_run'] = true;
    }

    if (options?.confirm) {
      body['confirm'] = true;
      body['user_confirmed'] = true;
    }

    return body;
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
   * Build query string for GET/DELETE requests
   */
  private buildQueryString(params: Record<string, unknown>): string {
    const parts: string[] = [];

    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;

      if (Array.isArray(value)) {
        // WordPress-style array params: key[0]=value0&key[1]=value1
        value.forEach((v, i) => {
          parts.push(`${encodeURIComponent(key)}[${i}]=${encodeURIComponent(String(v))}`);
        });
      } else if (typeof value === 'object') {
        // Nested objects
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(JSON.stringify(value))}`);
      } else {
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
      }
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
