/**
 * Unit tests for BaseCommand's debug-context redaction.
 *
 * debugLog() ships its context to stderr under --debug; these tests pin
 * that sensitive values are redacted wherever they sit in the structure,
 * including inside arrays.
 */

import { describe, it, expect } from 'vitest';
import type { Config } from '@oclif/core';
import { BaseCommand } from './base-command.js';

class TestCommand extends BaseCommand {
  async run(): Promise<void> {}
}

function redact(context: Record<string, unknown>): Record<string, unknown> {
  const cmd = new TestCommand([], {} as Config);
  // Private method reached via index access — pins the redaction behavior
  // without spinning up the full oclif lifecycle.
  return (
    cmd as unknown as {
      redactDebugContext(c: Record<string, unknown>): Record<string, unknown>;
    }
  ).redactDebugContext(context);
}

describe('BaseCommand debug-context redaction', () => {
  it('redacts sensitive keys at the top level', () => {
    const result = redact({ username: 'admin', appPassword: 's3cr3t' });

    expect(result['username']).toBe('admin');
    expect(result['appPassword']).toBe('[REDACTED]');
  });

  it('redacts sensitive keys in nested objects', () => {
    const result = redact({ config: { token: 'abc123', url: 'https://x.test' } });

    expect(result['config']).toEqual({ token: '[REDACTED]', url: 'https://x.test' });
  });

  it('redacts sensitive keys inside arrays of objects', () => {
    const result = redact({
      sites: [
        { name: 'one', apiKey: 'abc123' },
        { name: 'two', password: 'def456' },
      ],
    });

    expect(result['sites']).toEqual([
      { name: 'one', apiKey: '[REDACTED]' },
      { name: 'two', password: '[REDACTED]' },
    ]);
  });

  it('truncates long strings, including inside arrays', () => {
    const long = 'a'.repeat(400);
    const result = redact({ body: long, items: [long] });

    expect(result['body']).toBe(`${'a'.repeat(297)}...`);
    expect(result['items']).toEqual([`${'a'.repeat(297)}...`]);
  });

  it('passes primitives and short strings through unchanged', () => {
    const result = redact({ count: 3, ok: true, note: 'short', missing: null });

    expect(result).toEqual({ count: 3, ok: true, note: 'short', missing: null });
  });
});

describe('BaseCommand debug-context URL credential masking', () => {
  it('masks embedded userinfo in a dashboard URL', () => {
    // loadProfile() debug-logs the profile URL; a legacy profile may carry
    // user:pass@, which would otherwise land in stderr and CI logs.
    const result = redact({ dashboardUrl: 'https://admin:s3cr3t@dashboard.example.com' });

    expect(result['dashboardUrl']).toBe('https://***:***@dashboard.example.com');
  });

  it('masks credentialed URLs nested in objects and arrays', () => {
    const result = redact({
      config: { baseUrl: 'https://admin:s3cr3t@dashboard.example.com' },
      urls: ['https://u:p@one.example.com'],
    });

    expect(JSON.stringify(result)).not.toContain('s3cr3t');
    expect(JSON.stringify(result)).not.toContain('u:p@');
  });

  it('masks credentials before truncating, so a long value cannot leak them', () => {
    // Truncation keeps the first 297 chars; masking must happen first or a
    // credential sitting inside that prefix survives.
    const long = `https://admin:s3cr3t@dashboard.example.com/${'a'.repeat(400)}`;
    const result = redact({ body: long });

    expect(result['body']).not.toContain('s3cr3t');
    expect(String(result['body'])).toContain('***:***@');
    expect(String(result['body'])).toMatch(/\.\.\.$/);
  });

  it('redacts a sensitive query parameter in a debug-logged URL', () => {
    // A profile saved before query strings were rejected can still carry
    // ?access_token=; the debug path masked userinfo only and shipped this
    // credential to stderr in full.
    const result = redact({
      dashboardUrl: 'https://dashboard.example.com/wp-json?access_token=SECRET',
    });

    expect(result['dashboardUrl']).toBe(
      'https://dashboard.example.com/wp-json?access_token=[REDACTED]'
    );
  });

  it('redacts a percent-encoded sensitive key in a debug-logged URL', () => {
    const result = redact({
      dashboardUrl: 'https://dashboard.example.com/wp-json?api%5Fkey=SECRET',
    });

    expect(result['dashboardUrl']).toBe(
      'https://dashboard.example.com/wp-json?api%5Fkey=[REDACTED]'
    );
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('leaves URLs without credentials unchanged', () => {
    const result = redact({ dashboardUrl: 'https://dashboard.example.com/wp-json' });

    expect(result['dashboardUrl']).toBe('https://dashboard.example.com/wp-json');
  });
});
