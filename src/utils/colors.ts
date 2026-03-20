/**
 * Shared color utilities for mainwpctl
 *
 * Respects NO_COLOR env var and non-TTY detection.
 * All terminal coloring should go through these functions.
 */

/**
 * ANSI color codes
 */
export const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

/**
 * Check if we should use colored output
 */
export function useColors(): boolean {
  return process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined;
}

/**
 * Apply color if colors are enabled
 */
export function color(text: string, ...codes: string[]): string {
  if (!useColors()) {
    return text;
  }
  return codes.join('') + text + colors.reset;
}
