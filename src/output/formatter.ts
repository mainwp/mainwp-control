/**
 * Human-readable output formatter for mainwpcontrol
 */

import { isMainWPCTLError } from '../utils/errors.js';
import {
  sanitizeForTerminal,
  sanitizeSingleLine,
  safeString,
} from '../utils/terminal-sanitizer.js';
import { sanitizeErrorMessage, sanitizeErrorValue } from '../utils/error-sanitizer.js';
import { colors, color } from '../utils/colors.js';

/**
 * Format a success message
 */
export function formatSuccess(message: string): string {
  // Single-line: the message may interpolate untrusted values (ability names,
  // job status), so collapse escapes and line breaks like the other terminal fields.
  return color('✓ ', colors.green) + sanitizeSingleLine(message);
}

/**
 * Format an error message
 */
export function formatError(error: Error | string): string {
  // Single-line: hostile error text must not inject CR/LF and fake
  // subsequent output lines (anti-spoofing, same rule as other terminal fields).
  const message = sanitizeErrorMessage(
    sanitizeSingleLine(error instanceof Error ? error.message : error)
  );
  let output = color('✗ Error: ', colors.red, colors.bold) + message;

  if (isMainWPCTLError(error)) {
    if (error.details) {
      // Sanitize error details before display (untrusted API data)
      const sanitizedDetails = sanitizeErrorValue(sanitizeForTerminal(error.details));
      output += '\n' + color('  Details: ', colors.dim) + JSON.stringify(sanitizedDetails);
    }
    if (error.hint) {
      output += '\n' + color(
        '💡 ' + sanitizeErrorMessage(sanitizeSingleLine(error.hint)),
        colors.dim
      );
    }
  }

  return output;
}

/**
 * Format a warning message
 */
export function formatWarning(message: string): string {
  return color('⚠ Warning: ', colors.yellow) + sanitizeSingleLine(message);
}

/**
 * Format an info message
 */
export function formatInfo(message: string): string {
  return color('ℹ ', colors.blue) + sanitizeSingleLine(message);
}

/**
 * Format a heading
 *
 * Headings render untrusted Dashboard metadata (ability category, label) on the
 * human output path, which the JSON envelope sanitizes but the human path does
 * not. Sanitize here so every call site is safe rather than relying on each to
 * opt in.
 */
export function formatHeading(text: string): string {
  return color(sanitizeSingleLine(text), colors.bold, colors.cyan);
}

/**
 * Status for pass/warn/fail style reports (doctor, config show)
 */
export type StatusKind = 'pass' | 'warn' | 'fail';

/**
 * Format a colored status icon for pass/warn/fail states
 */
export function formatStatusIcon(status: StatusKind): string {
  switch (status) {
    case 'pass':
      return color('✓', colors.green);
    case 'warn':
      return color('⚠', colors.yellow);
    case 'fail':
      return color('✗', colors.red);
  }
}

/**
 * Get the color code associated with a pass/warn/fail status
 */
export function getStatusColor(status: StatusKind): string {
  switch (status) {
    case 'pass':
      return colors.green;
    case 'warn':
      return colors.yellow;
    case 'fail':
      return colors.red;
  }
}

/**
 * Format a fixed-width horizontal divider used by report-style commands
 */
export function formatDivider(width = 40): string {
  return '  ' + '─'.repeat(width);
}

/**
 * Format a titled section from pre-formatted rows
 */
export function formatSection(title: string, rows: string[]): string {
  return [`\n  ${color(title, colors.bold)}`, ...rows].join('\n');
}

/**
 * Format a key-value pair
 */
export function formatKeyValue(key: string, value: unknown): string {
  // Sanitize both key and value (may contain untrusted API data).
  // The value is collapsed to one row as well: safeString() strips escape
  // sequences but deliberately preserves \r, which on its own returns the
  // cursor to column 0 and overwrites the row that was just printed.
  const safeKey = sanitizeSingleLine(key);
  const valueStr = sanitizeSingleLine(safeString(value));
  return color(safeKey + ': ', colors.dim) + valueStr;
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

  // Sanitize all table data (may contain untrusted API data)
  const safeHeaders = headers.map((h) => sanitizeSingleLine(h));
  const safeRows = rows.map((row) => row.map((cell) => sanitizeSingleLine(cell ?? '')));

  // Calculate column widths using sanitized data
  const widths = safeHeaders.map((h, i) => {
    const rowWidths = safeRows.map((r) => (r[i] ?? '').length);
    return Math.max(h.length, ...rowWidths);
  });

  // Format header
  const headerLine = safeHeaders
    .map((h, i) => h.padEnd(widths[i] ?? 0))
    .join('  ');

  const separator = widths.map((w) => '-'.repeat(w)).join('  ');

  // Format rows
  const dataLines = safeRows.map((row) =>
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
  // Sanitize list items (may contain untrusted API data)
  return items.map((item) => `  ${bullet} ${sanitizeSingleLine(item)}`).join('\n');
}

/**
 * Format a preview/dry-run result
 */
export function formatPreview(
  action: string,
  affectedItems: unknown
): string {
  // Sanitize preview data (may contain untrusted API data)
  const sanitizedItems = sanitizeForTerminal(affectedItems);

  const lines = [
    color('Preview: ', colors.yellow, colors.bold) + sanitizeSingleLine(action),
    '',
    color('Affected items:', colors.dim),
    JSON.stringify(sanitizedItems, null, 2),
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
