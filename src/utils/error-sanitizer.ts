/**
 * Pure sanitizers for error messages and structured error details.
 */

const PATH_PATTERNS = [
  /\/Users\/[^/\s]+/g,
  /\/home\/[^/\s]+/g,
  /C:\\Users\\[^\\]+/gi,
  /\.config\/mainwpcontrol/g,
];

export function sanitizeErrorMessage(message: string): string {
  let sanitized = message;

  for (const pattern of PATH_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[PATH]');
  }

  // Password is optional: `https://alice@host` still leaks a username.
  sanitized = sanitized.replace(
    /https?:\/\/[^\s@/]+(?::[^\s@]*)?@[^\s]+/g,
    '[URL_WITH_CREDENTIALS]'
  );
  sanitized = sanitized.replace(
    /Basic\s+[A-Za-z0-9+/]+=*/gi,
    'Basic [REDACTED]'
  );
  sanitized = sanitized.replace(
    /Bearer\s+[A-Za-z0-9._-]+/gi,
    'Bearer [REDACTED]'
  );

  return sanitized;
}

// Error details can carry parsed API responses (hostile input): a deeply
// nested payload or a locally-attached cyclic structure must not overflow
// the stack while being sanitized. The WeakSet tracks the current ancestor
// path (not all visited objects) so legitimately shared references survive.
const MAX_SANITIZE_DEPTH = 8;

export function sanitizeErrorValue(
  value: unknown,
  depth = 0,
  path: WeakSet<object> = new WeakSet()
): unknown {
  if (typeof value === 'string') {
    return sanitizeErrorMessage(value);
  }

  if (value !== null && typeof value === 'object') {
    if (path.has(value) || depth >= MAX_SANITIZE_DEPTH) {
      return '[TRUNCATED]';
    }
    path.add(value);

    const result = Array.isArray(value)
      ? value.map((item) => sanitizeErrorValue(item, depth + 1, path))
      : Object.fromEntries(
          Object.entries(value).map(([key, item]) => [
            sanitizeErrorMessage(key),
            sanitizeErrorValue(item, depth + 1, path),
          ])
        );

    path.delete(value);
    return result;
  }

  return value;
}
