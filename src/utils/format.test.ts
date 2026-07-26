/**
 * Tests for format utilities
 */

import { describe, it, expect } from 'vitest';
import {
  maskSecret,
  maskPassword,
  maskApiKey,
  maskUrlCredentials,
  maskUrlUserinfo,
  maskUrlUserinfoInText,
  type MaskOptions,
} from './format.js';

describe('maskSecret', () => {
  describe('with default options', () => {
    it('returns placeholder for empty string', () => {
      expect(maskSecret('')).toBe('****');
    });

    it('returns placeholder for null-ish value', () => {
      // @ts-expect-error - Testing runtime behavior with invalid input
      expect(maskSecret(null)).toBe('****');
      // @ts-expect-error - Testing runtime behavior with invalid input
      expect(maskSecret(undefined)).toBe('****');
    });

    it('returns placeholder for short secrets (≤8 chars)', () => {
      expect(maskSecret('short')).toBe('****');
      expect(maskSecret('12345678')).toBe('****');
    });

    it('masks normal secrets with first 4 and last 4 chars', () => {
      expect(maskSecret('abcdefghijklmnop')).toBe('abcd...mnop');
      expect(maskSecret('mypassword123')).toBe('mypa...d123');
    });

    it('masks secrets that are exactly minLength + 1', () => {
      // 9 chars should be masked (>8)
      expect(maskSecret('123456789')).toBe('1234...6789');
    });
  });

  describe('with custom options', () => {
    it('respects custom showFirst', () => {
      const options: MaskOptions = { showFirst: 6, showLast: 4, minLength: 10 };
      expect(maskSecret('sk-1234567890abcdefghij', options)).toBe('sk-123...ghij');
    });

    it('respects custom showLast', () => {
      const options: MaskOptions = { showFirst: 2, showLast: 2, minLength: 4 };
      expect(maskSecret('abcdefgh', options)).toBe('ab...gh');
    });

    it('respects custom minLength', () => {
      const options: MaskOptions = { minLength: 15 };
      expect(maskSecret('abcdefghijklmno', options)).toBe('****'); // exactly 15, returns placeholder
      expect(maskSecret('abcdefghijklmnop', options)).toBe('abcd...mnop'); // 16, gets masked
    });

    it('respects custom placeholder', () => {
      const options: MaskOptions = { placeholder: '[REDACTED]' };
      expect(maskSecret('short', options)).toBe('[REDACTED]');
    });

    it('combines multiple custom options', () => {
      const options: MaskOptions = {
        showFirst: 3,
        showLast: 3,
        minLength: 6,
        placeholder: '***',
      };
      expect(maskSecret('123456', options)).toBe('***'); // exactly 6, returns placeholder
      expect(maskSecret('1234567', options)).toBe('123...567'); // 7 chars, masked
    });
  });
});

describe('maskPassword', () => {
  it('returns placeholder for empty password', () => {
    expect(maskPassword('')).toBe('****');
  });

  it('returns placeholder for short passwords (≤8 chars)', () => {
    expect(maskPassword('pass')).toBe('****');
    expect(maskPassword('password')).toBe('****'); // exactly 8
  });

  it('masks normal passwords with 4+...+4 format', () => {
    expect(maskPassword('mypassword123')).toBe('mypa...d123');
    expect(maskPassword('supersecretpassword')).toBe('supe...word');
  });

  it('masks WordPress application password format', () => {
    // WordPress app passwords: 24 chars like "xxxx xxxx xxxx xxxx xxxx xxxx"
    expect(maskPassword('sI959AOGCtfv9MZ2iAUPBDhs')).toBe('sI95...BDhs');
  });
});

describe('maskApiKey', () => {
  it('returns placeholder for empty API key', () => {
    expect(maskApiKey('')).toBe('****');
  });

  it('returns placeholder for short API keys (≤10 chars)', () => {
    expect(maskApiKey('short')).toBe('****');
    expect(maskApiKey('0123456789')).toBe('****'); // exactly 10
  });

  it('masks normal API keys with 6+...+4 format', () => {
    expect(maskApiKey('sk-1234567890abcdefghij')).toBe('sk-123...ghij');
    expect(maskApiKey('anthropic_key_abc123xyz')).toBe('anthro...3xyz');
  });

  it('masks OpenAI style API key', () => {
    expect(maskApiKey('sk-proj-aBcDeFgHiJkLmNoPqRsTuVwXyZ')).toBe('sk-pro...wXyZ');
  });

  it('masks Anthropic style API key', () => {
    expect(maskApiKey('sk-ant-api03-xxxxxxxxxxxxxx')).toBe('sk-ant...xxxx');
  });
});

describe('maskUrlUserinfo', () => {
  it('masks embedded username and password', () => {
    expect(maskUrlUserinfo('https://admin:secret@dashboard.example.com/path')).toBe(
      'https://***:***@dashboard.example.com/path'
    );
  });

  it('masks a username when no password is present', () => {
    expect(maskUrlUserinfo('https://admin@dashboard.example.com')).toBe(
      'https://***:***@dashboard.example.com'
    );
  });

  it('masks the full userinfo when the password contains "@"', () => {
    expect(maskUrlUserinfo('https://admin:p@ssw@rd@dashboard.example.com/path')).toBe(
      'https://***:***@dashboard.example.com/path'
    );
  });

  it('does not consume past the query string when it contains "@"', () => {
    expect(maskUrlUserinfo('https://admin:secret@dashboard.example.com?to=a@b')).toBe(
      'https://***:***@dashboard.example.com?to=a@b'
    );
  });

  it('returns URLs without userinfo unchanged', () => {
    const url = 'https://dashboard.example.com/path?site=1';
    expect(maskUrlUserinfo(url)).toBe(url);
  });

  it('returns invalid URL input unchanged', () => {
    const url = 'not a valid URL';
    expect(maskUrlUserinfo(url)).toBe(url);
  });

  it('fails closed when a newline in the userinfo defeats the masking regex', () => {
    // new URL() strips \n before detecting credentials, but the raw string
    // keeps it, so the whitespace-excluding replace cannot match.
    const result = maskUrlUserinfo('https://admin:sec\nret@dashboard.example.com/path');
    expect(result).toBe('[URL_WITH_CREDENTIALS_REDACTED]');
    expect(result).not.toContain('sec');
  });

  it('fails closed when a tab in the userinfo defeats the masking regex', () => {
    const result = maskUrlUserinfo('https://admin:sec\tret@dashboard.example.com');
    expect(result).toBe('[URL_WITH_CREDENTIALS_REDACTED]');
  });

  it('fails closed when leading whitespace defeats the anchored regex', () => {
    // Leading whitespace is trimmed by the parser but the regex is anchored,
    // so the replace fails and the fail-closed path must catch it too.
    const result = maskUrlUserinfo('  https://admin:secret@dashboard.example.com');
    expect(result).toBe('[URL_WITH_CREDENTIALS_REDACTED]');
    expect(result).not.toContain('secret');
  });
});

describe('maskUrlCredentials', () => {
  it('masks userinfo like maskUrlUserinfo', () => {
    expect(maskUrlCredentials('https://admin:secret@dashboard.example.com/path')).toBe(
      'https://***:***@dashboard.example.com/path'
    );
  });

  it('redacts a sensitive query parameter', () => {
    expect(maskUrlCredentials('https://dashboard.example.com/?access_token=abc123')).toBe(
      'https://dashboard.example.com/?access_token=[REDACTED]'
    );
  });

  it('redacts a sensitive fragment parameter', () => {
    expect(maskUrlCredentials('https://dashboard.example.com/wp#api_key=TOPSECRET')).toBe(
      'https://dashboard.example.com/wp#api_key=[REDACTED]'
    );
  });

  it('redacts a fragment key that follows a harmless query parameter', () => {
    expect(maskUrlCredentials('https://dashboard.example.com/wp?page=2#api_key=TOPSECRET')).toBe(
      'https://dashboard.example.com/wp?page=2#api_key=[REDACTED]'
    );
  });

  it('redacts every sensitive parameter and keeps the rest byte-for-byte', () => {
    expect(
      maskUrlCredentials('https://dashboard.example.com/wp?site=1&api_key=a&password=b&page=2')
    ).toBe('https://dashboard.example.com/wp?site=1&api_key=[REDACTED]&password=[REDACTED]&page=2');
  });

  it('leaves non-sensitive parameters untouched', () => {
    const url = 'https://dashboard.example.com/wp-json?page=1&per_page=50#section';
    expect(maskUrlCredentials(url)).toBe(url);
  });

  it('masks userinfo and parameters together', () => {
    expect(maskUrlCredentials('https://admin:secret@dashboard.example.com/?api_key=abc')).toBe(
      'https://***:***@dashboard.example.com/?api_key=[REDACTED]'
    );
  });

  it('keeps the fail-closed sentinel when userinfo cannot be isolated', () => {
    const result = maskUrlCredentials('https://admin:sec\nret@dashboard.example.com/?api_key=abc');
    expect(result).toBe('[URL_WITH_CREDENTIALS_REDACTED]');
    expect(result).not.toContain('abc');
  });

  it('returns invalid URL input unchanged', () => {
    const url = 'not a valid URL';
    expect(maskUrlCredentials(url)).toBe(url);
  });

  // Key classification strips `-`/`_`, so encoding just the separator is enough
  // to walk a known sensitive name past a raw-key test.
  it('redacts a query key whose separator is percent-encoded', () => {
    expect(maskUrlCredentials('https://dashboard.example.com/?api%5Fkey=TOPSECRET')).toBe(
      'https://dashboard.example.com/?api%5Fkey=[REDACTED]'
    );
  });

  it('redacts a fragment key whose separator is percent-encoded', () => {
    expect(maskUrlCredentials('https://dashboard.example.com/#api%5Fkey=TOPSECRET')).toBe(
      'https://dashboard.example.com/#api%5Fkey=[REDACTED]'
    );
  });

  it('redacts a percent-encoded hyphen separator', () => {
    expect(maskUrlCredentials('https://dashboard.example.com/?api%2Dkey=TOPSECRET')).toBe(
      'https://dashboard.example.com/?api%2Dkey=[REDACTED]'
    );
  });

  it('redacts a key whose sensitive term itself is percent-encoded', () => {
    expect(maskUrlCredentials('https://dashboard.example.com/?%61ccess_token=TOPSECRET')).toBe(
      'https://dashboard.example.com/?%61ccess_token=[REDACTED]'
    );
    expect(maskUrlCredentials('https://dashboard.example.com/wp#p%61ssword=TOPSECRET')).toBe(
      'https://dashboard.example.com/wp#p%61ssword=[REDACTED]'
    );
  });

  it('redacts encoded and plain sensitive keys in one URL and keeps the rest', () => {
    expect(
      maskUrlCredentials('https://dashboard.example.com/wp?page=2&api%5Fkey=a#p%61ssword=b')
    ).toBe('https://dashboard.example.com/wp?page=2&api%5Fkey=[REDACTED]#p%61ssword=[REDACTED]');
  });

  // A key that cannot be decoded is not a key that can be cleared: fail closed
  // rather than echo whatever it carries.
  it('redacts an undecodable key instead of throwing', () => {
    expect(maskUrlCredentials('https://dashboard.example.com/?api%ZZkey=TOPSECRET')).toBe(
      'https://dashboard.example.com/?api%ZZkey=[REDACTED]'
    );
    // Over-redaction of a harmless-looking key is the accepted cost.
    expect(maskUrlCredentials('https://dashboard.example.com/#page%2=2')).toBe(
      'https://dashboard.example.com/#page%2=[REDACTED]'
    );
  });
});

describe('maskUrlUserinfoInText', () => {
  it('masks credentialed URLs embedded in error messages', () => {
    expect(
      maskUrlUserinfoInText(
        'Request cannot be constructed from a URL that includes credentials: https://legacy:secret@dashboard.example.com/wp-json/route?page=1'
      )
    ).toBe(
      'Request cannot be constructed from a URL that includes credentials: https://***:***@dashboard.example.com/wp-json/route?page=1'
    );
  });

  it('leaves text without credentialed URLs unchanged', () => {
    const text = 'Connection refused for https://dashboard.example.com (mail admin@example.com)';
    expect(maskUrlUserinfoInText(text)).toBe(text);
  });

  it('masks the full userinfo when the password contains "@"', () => {
    expect(
      maskUrlUserinfoInText('fetch failed: https://legacy:p@ss@dashboard.example.com/wp-json timed out')
    ).toBe('fetch failed: https://***:***@dashboard.example.com/wp-json timed out');
  });

  it('masks a credentialed URL only the WHATWG parser can detect', () => {
    // new URL() strips \n before detecting credentials, so a raw string
    // carrying one slips past a whitespace-excluding replace. Previously this
    // returned the text untouched (fail open) and leaked the password. The
    // span from the first userinfo character through the @ contains every
    // credential byte, dropped controls included, so masking in place is
    // complete.
    const result = maskUrlUserinfoInText(
      'fetch failed: https://legacy:sec\nret@dashboard.example.com/wp-json'
    );

    expect(result).not.toContain('sec\nret');
    expect(result).not.toContain('ret@dashboard');
    expect(result).toBe('fetch failed: https://***:***@dashboard.example.com/wp-json');
  });

  it('masks a tab-obscured credentialed URL in place', () => {
    const result = maskUrlUserinfoInText('at https://legacy:sec\tret@dashboard.example.com');

    expect(result).not.toContain('sec\tret');
    expect(result).toBe('at https://***:***@dashboard.example.com');
  });

  it('masks a credentialed URL wrapped in brackets or angle brackets', () => {
    // A tokenizer that runs to the next whitespace swallows the closing
    // delimiter, and the resulting string no longer parses as a URL, so the
    // credential passed through untouched.
    expect(maskUrlUserinfoInText('<https://u:p@host.example.com>')).toBe(
      '<https://***:***@host.example.com>'
    );
    expect(maskUrlUserinfoInText('see [https://u:p@h.example.com] here')).toBe(
      'see [https://***:***@h.example.com] here'
    );
    expect(maskUrlUserinfoInText('(https://u:p@host.example.com)')).toBe(
      '(https://***:***@host.example.com)'
    );
  });

  it('masks special-scheme URLs with an irregular slash run', () => {
    // The parser tolerates any number of slashes after a special scheme, so
    // these all carry real userinfo.
    expect(maskUrlUserinfoInText('https:/u:p@h.example.com/x')).toBe(
      'https:/***:***@h.example.com/x'
    );
    expect(maskUrlUserinfoInText('https:///u:p@h.example.com/x')).toBe(
      'https:///***:***@h.example.com/x'
    );
  });

  it('does not let a credential-free URL hide the next one', () => {
    // The first authority runs through ",https:" to the slash. Resuming the
    // scan past it skipped the second URL's scheme entirely.
    expect(maskUrlUserinfoInText('https://safe,https://u:p@h.example.com/x')).toBe(
      'https://safe,https://***:***@h.example.com/x'
    );
  });

  it('leaves an @ that belongs to a path rather than an authority', () => {
    // A backslash ends the authority for special schemes, so the @ here is in
    // the path and there is no userinfo to mask.
    expect(maskUrlUserinfoInText(String.raw`https://h\path@x`)).toBe(
      String.raw`https://h\path@x`
    );
    // file: takes no credentials; this is a local path.
    expect(maskUrlUserinfoInText('file:u:p@h/x')).toBe('file:u:p@h/x');
  });

  it('leaves an empty userinfo alone', () => {
    // The parser reports no credentials for these, so masking would claim one
    // had been there.
    expect(maskUrlUserinfoInText('https://@h.example.com/x')).toBe(
      'https://@h.example.com/x'
    );
    expect(maskUrlUserinfoInText('https://\t\t@h.example.com/x')).toBe(
      'https://\t\t@h.example.com/x'
    );
    // A username on its own is still a credential.
    expect(maskUrlUserinfoInText('https://alice@h.example.com/x')).toBe(
      'https://***:***@h.example.com/x'
    );
  });

  it('does not let scheme-like text inside userinfo split the URL', () => {
    // `http:` sitting in a password looked like a new URL starting, which closed
    // the authority it actually belonged to and left part of it in the output.
    expect(maskUrlUserinfoInText('https://u:http:p@h.example.com/x')).toBe(
      'https://***:***@h.example.com/x'
    );
  });

  it('requires a real // for schemes the parser does not treat as special', () => {
    // `custom:/…` and `file:/…` are paths, so their `@` is not userinfo.
    expect(maskUrlUserinfoInText('custom:/u:p@h.example.com/x')).toBe(
      'custom:/u:p@h.example.com/x'
    );
    expect(maskUrlUserinfoInText('file:/u:p@h.example.com/x')).toBe(
      'file:/u:p@h.example.com/x'
    );
    expect(maskUrlUserinfoInText('custom://u:p@h.example.com/x')).toBe(
      'custom://***:***@h.example.com/x'
    );
  });

  it('keeps text in front of a URL whose offsets shifted', () => {
    // Removing the newline joined "PRE" to the scheme, and replacing from the
    // scheme then deleted the preceding line along with the credential.
    expect(maskUrlUserinfoInText('PRE\nhttps://u:p@h.example.com/x POST')).toBe(
      'PRE\nhttps://***:***@h.example.com/x POST'
    );
  });

  it('masks obscured userinfo in place without discarding its surroundings', () => {
    const result = maskUrlUserinfoInText('before https://u:se\ncret@h.example.com/x after');

    expect(result).not.toContain('cret@');
    expect(result).toBe('before https://***:***@h.example.com/x after');
  });

  it('over-masks rather than under-masks when a URL sits in JSON', () => {
    // The parser reads `h.test","user":"a` as userinfo and `b` as the host
    // here, and that is textually identical to a password containing a quote
    // (`https://user:pa"ss@host`), which is a real credential. There is no way
    // to tell them apart, so this errs toward masking: a mangled error body
    // costs diagnostics, the other direction costs a credential.
    const result = maskUrlUserinfoInText('{"url":"https://h.test","user":"a@b"}');

    expect(result).toContain('***:***@');
    expect(result).not.toContain('"user":"a@');
  });

  it('masks a password containing characters the parser percent-encodes', () => {
    // These are legal in userinfo (the parser encodes them), so treating them
    // as authority terminators walked straight past the `@` and leaked.
    for (const char of ['"', '<', '>', '`', '{', '}', '|', '^']) {
      expect(maskUrlUserinfoInText(`https://user:pa${char}ss@host.example.com/x`)).toBe(
        'https://***:***@host.example.com/x'
      );
    }
  });

  it('does not leak a password containing spaces, as WordPress passwords do', () => {
    // The scan has to treat a space as the end of a URL because in free text it
    // almost always is, but the parser percent-encodes spaces inside userinfo,
    // and an Application Password is exactly this shape. The space look-ahead
    // catches it: `https://admin:AbCD` alone does not parse (its "port" is not
    // a number), so the text after the space is offered to the parser as
    // userinfo continuation and masked in place.
    const result = maskUrlUserinfoInText('https://admin:AbCD 1234 efGH@host.example.com/x');

    expect(result).not.toContain('AbCD');
    expect(result).toBe('https://***:***@host.example.com/x');
  });

  it('masks a spaced password even when another URL already matched', () => {
    // The whole-value fallback only ran when the scan found nothing, so a
    // spaced credential embedded alongside any other URL survived untouched.
    expect(
      maskUrlUserinfoInText(
        'first https://a:b@one.example/x then <https://admin:AbCD 1234 efGH@host.example/x>'
      )
    ).toBe('first https://***:***@one.example/x then <https://***:***@host.example/x>');
  });

  it('does not let the space look-ahead swallow prose after a real URL', () => {
    // `https://host.test` and `https://host.test:8443` parse on their own, so
    // the space genuinely ends them and the email stays untouched.
    for (const text of [
      'Connection to https://host.test failed for admin@example.com',
      'Connection to https://host.test:8443 failed for admin@example.com',
    ]) {
      expect(maskUrlUserinfoInText(text)).toBe(text);
    }
  });

  it('stops a spaced credential at its first credentialed extent', () => {
    // The shortest extent that parses with credentials wins, so a bare-host
    // spaced credential followed by prose and an email masks only itself.
    expect(
      maskUrlUserinfoInText('Request to https://admin:AbCD 1234@host failed for admin@e.com')
    ).toBe('Request to https://***:***@host failed for admin@e.com');
  });

  it('masks a wrapped URL whose host starts with a sub-delimiter', () => {
    // The conservative host extent is empty when the host starts with `!`, and
    // the structural extent swallowed the closing `>` and failed to parse, so
    // neither candidate matched the visible URL and the credential leaked.
    expect(maskUrlUserinfoInText('<https://u:p@!host>')).toBe('<https://***:***@!host>');
    expect(maskUrlUserinfoInText('(https://u:p@,host.example)')).toBe(
      '(https://***:***@,host.example)'
    );
  });

  it('masks a wrapped, control-obscured URL with a sub-delimiter host', () => {
    const result = maskUrlUserinfoInText('<https://u:se\ncret@!host>');

    expect(result).not.toContain('cret@');
    expect(result).toBe('<https://***:***@!host>');
  });

  it('masks a wrapped URL whose whole host is outside the character table', () => {
    // The conservative and trimmed extents collapse to nothing when every
    // host character is outside the table, and the structural extent
    // swallowed the closing `>`; the bounded backward walk offers the extent
    // just inside the wrapper and the parser confirms the credential.
    expect(maskUrlUserinfoInText('<https://u:p@!>')).toBe('<https://***:***@!>');
  });

  it('does not trust its own sentinel when hostile text embeds it', () => {
    // The look-ahead and fallback briefly keyed on the sentinel string to stay
    // idempotent, and hostile text containing that literal suppressed masking
    // entirely. Idempotency now comes from the uniform in-place replacement,
    // which re-parses as ordinary userinfo, so no marker is trusted.
    expect(
      maskUrlUserinfoInText('https://admin:[URL_WITH_CREDENTIALS_REDACTED] secret@host/x')
    ).toBe('https://***:***@host/x');
  });

  it('extends a spaced credential through its whitespace-free run', () => {
    // Stopping at the first credentialed @ made the second pass mask further
    // than the first: `***:***@chunk@host` re-parses with userinfo up to the
    // LAST @. The look-ahead mirrors that greedy rule within the run.
    const once = maskUrlUserinfoInText('https://admin:AbCD 1234@chunk@host/x');
    expect(once).toBe('https://***:***@host/x');
    expect(maskUrlUserinfoInText(once)).toBe(once);
  });

  it('masks userinfo the parser cannot rule on, at any authority length', () => {
    // An unterminated IPv6 host rejects every candidate extent, so the parser
    // never gets to rule on the credential. "No verdict" is not "no
    // credential", so this fails closed — at the window edge, past it, and at
    // end of input, all of which previously left the userinfo in place.
    for (const input of [
      'https://u:p@[',
      `https://u:p@[${'a'.repeat(1023)} tail`,
      `https://u:p@[${'a'.repeat(1023)}`,
      `https://u:p@[${'a'.repeat(4000)} tail`,
    ]) {
      const result = maskUrlUserinfoInText(input);
      expect(result).not.toContain('u:p@');
      expect(result.startsWith('https://***:***@')).toBe(true);
    }
  });

  it('keeps a spaced credential whole when its run crosses the look-ahead cap', () => {
    // The span has to cover every byte the parser read as the credential. A
    // run-extension bounded by the look-ahead window ended the span mid-run,
    // which both left password bytes in the output and made a second pass
    // mask further than the first.
    const run = 'a'.repeat(1021);
    const once = maskUrlUserinfoInText(`https://admin:AbCD x@${run}@host/x`);

    expect(once).toBe('https://***:***@host/x');
    expect(maskUrlUserinfoInText(once)).toBe(once);
  });

  it('ends the authority at a backslash for special schemes', () => {
    // The parser treats `\` as `/` for special schemes, so an `@` after it is
    // in the path. Letting the scan run past it replaced the real host and
    // part of the path along with the userinfo.
    expect(maskUrlUserinfoInText('https://u:p@h\\path@x')).toBe('https://***:***@h\\path@x');
  });

  it('finds a scheme hidden by glue on either side', () => {
    // Stripping a control character joins the preceding word to the scheme,
    // and ordinary text can run straight into one. Both readings are offered
    // to the parser; only the scanned one used to be.
    expect(maskUrlUserinfoInText('1\nhttps://u:p@h/x')).toBe('1\nhttps://***:***@h/x');
    expect(maskUrlUserinfoInText('PRE\nftp:/u:p@h.test/x')).toBe('PRE\nftp:/***:***@h.test/x');
    expect(maskUrlUserinfoInText('9a1111://u:p@h.test/x')).toBe('9a1111://***:***@h.test/x');
    expect(maskUrlUserinfoInText('/xhttps:/u:p@h.test/x')).toBe('/xhttps:/***:***@h.test/x');
  });

  it('masks a digit-first spaced password a wrapper hides from the fallback', () => {
    // `https://u:1234` parses alone as host and port, so the look-ahead
    // declined and the whole-value fallback could not fire through the
    // brackets. The dotless "host" is the signal that it is really a username.
    expect(maskUrlUserinfoInText('[https://u:1234 5678@h.test/x]')).toBe(
      '[https://***:***@h.test/x]'
    );
  });

  it('over-masks an unparseable-port URL followed by prose and an email', () => {
    // Documented direction (REVIEW_DECISIONS.md): `https://host.test:bad` is
    // byte-shape-identical to `https://admin:AbCD`, so refusing to extend it
    // would reopen the spaced Application Password leak. A typo'd port plus a
    // later email over-masks; a valid port (test above) never does.
    expect(
      maskUrlUserinfoInText('Connection to https://host.test:bad failed for admin@example.com')
    ).toBe('Connection to https://***:***@example.com');
  });

  it('masks hosts the parser accepts but a character set would not', () => {
    // Sub-delimiters and their percent-encoded forms are legal in a host, so
    // deciding the host extent from a character table left these unmasked.
    for (const host of ['!example', ',example', '%21example', '%2Cexample']) {
      expect(maskUrlUserinfoInText(`https://u:p@${host}/x`)).toBe(
        `https://***:***@${host}/x`
      );
    }
  });

  it('masks when a scheme-like suffix follows the host', () => {
    // Opening the next URL closed this authority before its host, so the
    // candidate handed to the parser had no host to validate.
    expect(maskUrlUserinfoInText('https://a:b@onehttps://safe/x')).toBe(
      'https://***:***@onehttps://safe/x'
    );
  });

  it('masks credentials on an internationalized host', () => {
    // The parser punycodes these rather than rejecting them, so stopping the
    // host scan at the first non-ASCII character truncated the candidate to
    // `https://u:p@`, which does not parse, and the credential survived.
    expect(maskUrlUserinfoInText('https://u:p@пример.example.com/x')).toBe(
      'https://***:***@пример.example.com/x'
    );
    expect(maskUrlUserinfoInText('https://u:p@xn--e1afmkfd.example.com/x')).toBe(
      'https://***:***@xn--e1afmkfd.example.com/x'
    );
  });

  it('keeps ports and IPv6 literals intact while masking', () => {
    expect(maskUrlUserinfoInText('https://u:p@host.example.com:8443/x')).toBe(
      'https://***:***@host.example.com:8443/x'
    );
    expect(maskUrlUserinfoInText('https://u:p@[2001:db8::1]:8443/x')).toBe(
      'https://***:***@[2001:db8::1]:8443/x'
    );
  });

  it('recognises a scheme of any length', () => {
    // A bounded backward walk missed schemes longer than its limit whenever the
    // character at the boundary was a digit.
    expect(maskUrlUserinfoInText(`a${'1'.repeat(40)}://u:p@h.example.com/x`)).toBe(
      `a${'1'.repeat(40)}://***:***@h.example.com/x`
    );
  });

  it('treats backslashes as slashes only for special schemes', () => {
    expect(maskUrlUserinfoInText('custom:\\\\u:p@h.example.com/x')).toBe(
      'custom:\\\\u:p@h.example.com/x'
    );
  });

  it('still masks a password containing sub-delimiters', () => {
    // `,` and `;` are legal in userinfo, so they must not end the authority.
    expect(maskUrlUserinfoInText('https://user:pa,ss@host.example.com/x')).toBe(
      'https://***:***@host.example.com/x'
    );
    expect(maskUrlUserinfoInText("https://user:pa;s's@host.example.com/x")).toBe(
      'https://***:***@host.example.com/x'
    );
  });

  it('stays linear when many short authorities follow a distant @', () => {
    // A backward lastIndexOf for the authority's @ made this quadratic.
    const hostile = `@${' http:x/'.repeat(50_000)}`;
    const start = Date.now();

    maskUrlUserinfoInText(hostile);

    expect(Date.now() - start).toBeLessThan(500);
  });

  it('stays linear on terminator-free scheme repeats and unclosed brackets', () => {
    // Slicing and parsing candidates out to the next structural character was
    // quadratic when none exists: repeated scheme opens each re-scanned the
    // rest of the input, and an unclosed IPv6 bracket searched to the end for
    // its `]`. Past MAX_AUTHORITY_SPAN the adjudicator now fails closed
    // instead of parsing unbounded candidates.
    for (const unit of ['https:\\\\u:p@', 'https:\\\\u:p@!', 'https://u:p@[/']) {
      const start = Date.now();

      maskUrlUserinfoInText(unit.repeat(20_000));

      expect(Date.now() - start).toBeLessThan(1_000);
    }
  });

  it('masks both URLs when they are adjacent with no whitespace between', () => {
    expect(
      maskUrlUserinfoInText('https://a:b@one.example.com,https://c:d@two.example.com')
    ).toBe('https://***:***@one.example.com,https://***:***@two.example.com');
  });

  it('is idempotent: masking already-masked text does not collapse it', () => {
    // The debug redactor masks centrally, so text can reach this twice. The
    // masked form re-parses as credentialed, and re-masking it produced an
    // identical string, which the fail-closed check read as "could not
    // isolate" and replaced with the sentinel.
    const once = maskUrlUserinfoInText('failed at https://u:p@host.example.com/x');
    expect(maskUrlUserinfoInText(once)).toBe(once);
  });

  it('is idempotent for control-obscured and spaced credentials', () => {
    // Every span is replaced with the same `***:***@`, which re-parses as
    // ordinary userinfo, so a second pass reproduces the first byte for byte
    // without any marker being trusted.
    for (const text of [
      'https://u:se\ncret@h contact admin@e.com',
      'https://admin:AbCD 1234@host/x https://u:se\ncret@h/x',
      'https://admin:AbCD 1234@chunk@host/x',
      '<https://u:se\ncret@!>',
    ]) {
      const once = maskUrlUserinfoInText(text);
      expect(maskUrlUserinfoInText(once)).toBe(once);
      expect(once).not.toContain('cret@');
      expect(once).not.toContain('AbCD');
    }
  });

  it('masks several credentialed URLs in one string', () => {
    expect(
      maskUrlUserinfoInText('first https://a:b@one.example.com then https://c:d@two.example.com')
    ).toBe('first https://***:***@one.example.com then https://***:***@two.example.com');
  });
});
