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

  it('masks several credentialed URLs in one string', () => {
    expect(
      maskUrlUserinfoInText('first https://a:b@one.example.com then https://c:d@two.example.com')
    ).toBe('first https://***:***@one.example.com then https://***:***@two.example.com');
  });
});
