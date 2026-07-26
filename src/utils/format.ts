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
 * Schemes the WHATWG parser gives an authority even without `//`, so
 * `https:user:pass@host` carries real userinfo.
 */
const SPECIAL_SCHEMES = new Set(['http', 'https', 'ws', 'wss', 'ftp', 'file']);

/** Longest scheme this scanner will look back for. */
const MAX_SCHEME_LENGTH = 32;

/** Characters that end an authority. */
const AUTHORITY_TERMINATORS = new Set(['/', '?', '#', ' ', '\t', '\n', '\r']);

function isSchemeChar(code: number, first: boolean): boolean {
  const isAlpha = (code >= 97 && code <= 122) || (code >= 65 && code <= 90);
  if (first) return isAlpha;
  const isDigit = code >= 48 && code <= 57;
  return isAlpha || isDigit || code === 43 || code === 46 || code === 45; // + . -
}

/**
 * Walk back from a colon over scheme characters. Returns where the scheme
 * starts, or -1 if what precedes the colon is not one. Bounded by
 * MAX_SCHEME_LENGTH so this stays linear over the whole string: an unanchored
 * `[a-z][a-z0-9+.-]*:` regex rescans long letter runs from every position and
 * measures quadratic.
 */
function findSchemeStart(text: string, colon: number): number {
  const floor = Math.max(0, colon - MAX_SCHEME_LENGTH);
  let index = colon - 1;
  while (index >= floor && isSchemeChar(text.charCodeAt(index), false)) {
    index--;
  }
  const start = index + 1;
  if (start >= colon) return -1;
  return isSchemeChar(text.charCodeAt(start), true) ? start : -1;
}

/**
 * Mask userinfo in any URLs embedded within arbitrary text.
 *
 * SECURITY: Error messages (e.g. fetch failures) can echo a full request URL
 * including embedded credentials from a legacy profile.
 *
 * Implemented as a linear scan rather than a pattern, after three regex
 * attempts each missed a case. The scan runs over a copy with tab/CR/LF
 * removed, because the URL parser discards those characters anywhere —
 * including inside `://` — so `https:\n//user:pass@host` is credentialed even
 * though no pattern anchored on a literal `://` can see it. Offsets are mapped
 * back so only the matching span is rewritten and surrounding lines survive.
 *
 * @param text - Text that may contain credentialed URLs
 * @returns The text with each URL's userinfo replaced by `***:***@`, or that
 * span replaced by `[URL_WITH_CREDENTIALS_REDACTED]` when control characters
 * obscured it and it cannot be safely rewritten
 */
export function maskUrlUserinfoInText(text: string): string {
  if (!text.includes('@')) {
    return text;
  }

  // Strip what the parser ignores, keeping a map back to the original offsets.
  let scan = '';
  const sourceIndex: number[] = [];
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === '\t' || char === '\n' || char === '\r') continue;
    scan += char;
    sourceIndex.push(index);
  }

  const spans: { start: number; end: number; obscured: boolean; prefix: string }[] = [];
  let colon = scan.indexOf(':');

  while (colon !== -1) {
    const schemeStart = findSchemeStart(scan, colon);
    if (schemeStart === -1) {
      colon = scan.indexOf(':', colon + 1);
      continue;
    }

    const scheme = scan.slice(schemeStart, colon).toLowerCase();
    let authorityStart = colon + 1;
    if (scan.startsWith('//', authorityStart)) {
      authorityStart += 2;
    } else if (!SPECIAL_SCHEMES.has(scheme)) {
      // `mailto:user@host` and friends have no authority, so the `@` is data.
      colon = scan.indexOf(':', colon + 1);
      continue;
    }

    let end = authorityStart;
    while (end < scan.length && !AUTHORITY_TERMINATORS.has(scan[end]!)) end++;

    // Greedy to the LAST `@` in the authority, so a password containing `@`
    // masks completely. Resuming just past it (rather than past the whole
    // authority) is what lets a second URL sharing this run still be found,
    // while still visiting each character a bounded number of times.
    const lastAt = scan.lastIndexOf('@', end - 1);
    if (lastAt < authorityStart) {
      colon = scan.indexOf(':', Math.max(end, colon + 1));
      continue;
    }
    colon = scan.indexOf(':', lastAt + 1);

    // Normally only `scheme://userinfo@` is rewritten, leaving the host in
    // place. A span the parser reshaped cannot be rewritten in place without
    // guessing where the credential sat, so that one fails closed over the
    // whole authority.
    const scanStop = lastAt + 1;
    const start = sourceIndex[schemeStart]!;
    const stop = sourceIndex[scanStop - 1]! + 1;
    const obscured = stop - start !== scanStop - schemeStart;
    spans.push({
      start,
      end: obscured ? sourceIndex[end - 1]! + 1 : stop,
      obscured,
      prefix: scan.slice(schemeStart, authorityStart),
    });
  }

  if (spans.length === 0) {
    return text;
  }

  let output = '';
  let cursor = 0;
  for (const span of spans) {
    // A fail-closed span can extend over a later one; skip what it covered.
    if (span.start < cursor) continue;
    output += text.slice(cursor, span.start);
    output += span.obscured ? '[URL_WITH_CREDENTIALS_REDACTED]' : `${span.prefix}***:***@`;
    cursor = span.end;
  }
  return output + text.slice(cursor);
}
