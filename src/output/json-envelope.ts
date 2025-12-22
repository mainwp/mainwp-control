/**
 * JSON output envelope for mainwpctl
 *
 * This structure is stable and should not be changed without a major version bump.
 */

import { isMainWPCTLError, type MainWPCTLError } from '../utils/errors.js';

/**
 * Stable CLI output envelope
 */
export interface CLIOutput<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
    hint?: string;
  };
  meta?: {
    command: string;
    timestamp: string;
    version: string;
  };
}

/**
 * Create a success response
 */
export function successOutput<T>(
  data: T,
  meta?: { command: string; version: string }
): CLIOutput<T> {
  const output: CLIOutput<T> = {
    success: true,
    data,
  };

  if (meta) {
    output.meta = {
      command: meta.command,
      timestamp: new Date().toISOString(),
      version: meta.version,
    };
  }

  return output;
}

/**
 * Create an error response
 */
export function errorOutput(
  error: MainWPCTLError | Error | string,
  meta?: { command: string; version: string }
): CLIOutput<never> {
  let errorBody: CLIOutput<never>['error'];

  if (isMainWPCTLError(error)) {
    errorBody = {
      code: error.code,
      message: error.message,
      details: error.details,
    };
    if (error.hint) {
      errorBody.hint = error.hint;
    }
  } else if (error instanceof Error) {
    errorBody = {
      code: 'INTERNAL_ERROR',
      message: error.message,
    };
  } else {
    errorBody = {
      code: 'INTERNAL_ERROR',
      message: String(error),
    };
  }

  const output: CLIOutput<never> = {
    success: false,
  };

  if (errorBody) {
    output.error = errorBody;
  }

  if (meta) {
    output.meta = {
      command: meta.command,
      timestamp: new Date().toISOString(),
      version: meta.version,
    };
  }

  return output;
}

/**
 * Format output as JSON string
 */
export function formatJSON<T>(output: CLIOutput<T>): string {
  return JSON.stringify(output, null, 2);
}
