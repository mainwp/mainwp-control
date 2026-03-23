/**
 * Schema Validator for mainwpctl
 *
 * AJV-based input validation against ability JSON schemas.
 * Caches compiled schemas for performance.
 */

import AjvModule, { type ErrorObject, type ValidateFunction } from 'ajv';
import { SchemaValidationError } from '../utils/errors.js';

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
    const valid = validate(coerced);

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
        `Check the ability schema with \`mainwpctl abilities info ${abilityName}\` for required fields and types`
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
    return validate(structuredClone(input)) as boolean;
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

    // Compile schema
    const compiled = this.ajv.compile(schema);

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

