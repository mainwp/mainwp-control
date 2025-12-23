/**
 * JSON output envelope for mainwpctl
 *
 * This structure is stable and should not be changed without a major version bump.
 */

import { isMainWPCTLError, type MainWPCTLError } from '../utils/errors.js';
import { sanitizeForTerminal, stripControlChars } from '../utils/terminal-sanitizer.js';

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
  // Sanitize data to prevent terminal escape injection in piped JSON
  const sanitizedData = sanitizeForTerminal(data) as T;

  const output: CLIOutput<T> = {
    success: true,
    data: sanitizedData,
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
      message: stripControlChars(error.message),
      details: error.details ? sanitizeForTerminal(error.details) : undefined,
    };
    if (error.hint) {
      errorBody.hint = stripControlChars(error.hint);
    }
  } else if (error instanceof Error) {
    errorBody = {
      code: 'INTERNAL_ERROR',
      message: stripControlChars(error.message),
    };
  } else {
    errorBody = {
      code: 'INTERNAL_ERROR',
      message: stripControlChars(String(error)),
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
