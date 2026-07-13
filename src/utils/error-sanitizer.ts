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

  sanitized = sanitized.replace(
    /https?:\/\/[^:]+:[^@]+@[^\s]+/g,
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

export function sanitizeErrorValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return sanitizeErrorMessage(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeErrorValue(item));
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        sanitizeErrorMessage(key),
        sanitizeErrorValue(item),
      ])
    );
  }

  return value;
}
