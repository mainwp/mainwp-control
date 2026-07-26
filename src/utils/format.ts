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
 * `https:user:pass@host` carries real userinfo. `file:` is excluded on purpose:
 * it takes no credentials, and treating it as special rewrote `file:u:p@h/x`,
 * which is a local path.
 */
const SPECIAL_SCHEMES = new Set(['http', 'https', 'ws', 'wss', 'ftp']);

/**
 * Characters that end an authority: only those the parser itself treats as
 * structural.
 *
 * Nothing else belongs here. `" < > ` { } | ^` were briefly included on the
 * grounds that RFC 3986 forbids them, which is true but irrelevant: the WHATWG
 * parser percent-encodes them inside userinfo rather than rejecting, so
 * `https://user:pa"ss@host` really does carry a password and ending the
 * authority at the quote walked straight past its `@`. Sub-delimiters are out
 * for the same reason. Deciding what is credentialed is left to the parser
 * below; this set only finds candidates.
 */
const AUTHORITY_TERMINATORS = new Set(['/', '?', '#', ' ', '\t', '\n', '\r']);

function isSchemeChar(code: number): boolean {
  const isAlpha = (code >= 97 && code <= 122) || (code >= 65 && code <= 90);
  const isDigit = code >= 48 && code <= 57;
  return isAlpha || isDigit || code === 43 || code === 46 || code === 45; // + . -
}

function isAlphaCode(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 65 && code <= 90);
}

/**
 * Characters a host can actually be made of. Quotes, braces and the like are
 * not forbidden host code points, so the parser will accept them, but their
 * presence means the "authority" is really surrounding text.
 */
const PLAUSIBLE_HOST = /^[A-Za-z0-9._~%:[\]-]+$/;

/**
 * True for a character that can appear in a host.
 *
 * The bracket characters are excluded: they belong to a host only around an
 * IPv6 literal, which `hostEnd` handles separately, and treating a stray `]` as
 * a host character made `[https://u:p@h.t]` ask the parser about the host
 * `h.t]`, which it rejects outright.
 *
 * Anything above ASCII counts, because the parser punycodes internationalized
 * hosts rather than rejecting them. Stopping at the first such character
 * truncated `https://u:p@\u043f\u0440\u0438\u043c\u0435\u0440.example.com`
 * to `https://u:p@`, which does not parse, and the credential stayed visible.
 */
function isHostChar(char: string): boolean {
  const code = char.charCodeAt(0);
  if (code > 127) return true;
  const isAlpha = (code >= 97 && code <= 122) || (code >= 65 && code <= 90);
  const isDigit = code >= 48 && code <= 57;
  return (
    isAlpha ||
    isDigit ||
    code === 46 || // .
    code === 95 || // _
    code === 126 || // ~
    code === 37 || // %
    code === 58 || // :
    code === 45 // -
  );
}

/**
 * True when `candidate` parses as a URL carrying a username or password, and
 * what it parsed as the host could be one.
 *
 * The parser decides whether userinfo is present, because no character table
 * gets that right: it percent-encodes `"` inside userinfo, so
 * `https://user:pa"ss@host` really does carry a password. But it is equally
 * happy to read `h.test","user":"a` as userinfo and `b"}` as the host when a URL
 * sits inside a JSON error body, so the host it produced has to be believable
 * before the match counts.
 */
/** Where the host starting at `from` stops, bounded by `limit`. */
function hostEnd(text: string, from: number, limit: number): number {
  let end = from;
  // An IPv6 literal is the one place brackets belong; take the whole `[...]`.
  if (text[end] === '[') {
    while (end < limit && text[end] !== ']') end++;
    if (end < limit) end++;
  }
  while (end < limit && isHostChar(text[end]!)) end++;
  return end;
}

function parsesWithCredentials(candidate: string): boolean {
  try {
    const parsed = new URL(candidate);
    if (!parsed.username && !parsed.password) return false;
    return PLAUSIBLE_HOST.test(parsed.host);
  } catch {
    return false;
  }
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

  const spans: { start: number; end: number; obscured: boolean }[] = [];

  // One forward pass. Authority state is carried in these, so each character is
  // visited once: a per-colon loop with a backward lastIndexOf for the `@` is
  // quadratic when many short authorities sit after a distant `@`.
  let authorityStart = -1;
  let schemeStart = -1;
  let lastAt = -1;
  // Start of the current run of scheme-legal characters, maintained forward so
  // a scheme of any length is recognised in O(1); a bounded backward walk
  // missed schemes longer than its limit, and an unbounded one is quadratic.
  let tokenStart = 0;

  const closeAuthority = (scanEnd: number): void => {
    // `lastAt > authorityStart`, not `>= 0`: an empty userinfo (`https://@host`,
    // or one the parser emptied by dropping control characters) carries no
    // credentials, so masking it would claim one had been there.
    if (
      authorityStart >= 0 &&
      lastAt > authorityStart &&
      // Ask the parser rather than trusting the scan: it accepts characters in
      // userinfo that no hand-written terminator set gets right. The candidate
      // stops where the host stops, so a trailing delimiter cannot follow it in
      // — `<https://u:p@h.t>` would otherwise ask the parser about a host of
      // `h.t>`, which it rejects outright, and the credential would survive.
      parsesWithCredentials(scan.slice(schemeStart, hostEnd(scan, lastAt + 1, scanEnd)))
    ) {
      // Only the userinfo is rewritten. Replacing from the scheme instead let a
      // span whose offsets had shifted swallow the prose in front of it, so
      // `PRE\nhttps://u:p@h` lost `PRE` as well as the credential.
      const start = sourceIndex[authorityStart]!;
      const stop = sourceIndex[lastAt]! + 1;
      // Characters the parser dropped sit inside this userinfo, so it cannot be
      // rewritten in place without guessing where the credential sat.
      const obscured = stop - start !== lastAt + 1 - authorityStart;
      spans.push({ start, end: stop, obscured });
    }
    authorityStart = -1;
    schemeStart = -1;
    lastAt = -1;
  };

  let index = 0;
  while (index < scan.length) {
    const char = scan[index]!;

    if (char === ':') {
      const isScheme = tokenStart < index && isAlphaCode(scan.charCodeAt(tokenStart));
      if (isScheme) {
        const scheme = scan.slice(tokenStart, index).toLowerCase();
        const special = SPECIAL_SCHEMES.has(scheme);
        // A special scheme treats backslashes as slashes; others do not, so
        // `custom:\\u:p@h` is a path and carries no userinfo.
        let after = index + 1;
        while (
          after < scan.length &&
          (scan[after] === '/' || (special && scan[after] === '\\'))
        ) {
          after++;
        }
        const slashes = after - (index + 1);
        // Special schemes get an authority after any slash run, and after none
        // at all — but only when no authority is already open, or `http:` sitting
        // inside a password would close the URL it belongs to. Other schemes
        // need a real `//`; `custom:/u:p@h` is a path, not an authority.
        const opensAuthority = special ? slashes > 0 || authorityStart < 0 : slashes >= 2;
        if (opensAuthority) {
          // A new URL begins, so whatever authority was open ends here. This is
          // what keeps `https://safe,https://u:p@h` from swallowing the second.
          closeAuthority(tokenStart);
          schemeStart = tokenStart;
          authorityStart = after;
          index = after;
          tokenStart = after;
          continue;
        }
      }
      index++;
      tokenStart = index;
      continue;
    }

    if (authorityStart >= 0 && AUTHORITY_TERMINATORS.has(char)) {
      closeAuthority(index);
      index++;
      tokenStart = index;
      continue;
    }
    if (authorityStart >= 0 && char === '@') lastAt = index;
    if (!isSchemeChar(scan.charCodeAt(index))) tokenStart = index + 1;
    index++;
  }
  closeAuthority(scan.length);

  if (spans.length === 0) {
    return text;
  }

  let output = '';
  let cursor = 0;
  for (const span of spans) {
    // A fail-closed span can extend over a later one; skip what it covered.
    if (span.start < cursor) continue;
    output += text.slice(cursor, span.start);
    output += span.obscured ? '[URL_WITH_CREDENTIALS_REDACTED]' : '***:***@';
    cursor = span.end;
  }
  return output + text.slice(cursor);
}
