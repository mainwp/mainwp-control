/**
 * Pure sanitizers for error messages and structured error details.
 */

import { isSensitiveKey } from './redaction.js';

const PATH_PATTERNS = [
  /\/Users\/[^/\s]+/g,
  /\/home\/[^/\s]+/g,
  /C:\\Users\\[^\\]+/gi,
  /\.config\/mainwpcontrol/g,
];

/**
 * Longest error text scanned by the patterns below.
 *
 * Error strings reach here from hostile Dashboard response bodies, where the
 * transport's byte cap (10MB) is far too coarse to keep the credential scan
 * cheap. Any genuine error message is orders of magnitude shorter than this, so
 * truncating first bounds the work without losing real diagnostics.
 */
const MAX_ERROR_MESSAGE_LENGTH = 16384;

/**
 * Truncate without cutting through the middle of a token.
 *
 * Cutting mid-token hides credentials instead of redacting them: the patterns
 * below need the whole `user:pass@host` construct to match, so a URL sliced
 * before its `@` stops matching and the userinfo is emitted as plain text.
 * Ending on a whitespace boundary guarantees every token that survives is
 * complete. A single token longer than the limit carries no diagnostic value
 * and is dropped entirely rather than half-emitted.
 */
function truncateAtTokenBoundary(text: string, limit: number): string {
  const cut = text.slice(0, limit);
  const lastBoundary = cut.search(/\s\S*$/);
  return lastBoundary > 0 ? cut.slice(0, lastBoundary) : '';
}

export function sanitizeErrorMessage(message: string): string {
  let sanitized =
    message.length > MAX_ERROR_MESSAGE_LENGTH
      ? `${truncateAtTokenBoundary(message, MAX_ERROR_MESSAGE_LENGTH)}... [truncated]`
      : message;

  for (const pattern of PATH_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[PATH]');
  }

  // Password is optional: `https://alice@host` still leaks a username.
  // The host class excludes ":" so it cannot overlap the optional password
  // group — an ambiguous split would make a credential-less URL backtrack
  // quadratically before failing.
  sanitized = sanitized.replace(
    /https?:\/\/[^\s@/:]+(?::[^\s@]*)?@[^\s]+/g,
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

  // Query-string parameters whose key is on the shared sensitive list
  // (access_token, api_key, ...) — a URL like ?access_token=... carries the
  // credential outside the userinfo form handled above.
  sanitized = sanitized.replace(
    /([?&])([^=&\s"']{1,64})=([^&\s"']+)/g,
    (match, sep: string, key: string) =>
      isSensitiveKey(key) ? `${sep}${key}=[REDACTED]` : match
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
            // A sensitive key's value is a credential wherever it appears in
            // hostile error details — redact it outright instead of recursing.
            isSensitiveKey(key)
              ? '[REDACTED]'
              : sanitizeErrorValue(item, depth + 1, path),
          ])
        );

    path.delete(value);
    return result;
  }

  return value;
}
