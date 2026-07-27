/**
 * Pure sanitizers for error messages and structured error details.
 */

import { isSensitiveKey } from './redaction.js';
import { isSensitiveParameterKey, maskUrlUserinfoInText } from './format.js';

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
 * Whitespace that may end a retained token, excluding tab/CR/LF.
 *
 * Those three are not boundaries here: the URL parser discards them, so
 * `https://user:secret\n...@host` is a single credential to it even though it
 * looks like two tokens. Cutting on the newline would keep
 * `https://user:secret`, which the credential pattern can no longer recognize.
 */
const SAFE_BOUNDARY = /[^\S\t\n\r]/;

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
  // Tab, CR and LF are NOT safe boundaries: the URL parser discards them, so
  // `https://user:secret\n...@host` is one credential to the parser even though
  // it looks like two tokens here. Cutting on the newline would keep
  // `https://user:secret`, which the pattern below can no longer recognize.
  // Scan back for the last usable boundary directly. A trailing-anchored
  // pattern cannot cross tabs or newlines that appear after it, so a message
  // ending in a long run of them discarded an otherwise fine prefix.
  for (let index = cut.length - 1; index >= 0; index--) {
    if (SAFE_BOUNDARY.test(cut[index]!)) {
      return cut.slice(0, index);
    }
  }
  return '';
}

export function sanitizeErrorMessage(message: string): string {
  let sanitized =
    message.length > MAX_ERROR_MESSAGE_LENGTH
      ? `${truncateAtTokenBoundary(message, MAX_ERROR_MESSAGE_LENGTH)}... [truncated]`
      : message;

  for (const pattern of PATH_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[PATH]');
  }

  // Embedded userinfo, delegated to the shared linear scanner. A local pattern
  // lived here through three rewrites and still missed an uppercase scheme, a
  // scheme split by a newline the URL parser discards, and a password
  // containing spaces (the Application Password format). The scanner masks the
  // userinfo in place and keeps scheme/host, which is the more useful
  // diagnostic than the old whole-URL placeholder.
  sanitized = maskUrlUserinfoInText(sanitized);

  // RFC 6750 b64token: `Basic`/`Bearer` values may use base64url (`-` `_`) and
  // the token68 extras (`.` `~` `+` `/`). Stopping at the first character
  // outside a narrower class left the credential's tail in the message.
  sanitized = sanitized.replace(
    /Basic\s+[A-Za-z0-9+/_-]+=*/gi,
    'Basic [REDACTED]'
  );
  sanitized = sanitized.replace(
    /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
    'Bearer [REDACTED]'
  );

  // Parameters whose key is on the shared sensitive list (access_token,
  // api_key, ...) — a URL like ?access_token=... carries the credential
  // outside the userinfo form handled above. `#` is a separator too: a
  // fragment-carried key never reaches a server but does reach the terminal.
  // `#` also has to leave the key/value classes, or a preceding harmless
  // parameter's value swallows `#api_key=...` and the scan never sees it.
  //
  // Classification is shared with the URL masker rather than calling
  // isSensitiveKey directly: the raw key is not the parameter's name, so
  // `api%5Fkey` would otherwise pass through with its value intact here even
  // though the same URL masks correctly on the display path. The character
  // classes stay local — this scans free prose, where quotes terminate a
  // value, not a whole URL.
  sanitized = sanitized.replace(
    /([?&#])([^=&#\s"']+)=([^&#\s"']+)/g,
    (match, sep: string, key: string) =>
      isSensitiveParameterKey(key) ? `${sep}${key}=[REDACTED]` : match
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
