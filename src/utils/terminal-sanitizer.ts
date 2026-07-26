/**
 * Terminal Output Sanitizer for mainwpcontrol
 *
 * Security utility to strip ANSI escape sequences and control characters
 * from untrusted data before rendering to terminal output.
 *
 * Prevents:
 * - Terminal escape sequence injection
 * - Fake prompt attacks
 * - Screen manipulation/overwriting
 * - OSC command execution
 */

/**
 * Regular expressions for matching escape sequences
 */
const ESCAPE_PATTERNS = {
  // ANSI escape sequences: ESC [ ... (CSI sequences)
  // Matches: colors, cursor movement, screen clearing, etc.
  csi: /\x1b\[[0-9;]*[A-Za-z]/g,

  // Operating System Command sequences: ESC ] ... ST
  // Used for setting window titles, clipboard, etc.
  //
  // The body is a negated class rather than a lazy `[\s\S]*?`: a lazy body with
  // an alternation terminator rescans to end-of-input from every `ESC ]` when no
  // terminator exists, which is quadratic on hostile input. A body that cannot
  // contain its own terminator fails linearly instead. An unterminated sequence
  // is left for the bare-ESC sweep at the end of stripControlChars, so nothing
  // escapes; it just no longer swallows an arbitrary span of legitimate text.
  osc: /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g,

  // Single-character escape sequences: ESC followed by single char
  singleEsc: /\x1b[^[\]]/g,

  // C1 control characters (0x80-0x9F)
  c1: /[\x80-\x9f]/g,

  // Device Control Strings: ESC P ... ST
  // Negated bodies, for the same linear-failure reason as `osc` above.
  dcs: /\x1bP[^\x1b]*(?:\x1b\\)/g,

  // Application Program Command: ESC _ ... ST
  apc: /\x1b_[^\x1b]*(?:\x1b\\)/g,

  // Privacy Message: ESC ^ ... ST
  pm: /\x1b\^[^\x1b]*(?:\x1b\\)/g,

  // Start of String: ESC X ... ST
  sos: /\x1bX[^\x1b]*(?:\x1b\\)/g,
};

/**
 * C0 control characters to remove (0x00-0x1F)
 * Preserves: \t (0x09), \n (0x0A), \r (0x0D)
 */
const C0_UNSAFE = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;

/**
 * Unicode bidirectional and isolate controls (U+202A–U+202E, U+2066–U+2069).
 * Hostile names could otherwise visually reorder terminal output and spoof
 * copy-pasteable commands. job-id validation rejects the same range.
 */
const BIDI_CONTROLS = /[‪-‮⁦-⁩]/g;

/**
 * Strip all ANSI escape sequences and control characters from a string.
 *
 * This is the core sanitization function that removes:
 * - ANSI CSI sequences (colors, cursor movement, screen control)
 * - OSC sequences (window titles, clipboard commands)
 * - Other escape sequences (DCS, APC, PM, SOS)
 * - C0 control characters (except tab, newline, carriage return)
 * - C1 control characters
 *
 * @param str - The string to sanitize
 * @returns The sanitized string with all escape sequences removed
 */
export function stripControlChars(str: string): string {
  if (typeof str !== 'string') {
    return '';
  }

  let result = str;

  // Remove all escape sequence types
  result = result.replace(ESCAPE_PATTERNS.osc, '');
  result = result.replace(ESCAPE_PATTERNS.dcs, '');
  result = result.replace(ESCAPE_PATTERNS.apc, '');
  result = result.replace(ESCAPE_PATTERNS.pm, '');
  result = result.replace(ESCAPE_PATTERNS.sos, '');
  result = result.replace(ESCAPE_PATTERNS.csi, '');
  result = result.replace(ESCAPE_PATTERNS.singleEsc, '');

  // Remove control characters
  result = result.replace(ESCAPE_PATTERNS.c1, '');
  result = result.replace(C0_UNSAFE, '');
  result = result.replace(BIDI_CONTROLS, '');

  // Remove any remaining bare ESC characters
  result = result.replace(/\x1b/g, '');

  return result;
}

/**
 * Sanitize untrusted text for a single terminal output line.
 *
 * Removes terminal control sequences, then replaces any run of line-breaking
 * or horizontal-tab characters with one space to prevent line injection.
 */
export function sanitizeSingleLine(str: string): string {
  return stripControlChars(str).replace(/[\r\n\t]+/g, ' ');
}

/**
 * Sanitize untrusted multi-line free text (ability descriptions, instruction
 * blocks) for terminal output.
 *
 * Strips terminal control sequences like the single-line variant but keeps
 * newlines, so a legitimate multi-paragraph description still renders across
 * lines instead of being collapsed onto one. Carriage returns (lone or as part
 * of CRLF) are normalized to a newline so a hostile field cannot return the
 * cursor to column 0 and overwrite what was already printed.
 */
export function sanitizeMultiLine(str: string): string {
  return stripControlChars(str)
    .replace(/\r\n?/g, '\n')
    // Tabs jump to the next tab stop, which lets hostile text align itself into
    // fake columns; the single-line variant collapses them for the same reason.
    .replace(/\t/g, ' ');
}

/**
 * Sanitized values can originate from hostile API responses: the traversal
 * is depth-bounded so deep nesting cannot overflow the stack, and the
 * current ancestor path is tracked so cycles terminate. Tracking the path
 * (not all visited objects) keeps legitimately shared references intact —
 * command envelopes do reuse objects across fields.
 */
const MAX_SANITIZE_DEPTH = 64;

/**
 * Recursively sanitize a value for safe terminal output.
 *
 * Handles:
 * - Strings: strips control characters
 * - Arrays: recursively sanitizes each element
 * - Objects: recursively sanitizes each value
 * - Other types: converted to string and sanitized
 *
 * Cyclic or deeper-than-bound structures are replaced with '[TRUNCATED]'
 * rather than overflowing the stack.
 *
 * @param value - The value to sanitize
 * @returns A sanitized copy of the value (original is not modified)
 */
export function sanitizeForTerminal(value: unknown): unknown {
  return sanitizeForTerminalBounded(value, 0, new WeakSet());
}

function sanitizeForTerminalBounded(
  value: unknown,
  depth: number,
  path: WeakSet<object>
): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return stripControlChars(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'object') {
    if (path.has(value) || depth >= MAX_SANITIZE_DEPTH) {
      return '[TRUNCATED]';
    }
    path.add(value);

    let result: unknown;
    if (Array.isArray(value)) {
      result = value.map((item) => sanitizeForTerminalBounded(item, depth + 1, path));
    } else {
      // Null prototype so a hostile "__proto__" key lands as an ordinary
      // data property instead of rewriting the accumulator's prototype.
      const sanitized: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [key, val] of Object.entries(value)) {
        // Sanitize both keys and values
        const sanitizedKey = stripControlChars(key);
        sanitized[sanitizedKey] = sanitizeForTerminalBounded(val, depth + 1, path);
      }
      result = sanitized;
    }

    path.delete(value);
    return result;
  }

  // For other types (functions, symbols, etc.), convert to string and sanitize
  return stripControlChars(String(value));
}

/**
 * Sanitize a string for safe display, preserving safe content.
 *
 * This is a convenience wrapper that handles non-string inputs
 * by converting them to JSON first.
 *
 * @param value - The value to sanitize for display
 * @returns A safe string suitable for terminal output
 */
export function safeString(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  if (value === undefined) {
    return 'undefined';
  }

  if (typeof value === 'string') {
    return stripControlChars(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  // For objects and arrays, sanitize then stringify
  const sanitized = sanitizeForTerminal(value);
  return JSON.stringify(sanitized);
}

/**
 * Check if a string contains potentially dangerous escape sequences.
 *
 * Useful for logging or debugging when you want to detect
 * but not necessarily remove escape sequences.
 *
 * @param str - The string to check
 * @returns True if the string contains escape sequences
 */
export function containsEscapeSequences(str: string): boolean {
  if (typeof str !== 'string') {
    return false;
  }

  // Reset lastIndex on global regexes before test() to avoid
  // alternating true/false results from stateful .test() calls
  ESCAPE_PATTERNS.csi.lastIndex = 0;
  ESCAPE_PATTERNS.osc.lastIndex = 0;
  ESCAPE_PATTERNS.singleEsc.lastIndex = 0;
  ESCAPE_PATTERNS.c1.lastIndex = 0;
  ESCAPE_PATTERNS.dcs.lastIndex = 0;
  C0_UNSAFE.lastIndex = 0;

  return (
    ESCAPE_PATTERNS.csi.test(str) ||
    ESCAPE_PATTERNS.osc.test(str) ||
    ESCAPE_PATTERNS.singleEsc.test(str) ||
    ESCAPE_PATTERNS.c1.test(str) ||
    ESCAPE_PATTERNS.dcs.test(str) ||
    C0_UNSAFE.test(str) ||
    str.includes('\x1b')
  );
}
