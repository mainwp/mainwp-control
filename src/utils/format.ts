/**
 * Formatting utilities for mainwpcontrol
 *
 * Provides consistent secret masking across all commands.
 */

import { isSensitiveKey } from './redaction.js';

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
const REDACTED_SENTINEL = '[URL_WITH_CREDENTIALS_REDACTED]';

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
    return REDACTED_SENTINEL;
  }

  return masked;
}

/**
 * Query and fragment parameters, for sensitive-key redaction.
 *
 * `#` is a separator alongside `?`/`&` and is excluded from the key and value
 * classes: without that, a harmless leading parameter's value swallows
 * `#api_key=...` and the fragment is never examined.
 */
const URL_PARAMETER = /([?&#])([^=&#\s]{1,64})=([^&#\s]*)/g;

/**
 * Classify a URL parameter key by its decoded spelling.
 *
 * The raw key is what a reader sees, but not what the parameter is named:
 * `api%5Fkey` normalizes to `api%5fkey`, matches nothing on the shared
 * sensitive list, and the secret goes out in full. Decoding cannot hide a term
 * the raw key already showed — it only collapses `%XX` triplets, never inserts
 * characters between literals — so the decoded form is the stricter test on its
 * own.
 *
 * An undecodable key (lone `%`, truncated escape, invalid UTF-8 sequence)
 * counts as sensitive. Redacting a value that was not a credential costs
 * display fidelity; failing open costs the credential.
 */
export function isSensitiveParameterKey(key: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(key);
  } catch {
    return true;
  }
  return isSensitiveKey(decoded);
}

/**
 * Mask everything credential-shaped in a URL for display: userinfo, plus the
 * value of any query or fragment parameter whose key — percent-decoded first —
 * is on the shared sensitive list.
 *
 * SECURITY: userinfo is rejected at intake, but profiles saved before that
 * check — and before query strings were rejected — can still carry
 * `?access_token=` or `#api_key=` in the stored dashboard URL. Every display
 * path must mask both forms.
 *
 * @param url - The URL to mask
 * @returns The URL with userinfo masked as `***:***@` and sensitive parameter
 * values replaced by `[REDACTED]`, or the userinfo sentinel when credentials
 * were detected but could not be isolated
 */
export function maskUrlCredentials(url: string): string {
  const masked = maskUrlUserinfo(url);
  if (masked === REDACTED_SENTINEL) {
    return masked;
  }
  // The original key spelling is preserved in the output; only classification
  // sees the decoded form.
  return masked.replace(URL_PARAMETER, (match, separator: string, key: string) =>
    isSensitiveParameterKey(key) ? `${separator}${key}=[REDACTED]` : match
  );
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
/**
 * How far past the last `@` the adjudicator will look for the end of an
 * authority. No credible URL carries a kilobyte of host and port, and without a
 * bound every candidate is sliced and parsed out to the next structural
 * character, which is where two separate quadratic blowups lived (repeated
 * scheme opens in terminator-free text, and an unclosed IPv6 bracket scanning
 * to end of input). Past the bound the scan fails closed and masks: for a real
 * oversized URL the verdict would have been "mask" anyway, and for oversized
 * junk over-masking is the documented safe direction.
 */
const MAX_AUTHORITY_SPAN = 1024;

/** Where the authority starting at `from` ends, bounded by `limit`. */
function authorityEnd(text: string, from: number, limit: number): number {
  let end = from;
  while (end < limit && !AUTHORITY_TERMINATORS.has(text[end]!)) end++;
  return end;
}

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

/**
 * How many single-character steps are offered as extra candidate extents, in
 * each direction, when the table-derived ones fail.
 *
 * Backward from the structural end, for a host made entirely of characters
 * outside the host table with a wrapper after it (`<https://u:p@!>`): the
 * conservative and trimmed extents collapse to nothing and the structural
 * extent swallows the `>`.
 *
 * Forward from the host start, for a host whose opening characters make every
 * longer extent unparseable: `https:/u:p@!>>>https://…` (a one-character host
 * glued to the next URL, where the structural end runs into that URL) and
 * `https:/u:p@xn--e1.ex/x` (a label the parser rejects as invalid punycode, so
 * only a prefix of the host parses). Both leaked until the short extents were
 * offered. The parser still decides; these only propose where to cut.
 */
const MAX_TRIM_STEPS = 8;

function hasCredentials(scan: string, schemeStart: number, hostStart: number): boolean {
  const limit = Math.min(scan.length, hostStart + MAX_AUTHORITY_SPAN);
  const structEnd = authorityEnd(scan, hostStart, limit);
  // No structural end within the window: fail closed (see MAX_AUTHORITY_SPAN).
  // The window has to be the thing that stopped the scan — running out of
  // input is a genuine end, not an oversized authority — and a terminator
  // sitting exactly at the window's edge is genuine too; both adjudicate.
  const stoppedByWindow = structEnd === limit && limit === hostStart + MAX_AUTHORITY_SPAN;
  const terminatorAtEdge = limit < scan.length && AUTHORITY_TERMINATORS.has(scan[limit]!);
  if (stoppedByWindow && !terminatorAtEdge) {
    return true;
  }
  // Three candidate extents, cheapest first. The conservative host stops at the
  // first character that is definitely not one, which separates
  // `one.t,https://…` into two URLs. The structural end accepts the many host
  // characters the parser allows and a character set keeps getting wrong
  // (`!example`, `%21example`, `,example`). But when both a weird host AND a
  // trailing wrapper are present — `<https://u:p@!host>` — the conservative
  // extent is empty and the structural one swallows the `>` and fails to
  // parse, so a third extent trims trailing non-host characters off the
  // structural end. The table still only finds candidates; the parser decides.
  let trimmedEnd = structEnd;
  while (trimmedEnd > hostStart && !isHostChar(scan[trimmedEnd - 1]!)) trimmedEnd--;
  const ends = [hostEnd(scan, hostStart, structEnd), trimmedEnd, structEnd];
  for (let step = 1; step <= MAX_TRIM_STEPS; step++) {
    ends.push(structEnd - step, Math.min(hostStart + step, structEnd));
  }
  let anyParsed = false;
  for (let i = 0; i < ends.length; i++) {
    const end = ends[i]!;
    if (end <= hostStart || ends.indexOf(end) !== i) continue;
    try {
      const parsed = new URL(scan.slice(schemeStart, end));
      anyParsed = true;
      if (parsed.username || parsed.password) return true;
    } catch {
      // This extent is not a URL; another may be.
    }
  }
  // Nothing parsed at any extent, so the parser never got to rule on the
  // credential — an unterminated IPv6 host (`https://u:p@[`) rejects every
  // candidate. The text still shows userinfo before an `@` inside an
  // authority this scan opened, and "no verdict" is not "no credential", so
  // this fails closed exactly as an oversized authority does.
  return !anyParsed;
}

function parsesWithCredentials(candidate: string): boolean {
  try {
    const parsed = new URL(candidate);
    return Boolean(parsed.username || parsed.password);
  } catch {
    return false;
  }
}

/**
 * How many `@` positions the spaced-userinfo look-ahead will offer the parser.
 * A WordPress Application Password contains spaces but no `@`, so one is the
 * realistic count; the bound keeps hostile text from turning each look-ahead
 * into an unbounded run of candidate parses.
 */
const MAX_LOOKAHEAD_ATS = 8;

/**
 * A WordPress Application Password is printed as six groups of four
 * alphanumeric characters separated by spaces. Used only to decide whether to
 * ask the parser about extending an *ambiguous* token — one that already
 * parses as a URL on its own — never to decide whether something is a
 * credential. See spacedUserinfoEnd.
 */
const APP_PASSWORD_GROUP = /^[A-Za-z0-9]{4}$/;

/**
 * The scan treats a space as the end of a URL, because in free text it almost
 * always is — but the parser percent-encodes spaces inside userinfo, and a
 * WordPress Application Password contains them, so `https://admin:AbCD 1234
 * efGH@host/x` is a credential the plain scan cannot see. When an authority
 * closes at a space with no `@` seen, this decides whether the token continues
 * through the space as userinfo.
 *
 * The discriminator is the parser, not a character rule: the look-ahead runs
 * unconditionally when the closed token alone does NOT parse as a URL.
 * `https://admin:AbCD` does not parse (its "port" is not a number), so the
 * text after the space is offered to the parser as userinfo continuation.
 *
 * When the token DOES parse alone the reading is ambiguous, because
 * `https://admin:1234` (a username and the first chunk of a spaced password)
 * and `https://host.test:8443` (a real host and port) are the same shape to
 * the parser. Declining outright leaked every digit-first spaced password
 * whenever a wrapper kept the whole-value fallback from firing
 * (`[https://u:1234 5678@h/x]`), so the extension is still offered when
 * either signal says the token is not a whole URL:
 *
 * - the parsed "host" carries no dot and is no IP literal, so it is far more
 *   likely a username than a public host (`https://admin:1234` → host
 *   `admin`), or
 * - every chunk after the space has the Application Password group shape,
 *   which covers a dotted username paired with the credential format this CLI
 *   actually stores (`https://user.name:1234 5678 abcd@h`).
 *
 * Ordinary prose matches neither: `https://host.test:8443 failed for
 * admin@e.com` has a dotted host and the chunks `failed`, `for`, `admin`. The
 * gate only decides whether to ask; the parser still decides credentials.
 * Residual, documented in REVIEW_DECISIONS.md: a dotted username whose spaced
 * password is neither group-shaped nor digit-free stays unmasked when it is
 * not the whole value. Candidates stop at `/?#`
 * (raw slashes cannot sit in userinfo) and at MAX_AUTHORITY_SPAN. The first
 * credentialed `@` decides — so a bare-host credential followed by prose and
 * an email never swallows the email — and the span then extends through the
 * rest of that whitespace-free run exactly as the main scan's greedy-to-last-@
 * rule would on a second pass, so the output is a fixed point. Residuals
 * accepted and documented in REVIEW_DECISIONS.md: a password whose first
 * chunk is all digits parses as a valid port and is indistinguishable from
 * `host:port`, a spaced password containing `@ ` (at plus space) masks only
 * its first credentialed extent, and a URL with an unparseable port followed
 * by prose and an email over-masks.
 *
 * @returns The scan index of the `@` ending the spaced userinfo, or -1.
 */
function spacedUserinfoEnd(
  scan: string,
  schemeStart: number,
  authorityStart: number,
  closePos: number
): number {
  // An empty authority (`https:// admin@e.com`) offers nothing to continue.
  if (closePos <= authorityStart) return -1;
  // A token that parses alone is ambiguous rather than settled; see above.
  let requireGroupShape = false;
  try {
    const { hostname } = new URL(scan.slice(schemeStart, closePos));
    // A dot or an IP literal means the token's host is believable as a real
    // host, so only a credential-shaped continuation justifies extending it.
    requireGroupShape = hostname.includes('.') || hostname.startsWith('[');
  } catch {
    // Not a URL alone — the space may sit inside its userinfo.
  }
  // Inclusive of the position exactly MAX_AUTHORITY_SPAN past the space: an
  // exclusive bound skipped a credentialed `@` sitting precisely there.
  const limit = Math.min(scan.length, closePos + 1 + MAX_AUTHORITY_SPAN);
  let tried = 0;
  for (let i = closePos + 1; i < limit; i++) {
    const char = scan[i]!;
    if (char === '/' || char === '?' || char === '#') break;
    if (char !== '@') continue;
    if (++tried > MAX_LOOKAHEAD_ATS) break;
    if (requireGroupShape) {
      const chunks = scan.slice(closePos + 1, i).split(' ');
      // Every later `@` spans this text too, so a failure here ends the search.
      if (!chunks.every((chunk) => APP_PASSWORD_GROUP.test(chunk))) break;
    }
    if (hasCredentials(scan, schemeStart, i + 1)) {
      // Greedy through the rest of this whitespace-free run: `1234@chunk@host`
      // re-parses as one authority whose userinfo ends at the LAST @, so
      // stopping here would make the second pass mask further than the first.
      //
      // Deliberately bounded by the run, not by the candidate window: a span
      // that stops early is not merely a shorter mask, it is a mask whose
      // replaced range excludes part of the credential the parser read, which
      // both leaks those bytes and breaks idempotency. The run is walked once
      // and the caller resumes past it, so this stays linear.
      let end = i;
      for (let j = i + 1; j < scan.length && !AUTHORITY_TERMINATORS.has(scan[j]!); j++) {
        if (scan[j] === '@') end = j;
      }
      return end;
    }
  }
  return -1;
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
 * @returns The text with each URL's userinfo replaced by `***:***@`. The
 * replacement is uniform on purpose: it re-parses as ordinary userinfo, so
 * masking is idempotent without trusting any marker string that hostile text
 * could also contain.
 */
export function maskUrlUserinfoInText(text: string): string {
  if (!text.includes('@')) {
    return text;
  }

  // Strip what the parser ignores, keeping a map back to the original offsets.
  // `boundary` marks scan positions that had a stripped character immediately
  // before them: those are where a second reading of a token can start.
  let scan = '';
  const sourceIndex: number[] = [];
  const boundary: boolean[] = [];
  let stripped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === '\t' || char === '\n' || char === '\r') {
      stripped = true;
      continue;
    }
    scan += char;
    sourceIndex.push(index);
    boundary.push(stripped);
    stripped = false;
  }

  const spans: { start: number; end: number }[] = [];

  // One forward pass. Authority state is carried in these, so each character is
  // visited once: a per-colon loop with a backward lastIndexOf for the `@` is
  // quadratic when many short authorities sit after a distant `@`.
  //
  // An authority can be open under more than one reading of its scheme.
  // Stripping a newline glues the preceding word to it, and the glued scheme
  // is a different URL to the parser: `PRE\nftp:/u:p@h` reads as scheme
  // `preftp`, which is not special, takes no authority after a single slash,
  // and reports no credentials — while the text plainly shows one. Both
  // readings are kept and the parser adjudicates each; the span comes from
  // whichever reading it confirms.
  let openings: { schemeStart: number; authorityStart: number; special: boolean }[] = [];
  let authorityStart = -1;
  let lastAt = -1;
  // Most recent scan position preceded by a stripped character.
  let lastBoundary = -1;
  // First alphabetic character of the current token run, tracked forward so a
  // digit-led run still offers the scheme inside it without a backward walk.
  let firstAlpha = -1;
  // Start of the current run of scheme-legal characters, maintained forward so
  // a scheme of any length is recognised in O(1); a bounded backward walk
  // missed schemes longer than its limit, and an unbounded one is quadratic.
  let tokenStart = 0;

  const closeAuthority = (): void => {
    // `lastAt > authorityStart`, not `>= 0`: an empty userinfo (`https://@host`,
    // or one the parser emptied by dropping control characters) carries no
    // credentials, so masking it would claim one had been there.
    for (const opening of openings) {
      if (lastAt <= opening.authorityStart) continue;
      // Ask the parser, not the scan, whether this is a credential. Several
      // candidate extents are offered (see hasCredentials); any verdict is
      // safe, because only the userinfo is rewritten, so the host extent
      // affects the decision, never the output.
      if (!hasCredentials(scan, opening.schemeStart, lastAt + 1)) continue;
      // Only the userinfo is rewritten. Replacing from the scheme instead let a
      // span whose offsets had shifted swallow the prose in front of it, so
      // `PRE\nhttps://u:p@h` lost `PRE` as well as the credential.
      const start = sourceIndex[opening.authorityStart]!;
      const stop = sourceIndex[lastAt]! + 1;
      // Rewriting in place is complete even when the parser dropped characters
      // inside this userinfo: the original span runs from the first userinfo
      // character through the `@`, so every credential byte — dropped controls
      // included — sits inside [start, stop). A distinct sentinel marker here
      // needed guards to stay idempotent, and those guards keyed on a string
      // hostile text can also contain, which suppressed masking outright.
      // `***:***@` re-parses as ordinary userinfo, so a second pass reproduces
      // it byte for byte with no marker trusted anywhere.
      spans.push({ start, end: stop });
      break;
    }
    openings = [];
    authorityStart = -1;
    lastAt = -1;
  };

  let index = 0;
  while (index < scan.length) {
    const char = scan[index]!;
    if (boundary[index]) lastBoundary = index;
    if (firstAlpha < tokenStart && isAlphaCode(scan.charCodeAt(index))) firstAlpha = index;

    if (char === ':') {
      // Every reading of this token that could start a URL: as scanned, from a
      // stripped character's boundary inside it (see `openings`), and from a
      // special scheme name it ends with. The last one matters because a
      // special scheme opens an authority after one slash or none, so text
      // running straight into it hides the URL completely: `…/xhttps:/u:p@h`
      // reads as scheme `xhttps`, which takes no authority after one slash.
      // Generic schemes need `//`, which parses as an authority under any
      // prefix, so they need no equivalent.
      const starts = [tokenStart];
      if (lastBoundary > tokenStart && lastBoundary < index) starts.push(lastBoundary);
      // A scheme must start with a letter, so a run beginning with a digit or
      // `+.-` is not one under its own start — but the letter inside it can
      // begin a real scheme: `9a1111://u:p@h` hid the URL completely.
      if (firstAlpha > tokenStart && firstAlpha < index) starts.push(firstAlpha);
      for (const scheme of SPECIAL_SCHEMES) {
        const start = index - scheme.length;
        if (start <= tokenStart) continue;
        if (scan.slice(start, index).toLowerCase() === scheme) starts.push(start);
      }
      const opened: { schemeStart: number; authorityStart: number; special: boolean }[] = [];
      let firstAuthority = -1;
      for (const start of starts) {
        if (start >= index || !isAlphaCode(scan.charCodeAt(start))) continue;
        const scheme = scan.slice(start, index).toLowerCase();
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
        if (!opensAuthority) continue;
        opened.push({ schemeStart: start, authorityStart: after, special });
        if (firstAuthority < 0 || after < firstAuthority) firstAuthority = after;
      }
      if (opened.length > 0) {
        // A new URL begins, so whatever authority was open ends here. This is
        // what keeps `https://safe,https://u:p@h` from swallowing the second.
        closeAuthority();
        openings = opened;
        // Scan state follows the earliest reading, so no `@` inside any
        // reading's authority is missed; each reading keeps its own start.
        authorityStart = firstAuthority;
        index = firstAuthority;
        tokenStart = firstAuthority;
        continue;
      }
      index++;
      tokenStart = index;
      continue;
    }

    // A special scheme's parser treats `\` as `/`, so it ends the authority
    // there. Leaving it out let `lastAt` advance to an `@` in the path, and
    // the span then replaced the real host and part of the path along with
    // the userinfo: `https://u:p@h\path@x` collapsed to `https://***:***@x`.
    // Only for a reading whose authority has actually begun: a backslash still
    // inside another reading's slash run (`PRE\nhttps://\u:p@h`, where the
    // glued scheme takes `//` and the real one takes `//\`) is not a
    // terminator, and closing there dropped the credential entirely.
    const endsAuthority =
      AUTHORITY_TERMINATORS.has(char) ||
      (char === '\\' &&
        openings.some((opening) => opening.special && opening.authorityStart <= index));
    if (authorityStart >= 0 && endsAuthority) {
      const sawAt = lastAt > authorityStart;
      const openReadings = openings;
      closeAuthority();
      // A space-closed authority with no @ may be a URL whose userinfo
      // contains spaces (a WordPress Application Password). Tab/CR/LF never
      // reach here — they are stripped from the scan — so the space is the
      // only whitespace close that can sit inside userinfo.
      if (!sawAt && char === ' ') {
        let matched = false;
        for (const opening of openReadings) {
          const at = spacedUserinfoEnd(scan, opening.schemeStart, opening.authorityStart, index);
          if (at < 0) continue;
          spans.push({ start: sourceIndex[opening.authorityStart]!, end: sourceIndex[at]! + 1 });
          index = at + 1;
          tokenStart = index;
          matched = true;
          break;
        }
        if (matched) continue;
      }
      index++;
      tokenStart = index;
      continue;
    }
    if (authorityStart >= 0 && char === '@') lastAt = index;
    if (!isSchemeChar(scan.charCodeAt(index))) tokenStart = index + 1;
    index++;
  }
  closeAuthority();

  if (spans.length === 0) {
    // Nothing found by token. Before giving up, check whether the whole value
    // is itself one URL: the scan has to treat a space as the end of a URL,
    // because in free text it almost always is, but the parser percent-encodes
    // spaces inside userinfo and a WordPress Application Password contains
    // them. `https://admin:AbCD 1234@host` is a credential the scan cannot see,
    // and a stored dashboardUrl reaching the debug redactor is that shape.
    // Running this only as a fallback keeps multi-URL text with the scan, which
    // masks every URL rather than just the first.
    const trimmed = text.trim();
    if (trimmed && parsesWithCredentials(trimmed)) {
      const at = text.indexOf(trimmed);
      return text.slice(0, at) + maskUrlUserinfo(trimmed) + text.slice(at + trimmed.length);
    }
    return text;
  }

  let output = '';
  let cursor = 0;
  for (const span of spans) {
    // Defensive: never let a span reach back over text already emitted.
    if (span.start < cursor) continue;
    output += text.slice(cursor, span.start);
    output += '***:***@';
    cursor = span.end;
  }
  return output + text.slice(cursor);
}
