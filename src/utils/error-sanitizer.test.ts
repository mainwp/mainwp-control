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
  it('redacts user-and-password credentialed URLs', () => {
    expect(sanitizeErrorMessage('failed: https://admin:secret@dashboard.example.com/wp-json')).toBe(
      'failed: [URL_WITH_CREDENTIALS]'
    );
  });

  it('redacts username-only credentialed URLs', () => {
    expect(sanitizeErrorMessage('failed: https://alice@dashboard.example.com')).toBe(
      'failed: [URL_WITH_CREDENTIALS]'
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
});

describe('sanitizeErrorValue', () => {
  it('sanitizes strings nested in arrays and objects', () => {
    expect(
      sanitizeErrorValue({
        urls: ['https://admin:secret@dashboard.example.com'],
      })
    ).toEqual({ urls: ['[URL_WITH_CREDENTIALS]'] });
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
