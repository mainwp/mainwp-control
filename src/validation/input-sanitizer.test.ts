/**
 * Tests for Input Sanitizer sensitive field detection (F6)
 */

import { describe, it, expect } from 'vitest';
import { InputSanitizer, DEFAULT_LIMITS } from './input-sanitizer.js';
import { InputError } from '../utils/errors.js';

describe('InputSanitizer — isSensitiveKey', () => {
  const sanitizer = new InputSanitizer();

  it('detects signing_key variants', () => {
    expect(sanitizer.isSensitiveKey('signing_key')).toBe(true);
    expect(sanitizer.isSensitiveKey('signingKey')).toBe(true);
    expect(sanitizer.isSensitiveKey('signing-key')).toBe(true);
    expect(sanitizer.isSensitiveKey('SIGNING_KEY')).toBe(true);
  });

  it('detects encryption_key variants', () => {
    expect(sanitizer.isSensitiveKey('encryption_key')).toBe(true);
    expect(sanitizer.isSensitiveKey('encryptionKey')).toBe(true);
    expect(sanitizer.isSensitiveKey('encryption-key')).toBe(true);
    expect(sanitizer.isSensitiveKey('ENCRYPTION_KEY')).toBe(true);
  });

  it('detects existing sensitive patterns', () => {
    expect(sanitizer.isSensitiveKey('password')).toBe(true);
    expect(sanitizer.isSensitiveKey('api_key')).toBe(true);
    expect(sanitizer.isSensitiveKey('private_key')).toBe(true);
    expect(sanitizer.isSensitiveKey('bearer')).toBe(true);
  });

  it('does not flag non-sensitive keys', () => {
    expect(sanitizer.isSensitiveKey('site_id')).toBe(false);
    expect(sanitizer.isSensitiveKey('name')).toBe(false);
    expect(sanitizer.isSensitiveKey('url')).toBe(false);
    expect(sanitizer.isSensitiveKey('description')).toBe(false);
  });
});

describe('InputSanitizer — redactSensitive', () => {
  const sanitizer = new InputSanitizer();

  it('redacts signing_key and encryption_key fields', () => {
    const data = {
      signing_key: 'abc123',
      encryption_key: 'def456',
      site_id: 42,
    };

    const redacted = sanitizer.redactSensitive(data);

    expect(redacted.signing_key).toBe('[REDACTED]');
    expect(redacted.encryption_key).toBe('[REDACTED]');
    expect(redacted.site_id).toBe(42);
  });

  it('redacts nested sensitive fields', () => {
    const data = {
      config: {
        signingKey: 'secret',
        name: 'test',
      },
    };

    const redacted = sanitizer.redactSensitive(data);
    const config = redacted.config as Record<string, unknown>;

    expect(config.signingKey).toBe('[REDACTED]');
    expect(config.name).toBe('test');
  });
});

describe('InputSanitizer — sanitize() enforcement', () => {
  const sanitizer = new InputSanitizer();

  it('rejects a serialized input larger than maxInputSize', () => {
    const oversized = { value: 'x'.repeat(DEFAULT_LIMITS.maxInputSize + 1) };

    expect(() => sanitizer.sanitize(oversized)).toThrow(InputError);
    expect(() => sanitizer.sanitize(oversized)).toThrow(/Input size exceeds limit/);
  });

  it('rejects a string longer than maxStringLength', () => {
    const input = { value: 'x'.repeat(DEFAULT_LIMITS.maxStringLength + 1) };

    expect(() => sanitizer.sanitize(input)).toThrow(InputError);
    expect(() => sanitizer.sanitize(input)).toThrow(/maximum length/);
  });

  it('rejects nesting deeper than maxObjectDepth', () => {
    let nested: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < DEFAULT_LIMITS.maxObjectDepth + 5; i++) {
      nested = { child: nested };
    }

    expect(() => sanitizer.sanitize(nested)).toThrow(InputError);
    expect(() => sanitizer.sanitize(nested)).toThrow(/maximum depth/);
  });

  it('rejects an array with more than maxArrayElements items', () => {
    const input = {
      items: Array.from({ length: DEFAULT_LIMITS.maxArrayElements + 1 }, (_, i) => i),
    };

    expect(() => sanitizer.sanitize(input)).toThrow(InputError);
    expect(() => sanitizer.sanitize(input)).toThrow(/maximum elements/);
  });

  it('rejects an object with more than maxObjectKeys keys', () => {
    const input: Record<string, unknown> = {};
    for (let i = 0; i < DEFAULT_LIMITS.maxObjectKeys + 1; i++) {
      input[`key${i}`] = i;
    }

    expect(() => sanitizer.sanitize(input)).toThrow(InputError);
    expect(() => sanitizer.sanitize(input)).toThrow(/maximum keys/);
  });

  it('accepts input within all limits', () => {
    const input = { name: 'site-1', tags: ['a', 'b'], meta: { nested: true } };

    expect(sanitizer.sanitize(input)).toBe(input);
  });

  // SECURITY: keys with PHP query-structural brackets can canonicalize on the
  // server to alias a control flag (e.g. `confirm]` -> input.confirm) past the
  // exact-name strip in AbilitiesExecutor. Reject them at the input boundary.
  it('rejects a key containing a "]" bracket (control-flag canonicalization)', () => {
    const input = { 'confirm]': true } as Record<string, unknown>;

    expect(() => sanitizer.sanitize(input)).toThrow(InputError);
    expect(() => sanitizer.sanitize(input)).toThrow(/Invalid characters in input key/);
  });

  it('rejects a key containing a "[" bracket', () => {
    const input = { 'foo[bar': 1 } as Record<string, unknown>;

    expect(() => sanitizer.sanitize(input)).toThrow(/Invalid characters in input key/);
  });

  it('rejects a bracketed key nested inside an object', () => {
    const input = { outer: { 'dry_run]': true } } as Record<string, unknown>;

    expect(() => sanitizer.sanitize(input)).toThrow(InputError);
  });
});

describe('InputSanitizer — sanitizeErrorMessage', () => {
  const sanitizer = new InputSanitizer();

  it('redacts credentials embedded in a URL', () => {
    const message = 'Failed to connect to https://admin:s3cr3t@dashboard.example.com/api';
    const sanitized = sanitizer.sanitizeErrorMessage(message);

    expect(sanitized).not.toContain('admin:s3cr3t');
    expect(sanitized).toContain('[URL_WITH_CREDENTIALS]');
  });

  it('redacts Bearer tokens', () => {
    const message = 'Request failed: Authorization: Bearer abc123.def456-token';
    const sanitized = sanitizer.sanitizeErrorMessage(message);

    expect(sanitized).not.toContain('abc123.def456-token');
    expect(sanitized).toContain('Bearer [REDACTED]');
  });

  it('redacts absolute filesystem paths', () => {
    const message = "ENOENT: no such file or directory, open '/Users/alice/.config/mainwpcontrol/settings.json'";
    const sanitized = sanitizer.sanitizeErrorMessage(message);

    expect(sanitized).not.toContain('/Users/alice');
    expect(sanitized).toContain('[PATH]');
  });

  it('leaves clean messages unchanged', () => {
    const message = 'Ability mainwp/list-sites-v1 returned no results';

    expect(sanitizer.sanitizeErrorMessage(message)).toBe(message);
  });
});
