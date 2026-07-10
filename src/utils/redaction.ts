/**
 * Shared sensitive-key redaction for mainwpcontrol
 *
 * Single source of truth for "does this key name look sensitive" used by
 * http-client's error sanitization, base-command's debug logging, and
 * input-sanitizer's error/log redaction. Consolidates three previously
 * independent term lists into one superset.
 */

/**
 * Case-insensitive substrings that mark a key as sensitive. Keys are
 * normalized (lowercased, `-`/`_` stripped) before matching, so this list
 * also catches separator variants (api-key, api_key, apikey) and compound
 * keys (apiToken, appPassword, X-Api-Key) without needing per-variant entries.
 *
 * TRADEOFF: this is plain substring matching, not word-boundary-aware, so a
 * key like "author" would also match "auth". That mirrors the pre-existing
 * behavior of the http-client and input-sanitizer implementations this util
 * replaces. Over-redaction (hiding a value that wasn't actually sensitive) is
 * the safe failure mode for error/debug output, so the tradeoff is accepted
 * rather than building a full boundary-aware matcher. No key in this
 * codebase's API surface collides with it today.
 */
const SENSITIVE_KEY_SUBSTRINGS = [
  // 'auth' also substring-matches 'authorization'; normalization folds
  // 'api_key'/'api-key' into 'apikey' — don't re-add those spellings.
  'password', 'secret', 'token', 'auth', 'cookie',
  'apikey', 'bearer', 'credential', 'private_key',
  'signing_key', 'encryption_key',
] as const;

/**
 * Normalize a key for matching: lowercase, strip `-`/`_` separators.
 */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '');
}

/** Pre-normalized match terms (separators stripped once, not per key). */
const NORMALIZED_TERMS = SENSITIVE_KEY_SUBSTRINGS.map((s) => normalizeKey(s));

/**
 * Check if a key name appears to reference sensitive data.
 */
export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return NORMALIZED_TERMS.some((term) => normalized.includes(term));
}

/**
 * Recursively redact values whose key matches {@link isSensitiveKey}.
 * Non-object values pass through unchanged; arrays are mapped element-wise.
 */
export function redactSensitiveKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveKeys(item));
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    redacted[key] = isSensitiveKey(key) ? '[REDACTED]' : redactSensitiveKeys(val);
  }
  return redacted;
}
