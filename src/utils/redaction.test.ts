/**
 * Tests for the shared sensitive-key redaction utility
 */

import { describe, it, expect } from 'vitest';
import { isSensitiveKey, redactSensitiveKeys } from './redaction.js';

describe('isSensitiveKey', () => {
  it('detects the superset terms', () => {
    expect(isSensitiveKey('password')).toBe(true);
    expect(isSensitiveKey('secret')).toBe(true);
    expect(isSensitiveKey('token')).toBe(true);
    expect(isSensitiveKey('authorization')).toBe(true);
    expect(isSensitiveKey('auth')).toBe(true);
    expect(isSensitiveKey('cookie')).toBe(true);
    expect(isSensitiveKey('apikey')).toBe(true);
    expect(isSensitiveKey('api_key')).toBe(true);
    expect(isSensitiveKey('bearer')).toBe(true);
    expect(isSensitiveKey('credential')).toBe(true);
    expect(isSensitiveKey('private_key')).toBe(true);
    expect(isSensitiveKey('signing_key')).toBe(true);
    expect(isSensitiveKey('encryption_key')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isSensitiveKey('PASSWORD')).toBe(true);
    expect(isSensitiveKey('Secret')).toBe(true);
    expect(isSensitiveKey('ApiKey')).toBe(true);
  });

  it('detects compound keys regardless of separator style', () => {
    expect(isSensitiveKey('apiToken')).toBe(true);
    expect(isSensitiveKey('appPassword')).toBe(true);
    expect(isSensitiveKey('refreshToken')).toBe(true);
    expect(isSensitiveKey('X-Api-Key')).toBe(true);
    expect(isSensitiveKey('api-key')).toBe(true);
    expect(isSensitiveKey('signing-key')).toBe(true);
    expect(isSensitiveKey('encryptionKey')).toBe(true);
    expect(isSensitiveKey('set-cookie')).toBe(true);
    expect(isSensitiveKey('private-key')).toBe(true);
  });

  it('does not flag non-sensitive keys', () => {
    expect(isSensitiveKey('site_id')).toBe(false);
    expect(isSensitiveKey('name')).toBe(false);
    expect(isSensitiveKey('url')).toBe(false);
    expect(isSensitiveKey('description')).toBe(false);
    expect(isSensitiveKey('username')).toBe(false);
  });
});

describe('redactSensitiveKeys', () => {
  it('redacts sensitive top-level keys and leaves others intact', () => {
    const data = {
      apiToken: 'abc123',
      appPassword: 'def456',
      site_id: 42,
    };

    const redacted = redactSensitiveKeys(data) as Record<string, unknown>;

    expect(redacted.apiToken).toBe('[REDACTED]');
    expect(redacted.appPassword).toBe('[REDACTED]');
    expect(redacted.site_id).toBe(42);
  });

  it('redacts nested sensitive fields', () => {
    const data = {
      config: {
        refreshToken: 'secret-value',
        name: 'test',
      },
    };

    const redacted = redactSensitiveKeys(data) as { config: Record<string, unknown> };

    expect(redacted.config.refreshToken).toBe('[REDACTED]');
    expect(redacted.config.name).toBe('test');
  });

  it('redacts sensitive fields inside arrays', () => {
    const data = [{ 'X-Api-Key': 'xyz' }, { name: 'ok' }];

    const redacted = redactSensitiveKeys(data) as Record<string, unknown>[];

    expect(redacted[0]?.['X-Api-Key']).toBe('[REDACTED]');
    expect(redacted[1]?.['name']).toBe('ok');
  });

  it('passes through non-object values unchanged', () => {
    expect(redactSensitiveKeys('a string')).toBe('a string');
    expect(redactSensitiveKeys(42)).toBe(42);
    expect(redactSensitiveKeys(null)).toBe(null);
    expect(redactSensitiveKeys(undefined)).toBe(undefined);
  });
});
