/**
 * Tests for format utilities
 */

import { describe, it, expect } from 'vitest';
import { maskSecret, maskPassword, maskApiKey, type MaskOptions } from './format.js';

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
