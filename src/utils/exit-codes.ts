/**
 * Exit codes for mainwpctl
 *
 * These codes are stable and documented. Do not change without updating docs.
 */

export const ExitCode = {
  /** Operation completed successfully */
  SUCCESS: 0,

  /** User, schema, or input error */
  INPUT_ERROR: 1,

  /** Authentication or configuration error */
  AUTH_ERROR: 2,

  /** Network or TLS error */
  NETWORK_ERROR: 3,

  /** API or ability execution error */
  API_ERROR: 4,

  /** Internal error (stack trace only with --debug) */
  INTERNAL_ERROR: 5,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/**
 * Get human-readable name for an exit code
 */
export function exitCodeName(code: ExitCodeValue): string {
  const names: Record<ExitCodeValue, string> = {
    [ExitCode.SUCCESS]: 'SUCCESS',
    [ExitCode.INPUT_ERROR]: 'INPUT_ERROR',
    [ExitCode.AUTH_ERROR]: 'AUTH_ERROR',
    [ExitCode.NETWORK_ERROR]: 'NETWORK_ERROR',
    [ExitCode.API_ERROR]: 'API_ERROR',
    [ExitCode.INTERNAL_ERROR]: 'INTERNAL_ERROR',
  };
  return names[code] ?? 'UNKNOWN';
}
