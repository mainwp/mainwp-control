/**
 * Tests for pure error sanitizers.
 *
 * Error details can carry parsed API responses — hostile input. These tests
 * pin credential redaction coverage and the structural guards that keep
 * sanitization from overflowing the stack.
 */

import { describe, it, expect } from 'vitest';
import { sanitizeErrorMessage, sanitizeErrorValue } from './error-sanitizer.js';

describe('sanitizeErrorMessage', () => {
  // Userinfo masking is delegated to maskUrlUserinfoInText, which keeps the
  // scheme and host and replaces only the credential — a more useful
  // diagnostic than the whole-URL placeholder this used to emit.
  it('redacts user-and-password credentialed URLs', () => {
    expect(sanitizeErrorMessage('failed: https://admin:secret@dashboard.example.com/wp-json')).toBe(
      'failed: https://***:***@dashboard.example.com/wp-json'
    );
  });

  it('redacts username-only credentialed URLs', () => {
    expect(sanitizeErrorMessage('failed: https://alice@dashboard.example.com')).toBe(
      'failed: https://***:***@dashboard.example.com'
    );
  });

  it('leaves URLs without userinfo unchanged', () => {
    const message = 'failed: https://dashboard.example.com/wp-json?page=1';
    expect(sanitizeErrorMessage(message)).toBe(message);
  });

  it('redacts sensitive query-string parameter values', () => {
    expect(
      sanitizeErrorMessage('failed: https://dashboard.example.com/cb?access_token=abc123&page=2')
    ).toBe('failed: https://dashboard.example.com/cb?access_token=[REDACTED]&page=2');
  });

  // Every case below leaked past the local credential pattern this function
  // used before the shared scanner replaced it (adversarial review round 10).
  it('redacts an uppercase scheme', () => {
    const result = sanitizeErrorMessage('HTTPS://admin:secret@host/x');

    expect(result).not.toContain('secret');
    expect(result).toBe('HTTPS://***:***@host/x');
  });

  it('redacts a scheme split by a newline the URL parser discards', () => {
    const result = sanitizeErrorMessage('https:\n//admin:secret@host/x');

    expect(result).not.toContain('secret');
    expect(result).toBe('https:\n//***:***@host/x');
  });

  it('redacts a password containing spaces', () => {
    const result = sanitizeErrorMessage('https://admin:my secret pass@host/x');

    expect(result).not.toContain('my secret pass');
    expect(result).toBe('https://***:***@host/x');
  });

  it('redacts a whole b64token Bearer value', () => {
    expect(sanitizeErrorMessage('Bearer abc+def/ghi~=')).toBe('Bearer [REDACTED]');
  });

  it('redacts a base64url Basic value', () => {
    expect(sanitizeErrorMessage('Basic YWRtaW4-c2Vj_cmV0==')).toBe('Basic [REDACTED]');
  });

  it('redacts sensitive parameters carried in a fragment', () => {
    expect(sanitizeErrorMessage('https://dash.example/wp#api_key=TOPSECRET')).toBe(
      'https://dash.example/wp#api_key=[REDACTED]'
    );
  });

  it('redacts a fragment key that follows a harmless query parameter', () => {
    expect(sanitizeErrorMessage('https://dash.example/wp?page=2#api_key=TOPSECRET')).toBe(
      'https://dash.example/wp?page=2#api_key=[REDACTED]'
    );
  });
});

describe('sanitizeErrorValue', () => {
  it('sanitizes strings nested in arrays and objects', () => {
    expect(
      sanitizeErrorValue({
        urls: ['https://admin:secret@dashboard.example.com'],
      })
    ).toEqual({ urls: ['https://***:***@dashboard.example.com'] });
  });

  it('redacts values under sensitive keys outright', () => {
    expect(
      sanitizeErrorValue({
        password: 'hunter2',
        api_key: { nested: 'secret' },
        note: 'kept',
      })
    ).toEqual({
      password: '[REDACTED]',
      api_key: '[REDACTED]',
      note: 'kept',
    });
  });

  it('terminates on cyclic structures instead of overflowing the stack', () => {
    const cyclic: Record<string, unknown> = { name: 'outer' };
    cyclic['self'] = cyclic;

    expect(sanitizeErrorValue(cyclic)).toEqual({
      name: 'outer',
      self: '[TRUNCATED]',
    });
  });

  it('truncates beyond the depth limit instead of recursing indefinitely', () => {
    let deep: unknown = 'leaf';
    for (let index = 0; index < 50; index++) {
      deep = { nested: deep };
    }

    const sanitized = JSON.stringify(sanitizeErrorValue(deep));
    expect(sanitized).toContain('[TRUNCATED]');
    expect(sanitized).not.toContain('leaf');
  });

  it('passes primitives through unchanged', () => {
    expect(sanitizeErrorValue(42)).toBe(42);
    expect(sanitizeErrorValue(null)).toBe(null);
    expect(sanitizeErrorValue(true)).toBe(true);
  });
});

describe('sanitizeErrorMessage input bounding (F11)', () => {
  it('completes quickly on an adversarial credential-URL payload', () => {
    // Repeated "http://a" gives the credentials pattern many valid start
    // prefixes that each fail only at end-of-input: quadratic before the cap.
    const hostile = 'http://a'.repeat(200_000); // 1.6MB
    const start = Date.now();

    sanitizeErrorMessage(hostile);

    expect(Date.now() - start).toBeLessThan(500);
  });

  it('does not emit a credential that straddles the truncation boundary', () => {
    // Cutting mid-URL removes the "@" the credential pattern needs, so the
    // retained prefix stopped matching and the userinfo was emitted verbatim.
    const url = 'https://leakeduser:leakedpassword@dash.example.com/path';
    for (const offset of [30, 20, 10, 5]) {
      const message = `${'x'.repeat(16384 - offset)}${url}`;
      const result = sanitizeErrorMessage(message);

      expect(result, `offset ${offset}`).not.toContain('leakeduser');
      expect(result, `offset ${offset}`).not.toContain('leakedpass');
    }
  });

  it('keeps a usable prefix when the tail is a long run of tabs', () => {
    // A trailing-anchored search cannot cross the tabs that follow the space,
    // so it found no boundary and discarded the whole message.
    const result = sanitizeErrorMessage(`useful context ${'\t'.repeat(17_000)}tail`);

    expect(result).toContain('useful context');
    expect(result).toContain('[truncated]');
  });

  it('truncates over-long messages with a visible marker', () => {
    const result = sanitizeErrorMessage('x'.repeat(20_000));

    expect(result).toContain('[truncated]');
    expect(result.length).toBeLessThan(20_000);
  });

  it('still redacts credentials in a normal-length message', () => {
    expect(sanitizeErrorMessage('failed at https://alice:pw@host/x')).toBe(
      'failed at https://***:***@host/x'
    );
  });

  it('still redacts a username-only credential URL', () => {
    expect(sanitizeErrorMessage('failed at https://alice@host/x')).toBe(
      'failed at https://***:***@host/x'
    );
  });
});
