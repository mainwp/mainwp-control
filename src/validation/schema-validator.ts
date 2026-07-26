/**
 * Schema Validator for mainwpcontrol
 *
 * AJV-based input validation against ability JSON schemas.
 * Caches compiled schemas for performance.
 */

import AjvModule, { type ErrorObject, type ValidateFunction } from 'ajv';
import { APIError, SchemaValidationError } from '../utils/errors.js';
import { sanitizeInputSchema } from './sanitize-schema.js';

// Handle ESM default export
const Ajv = AjvModule.default ?? AjvModule;

/**
 * Validation result
 */
export interface ValidationResult {
  valid: boolean;
  errors?: ValidationError[];
  /** Coerced copy of input after AJV applies type coercion and defaults */
  coerced?: Record<string, unknown>;
}

/**
 * Structured validation error
 */
export interface ValidationError {
  path: string;
  message: string;
  keyword: string;
  params: Record<string, unknown>;
}

// AJV instance type
type AjvInstance = InstanceType<typeof AjvModule.default>;

/**
 * Schema Validator class
 */
export class SchemaValidator {
  private readonly ajv: AjvInstance;
  private readonly schemaCache: Map<string, ValidateFunction> = new Map();

  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.ajv = new (Ajv as any)({
      allErrors: true, // Collect all errors, not just first
      strict: false, // Allow unknown keywords (for ability schema extensions)
      coerceTypes: true, // Coerce strings to numbers, etc.
      useDefaults: true, // Apply default values from schema
    });
  }

  /**
   * Validate input against a JSON schema
   *
   * @param input - The input data to validate
   * @param schema - The JSON schema to validate against
   * @param schemaId - Optional ID for caching compiled schema
   * @returns Validation result with any errors
   */
  validate(
    input: Record<string, unknown>,
    schema: Record<string, unknown>,
    schemaId?: string
  ): ValidationResult {
    const validate = this.getCompiledSchema(schema, schemaId);
    // Clone input so AJV coerceTypes/useDefaults mutates the clone, not the caller's object
    const coerced = structuredClone(input);
    const valid = this.assertSyncResult(validate(coerced), schemaId);

    if (valid) {
      return { valid: true, coerced };
    }

    const errors = this.formatErrors(validate.errors ?? []);
    return { valid: false, errors, coerced };
  }

  /**
   * Validate input and throw if invalid
   *
   * @param input - The input data to validate
   * @param schema - The JSON schema to validate against
   * @param abilityName - Name of the ability (for error message)
   * @throws SchemaValidationError if validation fails
   */
  validateOrThrow(
    input: Record<string, unknown>,
    schema: Record<string, unknown>,
    abilityName: string
  ): ValidationResult {
    const result = this.validate(input, schema, abilityName);

    if (!result.valid && result.errors) {
      const errorMessages = result.errors.map((e) => `${e.path}: ${e.message}`).join('; ');
      throw new SchemaValidationError(
        `Invalid input for ability "${abilityName}": ${errorMessages}`,
        result.errors,
        `Check the ability schema with \`mainwpcontrol abilities info ${abilityName}\` for required fields and types`
      );
    }

    return result;
  }

  /**
   * Check if input would be valid (without detailed errors)
   */
  isValid(
    input: Record<string, unknown>,
    schema: Record<string, unknown>,
    schemaId?: string
  ): boolean {
    const validate = this.getCompiledSchema(schema, schemaId);
    return this.assertSyncResult(validate(structuredClone(input)), schemaId);
  }

  /**
   * Fail closed if a compiled validator returns anything other than a boolean.
   *
   * `sanitize-schema` strips `$async`, so a compiled validator is always
   * synchronous in normal operation. This guard is defense in depth: should any
   * future async keyword slip past the sanitizer, AJV would return a
   * Promise, whose truthiness would otherwise be read as "valid" and whose
   * rejection would crash the process. Reject it as an unusable schema instead.
   */
  private assertSyncResult(result: unknown, schemaId?: string): boolean {
    if (typeof result !== 'boolean') {
      // Adopt a thenable before throwing. An async validator's promise rejects
      // on invalid input, and with nothing attached that rejection is unhandled
      // and kills the process — the exact crash this guard exists to prevent.
      // The result comes from a compiled remote schema, so `then` may be a
      // throwing getter, may throw when called, or may itself return a rejected
      // promise; none of those may replace the schema error below.
      try {
        const thenable = result as { then?: unknown } | null;
        const then = thenable?.then;
        if (typeof then === 'function') {
          const chained: unknown = then.call(
            thenable,
            () => undefined,
            () => undefined
          );
          if (typeof (chained as PromiseLike<unknown> | null)?.then === 'function') {
            void Promise.resolve(chained as PromiseLike<unknown>).catch(() => undefined);
          }
        }
      } catch {
        // Containing the rejection is best effort; the schema error is what matters.
      }
      const schemaName = schemaId ? `"${schemaId}"` : '(unnamed)';
      throw new APIError(
        'ABILITY_SCHEMA_INVALID',
        `Input schema for ability ${schemaName} produced a non-boolean validation result`,
        undefined,
        undefined,
        'The Dashboard served an input schema that validates asynchronously, which is not supported'
      );
    }
    return result;
  }

  /**
   * Get or compile schema
   */
  private getCompiledSchema(
    schema: Record<string, unknown>,
    schemaId?: string
  ): ValidateFunction {
    // Try cache if ID provided
    if (schemaId) {
      const cached = this.schemaCache.get(schemaId);
      if (cached) {
        return cached;
      }
    }

    // Compile the normalized Dashboard schema. If AJV still rejects it, the
    // server supplied an ability schema this client cannot safely repair.
    let compiled: ValidateFunction;
    try {
      compiled = this.ajv.compile(sanitizeInputSchema(schema));
    } catch (error) {
      const schemaName = schemaId ? `"${schemaId}"` : '(unnamed)';
      const cause = error instanceof Error ? error.message : String(error);
      throw new APIError(
        'ABILITY_SCHEMA_INVALID',
        `Input schema for ability ${schemaName} is invalid`,
        undefined,
        { cause },
        'The Dashboard served an input schema that could not be compiled'
      );
    }

    // Cache if ID provided
    if (schemaId) {
      this.schemaCache.set(schemaId, compiled);
    }

    return compiled;
  }

  /**
   * Format AJV errors into structured errors
   */
  private formatErrors(ajvErrors: ErrorObject[]): ValidationError[] {
    return ajvErrors.map((error) => ({
      path: error.instancePath || '/',
      message: this.formatErrorMessage(error),
      keyword: error.keyword,
      params: error.params as Record<string, unknown>,
    }));
  }

  /**
   * Format a single error into a human-readable message
   */
  private formatErrorMessage(error: ErrorObject): string {
    switch (error.keyword) {
      case 'required':
        return `Missing required property: ${error.params['missingProperty']}`;

      case 'type':
        return `Expected ${error.params['type']}, got ${typeof error.data}`;

      case 'enum':
        return `Must be one of: ${(error.params['allowedValues'] as string[]).join(', ')}`;

      case 'minLength':
        return `Must be at least ${error.params['limit']} characters`;

      case 'maxLength':
        return `Must be at most ${error.params['limit']} characters`;

      case 'minimum':
        return `Must be >= ${error.params['limit']}`;

      case 'maximum':
        return `Must be <= ${error.params['limit']}`;

      case 'pattern':
        return `Must match pattern: ${error.params['pattern']}`;

      case 'format':
        return `Must be a valid ${error.params['format']}`;

      case 'additionalProperties':
        return `Unknown property: ${error.params['additionalProperty']}`;

      default:
        return error.message ?? 'Validation failed';
    }
  }

  /**
   * Clear the schema cache
   */
  clearCache(): void {
    this.schemaCache.clear();
  }
}

/**
 * Singleton instance
 */
let instance: SchemaValidator | null = null;

/**
 * Get the schema validator singleton
 */
export function getSchemaValidator(): SchemaValidator {
  if (!instance) {
    instance = new SchemaValidator();
  }
  return instance;
}

