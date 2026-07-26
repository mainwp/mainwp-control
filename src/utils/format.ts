/**
 * Formatting utilities for mainwpcontrol
 *
 * Provides consistent secret masking across all commands.
 */

/**
 * Options for customizing secret masking behavior
 */
export interface MaskOptions {
  /** Number of characters to show at the start (default: 4) */
  showFirst?: number;
  /** Number of characters to show at the end (default: 4) */
  showLast?: number;
  /** Minimum length before masking applies; shorter secrets return placeholder (default: 8) */
  minLength?: number;
  /** Placeholder string for secrets that are too short to mask (default: '****') */
  placeholder?: string;
}

/**
 * Masks a secret value by showing only the first and last few characters.
 *
 * @param value - The secret string to mask
 * @param options - Configuration options for masking behavior
 * @returns The masked string in format "xxxx...xxxx" or the placeholder if too short
 *
 * @example
 * ```ts
 * maskSecret('mypassword123') // Returns 'mypa...d123'
 * maskSecret('short') // Returns '****'
 * maskSecret('api-key-12345678', { showFirst: 6, showLast: 4 }) // Returns 'api-ke...5678'
 * ```
 */
export function maskSecret(value: string, options: MaskOptions = {}): string {
  const {
    showFirst = 4,
    showLast = 4,
    minLength = 8,
    placeholder = '****',
  } = options;

  if (!value || value.length <= minLength) {
    return placeholder;
  }

  return `${value.substring(0, showFirst)}...${value.substring(value.length - showLast)}`;
}

/**
 * Masks a password using standard format (4 chars...4 chars).
 *
 * Passwords 8 characters or shorter are fully masked with '****'.
 *
 * @param password - The password to mask
 * @returns The masked password
 *
 * @example
 * ```ts
 * maskPassword('mypassword123') // Returns 'mypa...d123'
 * maskPassword('short') // Returns '****'
 * ```
 */
export function maskPassword(password: string): string {
  return maskSecret(password, {
    showFirst: 4,
    showLast: 4,
    minLength: 8,
  });
}

/**
 * Masks an API key using standard format (6 chars...4 chars).
 *
 * API keys 10 characters or shorter are fully masked with '****'.
 *
 * @param apiKey - The API key to mask
 * @returns The masked API key
 *
 * @example
 * ```ts
 * maskApiKey('sk-1234567890abcdefghij') // Returns 'sk-123...ghij'
 * maskApiKey('shortkey') // Returns '****'
 * ```
 */
export function maskApiKey(apiKey: string): string {
  return maskSecret(apiKey, {
    showFirst: 6,
    showLast: 4,
    minLength: 10,
  });
}

/**
 * Mask userinfo (username/password) embedded in a URL.
 *
 * SECURITY: Profiles saved before userinfo rejection was added may still carry
 * `user:pass@` in the stored dashboard URL; every display path must mask it.
 *
 * Returns the input unchanged when it is not a parseable URL or has no
 * userinfo. String replacement (not URL re-serialization) keeps the rest of
 * the URL byte-for-byte identical — no trailing-slash normalization.
 *
 * @param url - The URL to mask
 * @returns The URL with userinfo replaced by `***:***@`, the input unchanged
 * when it has no userinfo, or `[URL_WITH_CREDENTIALS_REDACTED]` when userinfo
 * was detected but could not be isolated in the raw string
 *
 * @example
 * ```ts
 * maskUrlUserinfo('https://admin:secret@example.com') // 'https://***:***@example.com'
 * maskUrlUserinfo('https://example.com/path') // unchanged
 * ```
 */
/** The placeholder both userinfo components are replaced with. */
const MASKED_USERINFO = '***';

export function maskUrlUserinfo(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  if (!parsed.username && !parsed.password) {
    return url;
  }

  // Already masked. Re-masking would produce a byte-identical string, which
  // the fail-closed check below reads as "credentials the regex could not
  // isolate" and replaces with the sentinel. Masking must be idempotent: the
  // debug redactor applies it centrally, so a value can arrive here twice.
  // There is nothing to leak either way, since the userinfo is literally `***`.
  if (parsed.username === MASKED_USERINFO && parsed.password === MASKED_USERINFO) {
    return url;
  }

  // Greedy through the LAST @ in the authority: a password containing "@"
  // must not leak its tail. `?`/`#`/`/` bound the authority section.
  const masked = url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#\s]*@/i, '$1***:***@');

  // The parser saw userinfo the regex could not isolate: WHATWG parsing
  // strips tab/newline and trims C0 controls before detecting credentials,
  // so a raw string containing them slips past the whitespace-excluding
  // regex. Fail closed rather than echo the credentials.
  if (masked === url) {
    return '[URL_WITH_CREDENTIALS_REDACTED]';
  }

  return masked;
}

/**
 * Candidate URL spans inside free text.
 *
 * Tab/CR/LF are allowed *inside* a candidate (when followed by more non-space
 * text) because the WHATWG parser strips them before detecting credentials —
 * `https://user:sec\nret@host` carries userinfo even though a
 * whitespace-excluding pattern cannot see it. The two alternatives match
 * disjoint character sets, so matching stays linear.
 */
const URL_CANDIDATE = /[a-z][a-z0-9+.-]*:\/\/(?:[^\s]|[\t\n\r](?=[^\s]))*/gi;

/**
 * Mask userinfo in any URLs embedded within arbitrary text.
 *
 * SECURITY: Error messages (e.g. fetch failures) can echo a full request URL
 * including embedded credentials from a legacy profile.
 *
 * Each candidate URL is delegated to `maskUrlUserinfo`, so this shares that
 * function's fail-closed behavior: a credentialed URL the replacement cannot
 * isolate collapses to `[URL_WITH_CREDENTIALS_REDACTED]` instead of passing
 * through untouched.
 *
 * @param text - Text that may contain credentialed URLs
 * @returns The text with each `scheme://user:pass@` replaced by `scheme://***:***@`,
 * or the candidate replaced by `[URL_WITH_CREDENTIALS_REDACTED]` when its
 * credentials could not be isolated
 */
export function maskUrlUserinfoInText(text: string): string {
  return text.replace(URL_CANDIDATE, (candidate) => maskUrlUserinfo(candidate));
}
