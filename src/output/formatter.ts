/**
 * Human-readable output formatter for mainwpctl
 */

import { isMainWPCTLError } from '../utils/errors.js';

/**
 * ANSI color codes (only used when stdout is a TTY)
 */
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

/**
 * Check if we should use colors
 */
function useColors(): boolean {
  return process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined;
}

/**
 * Apply color if colors are enabled
 */
function color(text: string, ...codes: string[]): string {
  if (!useColors()) {
    return text;
  }
  return codes.join('') + text + colors.reset;
}

/**
 * Format a success message
 */
export function formatSuccess(message: string): string {
  return color('✓ ', colors.green) + message;
}

/**
 * Format an error message
 */
export function formatError(error: Error | string): string {
  const message = error instanceof Error ? error.message : error;
  let output = color('✗ Error: ', colors.red, colors.bold) + message;

  if (isMainWPCTLError(error) && error.details) {
    output += '\n' + color('  Details: ', colors.dim) + JSON.stringify(error.details);
  }

  return output;
}

/**
 * Format a warning message
 */
export function formatWarning(message: string): string {
  return color('⚠ Warning: ', colors.yellow) + message;
}

/**
 * Format an info message
 */
export function formatInfo(message: string): string {
  return color('ℹ ', colors.blue) + message;
}

/**
 * Format a heading
 */
export function formatHeading(text: string): string {
  return color(text, colors.bold, colors.cyan);
}

/**
 * Format a key-value pair
 */
export function formatKeyValue(key: string, value: unknown): string {
  const valueStr = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return color(key + ': ', colors.dim) + valueStr;
}

/**
 * Format a table of data
 */
export function formatTable(
  headers: string[],
  rows: string[][]
): string {
  if (rows.length === 0) {
    return '(no data)';
  }

  // Calculate column widths
  const widths = headers.map((h, i) => {
    const rowWidths = rows.map((r) => (r[i] ?? '').length);
    return Math.max(h.length, ...rowWidths);
  });

  // Format header
  const headerLine = headers
    .map((h, i) => h.padEnd(widths[i] ?? 0))
    .join('  ');

  const separator = widths.map((w) => '-'.repeat(w)).join('  ');

  // Format rows
  const dataLines = rows.map((row) =>
    row.map((cell, i) => (cell ?? '').padEnd(widths[i] ?? 0)).join('  ')
  );

  return [
    color(headerLine, colors.bold),
    separator,
    ...dataLines,
  ].join('\n');
}

/**
 * Format a list of items
 */
export function formatList(items: string[], bullet = '•'): string {
  return items.map((item) => `  ${bullet} ${item}`).join('\n');
}

/**
 * Format a preview/dry-run result
 */
export function formatPreview(
  action: string,
  affectedItems: unknown
): string {
  const lines = [
    color('Preview: ', colors.yellow, colors.bold) + action,
    '',
    color('Affected items:', colors.dim),
    JSON.stringify(affectedItems, null, 2),
    '',
    color('This is a preview. No changes have been made.', colors.yellow),
    'To execute, run the command with --confirm',
  ];

  return lines.join('\n');
}

/**
 * Format a progress bar
 */
export function formatProgressBar(percent: number, width = 20): string {
  const clampedPercent = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clampedPercent / 100) * width);
  const empty = width - filled;

  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  const percentStr = `${clampedPercent}%`.padStart(4);

  return `[${bar}] ${percentStr}`;
}

/**
 * Format elapsed time
 */
export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  }

  if (minutes > 0) {
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  }

  return `${seconds}s`;
}
