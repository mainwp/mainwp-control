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
