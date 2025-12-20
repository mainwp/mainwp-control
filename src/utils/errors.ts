/**
 * Error classes for mainwpctl
 *
 * Each error class maps to a specific exit code.
 */

import { ExitCode, type ExitCodeValue } from './exit-codes.js';

/**
 * Base error class for mainwpctl errors
 */
export abstract class MainWPCTLError extends Error {
  abstract readonly exitCode: ExitCodeValue;
  abstract readonly code: string;

  constructor(
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

/**
 * Input validation error (exit code 1)
 */
export class InputError extends MainWPCTLError {
  readonly exitCode = ExitCode.INPUT_ERROR;
  readonly code = 'INPUT_ERROR';

  constructor(message: string, details?: unknown) {
    super(message, details);
  }
}

/**
 * Schema validation error (exit code 1)
 */
export class SchemaValidationError extends MainWPCTLError {
  readonly exitCode = ExitCode.INPUT_ERROR;
  readonly code = 'SCHEMA_VALIDATION_ERROR';

  constructor(
    message: string,
    public readonly validationErrors: unknown[]
  ) {
    super(message, { validationErrors });
  }
}

/**
 * Authentication error (exit code 2)
 */
export class AuthError extends MainWPCTLError {
  readonly exitCode = ExitCode.AUTH_ERROR;
  readonly code = 'AUTH_ERROR';

  constructor(message: string, details?: unknown) {
    super(message, details);
  }
}

/**
 * Configuration error (exit code 2)
 */
export class ConfigError extends MainWPCTLError {
  readonly exitCode = ExitCode.AUTH_ERROR;
  readonly code = 'CONFIG_ERROR';

  constructor(message: string, details?: unknown) {
    super(message, details);
  }
}

/**
 * Network error (exit code 3)
 */
export class NetworkError extends MainWPCTLError {
  readonly exitCode = ExitCode.NETWORK_ERROR;
  readonly code = 'NETWORK_ERROR';

  constructor(
    message: string,
    public readonly cause?: Error
  ) {
    super(message, cause ? { cause: cause.message } : undefined);
  }
}

/**
 * TLS/SSL error (exit code 3)
 */
export class TLSError extends MainWPCTLError {
  readonly exitCode = ExitCode.NETWORK_ERROR;
  readonly code = 'TLS_ERROR';

  constructor(message: string, details?: unknown) {
    super(message, details);
  }
}

/**
 * API error (exit code 4)
 */
export class APIError extends MainWPCTLError {
  readonly exitCode = ExitCode.API_ERROR;
  readonly code: string;

  constructor(
    code: string,
    message: string,
    public readonly statusCode?: number,
    details?: unknown
  ) {
    super(message, details);
    this.code = code;
  }
}

/**
 * Confirmation required error (exit code 4)
 */
export class ConfirmationRequiredError extends MainWPCTLError {
  readonly exitCode = ExitCode.API_ERROR;
  readonly code = 'CONFIRMATION_REQUIRED';

  constructor(
    message: string,
    public readonly preview?: unknown
  ) {
    super(message, { preview });
  }
}

/**
 * Mutual exclusion error (exit code 1)
 */
export class MutualExclusionError extends MainWPCTLError {
  readonly exitCode = ExitCode.INPUT_ERROR;
  readonly code = 'MUTUAL_EXCLUSION_ERROR';

  constructor(message = 'dry_run and confirm are mutually exclusive') {
    super(message);
  }
}

/**
 * Internal error (exit code 5)
 */
export class InternalError extends MainWPCTLError {
  readonly exitCode = ExitCode.INTERNAL_ERROR;
  readonly code = 'INTERNAL_ERROR';

  constructor(
    message: string,
    public readonly cause?: Error
  ) {
    super(message, cause ? { cause: cause.message } : undefined);
  }
}

/**
 * Check if an error is a MainWPCTLError
 */
export function isMainWPCTLError(error: unknown): error is MainWPCTLError {
  return error instanceof MainWPCTLError;
}

/**
 * Convert any error to a MainWPCTLError
 */
export function toMainWPCTLError(error: unknown): MainWPCTLError {
  if (isMainWPCTLError(error)) {
    return error;
  }

  if (error instanceof Error) {
    return new InternalError(error.message, error);
  }

  return new InternalError(String(error));
}
