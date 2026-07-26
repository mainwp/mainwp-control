/**
 * Tests for format utilities
 */

import { describe, it, expect } from 'vitest';
import {
  maskSecret,
  maskPassword,
  maskApiKey,
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

  it('fails closed on a credentialed URL only the WHATWG parser can detect', () => {
    // new URL() strips \n before detecting credentials, so a raw string
    // carrying one slips past a whitespace-excluding replace. Previously this
    // returned the text untouched (fail open) and leaked the password.
    const result = maskUrlUserinfoInText(
      'fetch failed: https://legacy:sec\nret@dashboard.example.com/wp-json'
    );

    expect(result).not.toContain('sec\nret');
    expect(result).not.toContain('ret@dashboard');
    expect(result).toContain('[URL_WITH_CREDENTIALS_REDACTED]');
  });

  it('fails closed on a tab-obscured credentialed URL', () => {
    const result = maskUrlUserinfoInText('at https://legacy:sec\tret@dashboard.example.com');

    expect(result).not.toContain('sec\tret');
    expect(result).toContain('[URL_WITH_CREDENTIALS_REDACTED]');
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

  it('fails closed on obscured userinfo without discarding its surroundings', () => {
    const result = maskUrlUserinfoInText('before https://u:se\ncret@h.example.com/x after');

    expect(result).toContain('before ');
    expect(result).toContain(' after');
    expect(result).toContain('[URL_WITH_CREDENTIALS_REDACTED]');
    expect(result).not.toContain('cret@');
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

  it('masks several credentialed URLs in one string', () => {
    expect(
      maskUrlUserinfoInText('first https://a:b@one.example.com then https://c:d@two.example.com')
    ).toBe('first https://***:***@one.example.com then https://***:***@two.example.com');
  });
});
