/**
 * Tests for Input Sanitizer sensitive field detection (F6)
 */

import { describe, it, expect } from 'vitest';
import { createInputSanitizer } from './input-sanitizer.js';

describe('InputSanitizer — isSensitiveKey', () => {
  const sanitizer = createInputSanitizer();

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
  const sanitizer = createInputSanitizer();

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
