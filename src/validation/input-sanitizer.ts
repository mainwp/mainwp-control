/**
 * Input Sanitizer for mainwpcontrol
 *
 * Security sanitization for inputs:
 * - Input limits (string length, array elements, object depth)
 * - Error sanitization (path redaction, credential stripping)
 */

import { InputError } from '../utils/errors.js';

/**
 * Default limits for input sanitization
 */
export const DEFAULT_LIMITS = {
  /** Maximum string length */
  maxStringLength: 65536, // 64KB
  /** Maximum array elements */
  maxArrayElements: 1000,
  /** Maximum object depth */
  maxObjectDepth: 10,
  /** Maximum object keys */
  maxObjectKeys: 100,
  /** Maximum total input size (approximate) */
  maxInputSize: 1048576, // 1MB
} as const;

/**
 * Sanitization options
 */
export interface SanitizeOptions {
  maxStringLength?: number;
  maxArrayElements?: number;
  maxObjectDepth?: number;
  maxObjectKeys?: number;
  maxInputSize?: number;
}

/**
 * Patterns that indicate sensitive data
 */
const SENSITIVE_PATTERNS = [
  /password/i,
  /secret/i,
  /token/i,
  /api[_-]?key/i,
  /auth/i,
  /credential/i,
  /private[_-]?key/i,
  /bearer/i,
  /signing[_-]?key/i,
  /encryption[_-]?key/i,
];

/**
 * Patterns for redacting file paths
 */
const PATH_PATTERNS = [
  // Absolute paths
  /\/Users\/[^/\s]+/g,
  /\/home\/[^/\s]+/g,
  /C:\\Users\\[^\\]+/gi,
  // Config directories
  /\.config\/mainwpcontrol/g,
];

/**
 * Input Sanitizer class
 */
export class InputSanitizer {
  private readonly limits: Required<SanitizeOptions>;

  constructor(options?: SanitizeOptions) {
    this.limits = {
      maxStringLength: options?.maxStringLength ?? DEFAULT_LIMITS.maxStringLength,
      maxArrayElements: options?.maxArrayElements ?? DEFAULT_LIMITS.maxArrayElements,
      maxObjectDepth: options?.maxObjectDepth ?? DEFAULT_LIMITS.maxObjectDepth,
      maxObjectKeys: options?.maxObjectKeys ?? DEFAULT_LIMITS.maxObjectKeys,
      maxInputSize: options?.maxInputSize ?? DEFAULT_LIMITS.maxInputSize,
    };
  }

  /**
   * Sanitize and validate input
   *
   * @param input - Input data to sanitize
   * @throws InputError if input exceeds limits
   * @returns Sanitized input (same object if valid)
   */
  sanitize(input: Record<string, unknown>): Record<string, unknown> {
    // Check total size
    const serialized = JSON.stringify(input);
    if (serialized.length > this.limits.maxInputSize) {
      throw new InputError(
        `Input size exceeds limit: ${serialized.length} bytes (max: ${this.limits.maxInputSize})`,
        { size: serialized.length, limit: this.limits.maxInputSize },
        'Reduce the size of your input or split into multiple requests'
      );
    }

    // Validate structure
    this.validateValue(input, 0, 'input');

    return input;
  }

  /**
   * Recursively validate a value
   */
  private validateValue(value: unknown, depth: number, path: string): void {
    // Check depth
    if (depth > this.limits.maxObjectDepth) {
      throw new InputError(
        `Input exceeds maximum depth at "${path}"`,
        { path, depth, limit: this.limits.maxObjectDepth },
        'Simplify your input structure or reduce nesting depth'
      );
    }

    if (value === null || value === undefined) {
      return;
    }

    if (typeof value === 'string') {
      if (value.length > this.limits.maxStringLength) {
        throw new InputError(
          `String exceeds maximum length at "${path}"`,
          { path, length: value.length, limit: this.limits.maxStringLength },
          'Use shorter strings or split into multiple requests'
        );
      }
      return;
    }

    if (Array.isArray(value)) {
      if (value.length > this.limits.maxArrayElements) {
        throw new InputError(
          `Array exceeds maximum elements at "${path}"`,
          { path, length: value.length, limit: this.limits.maxArrayElements },
          'Reduce the number of array elements or split into multiple requests'
        );
      }
      value.forEach((item, index) => {
        this.validateValue(item, depth + 1, `${path}[${index}]`);
      });
      return;
    }

    if (typeof value === 'object') {
      const keys = Object.keys(value);
      if (keys.length > this.limits.maxObjectKeys) {
        throw new InputError(
          `Object exceeds maximum keys at "${path}"`,
          { path, count: keys.length, limit: this.limits.maxObjectKeys },
          'Reduce the number of object properties or split into multiple requests'
        );
      }
      for (const key of keys) {
        this.validateValue((value as Record<string, unknown>)[key], depth + 1, `${path}.${key}`);
      }
    }
  }

  /**
   * Check if a key name appears to contain sensitive data
   */
  isSensitiveKey(key: string): boolean {
    return SENSITIVE_PATTERNS.some((pattern) => pattern.test(key));
  }

  /**
   * Redact sensitive values in an object (for logging/errors)
   */
  redactSensitive(data: Record<string, unknown>): Record<string, unknown> {
    return this.redactValue(data) as Record<string, unknown>;
  }

  /**
   * Recursively redact sensitive values
   */
  private redactValue(value: unknown): unknown {
    if (value === null || value === undefined) {
      return value;
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.redactValue(item));
    }

    if (typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        if (this.isSensitiveKey(key)) {
          result[key] = '[REDACTED]';
        } else {
          result[key] = this.redactValue(val);
        }
      }
      return result;
    }

    return value;
  }

  /**
   * Sanitize error message to remove sensitive paths and data
   */
  sanitizeErrorMessage(message: string): string {
    let sanitized = message;

    // Redact file paths
    for (const pattern of PATH_PATTERNS) {
      sanitized = sanitized.replace(pattern, '[PATH]');
    }

    // Redact URLs with credentials
    sanitized = sanitized.replace(
      /https?:\/\/[^:]+:[^@]+@[^\s]+/g,
      '[URL_WITH_CREDENTIALS]'
    );

    // Redact base64 that might be auth headers
    sanitized = sanitized.replace(
      /Basic\s+[A-Za-z0-9+/]+=*/gi,
      'Basic [REDACTED]'
    );

    // Redact bearer tokens
    sanitized = sanitized.replace(
      /Bearer\s+[A-Za-z0-9._-]+/gi,
      'Bearer [REDACTED]'
    );

    return sanitized;
  }

  /**
   * Sanitize an error object for safe logging
   */
  sanitizeError(error: Error): Error {
    const sanitizedMessage = this.sanitizeErrorMessage(error.message);

    if (sanitizedMessage === error.message) {
      return error;
    }

    const sanitizedError = new Error(sanitizedMessage);
    sanitizedError.name = error.name;
    if (error.stack) {
      sanitizedError.stack = this.sanitizeErrorMessage(error.stack);
    }

    return sanitizedError;
  }
}

/**
 * Singleton instance
 */
let instance: InputSanitizer | null = null;

/**
 * Get the input sanitizer singleton
 */
export function getInputSanitizer(): InputSanitizer {
  if (!instance) {
    instance = new InputSanitizer();
  }
  return instance;
}

