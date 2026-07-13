/**
 * Golden Tests for JSON Output
 *
 * These tests verify that --json output:
 * - Always produces valid JSON
 * - Has a stable structure
 * - Parses cleanly
 *
 * From PLAN.md §5:
 * > With --json, stdout MUST contain valid JSON only.
 */

import { describe, it, expect } from 'vitest';
import {
  successOutput,
  errorOutput,
  formatJSON,
  type CLIOutput,
} from './json-envelope.js';
import { InputError, NetworkError, APIError } from '../utils/errors.js';

describe('Golden Test: JSON Output Parses Cleanly', () => {
  /**
   * GOLDEN TEST: Success output produces valid JSON
   */
  it('success output produces valid JSON that parses cleanly', () => {
    const data = {
      sites: [
        { id: 1, name: 'Site 1', url: 'https://site1.local' },
        { id: 2, name: 'Site 2', url: 'https://site2.local' },
      ],
      total: 2,
    };

    const output = successOutput(data, {
      command: 'sites list',
      version: '1.0.0',
    });

    const jsonString = formatJSON(output);

    // Must be valid JSON
    let parsed: CLIOutput;
    expect(() => {
      parsed = JSON.parse(jsonString);
    }).not.toThrow();

    parsed = JSON.parse(jsonString);

    // Must have required structure
    expect(parsed).toHaveProperty('success', true);
    expect(parsed).toHaveProperty('data');
    expect(parsed.data).toHaveProperty('sites');
    expect(parsed.data).toHaveProperty('total', 2);

    // Meta is optional but should be present when provided
    expect(parsed).toHaveProperty('meta');
    expect(parsed.meta).toHaveProperty('command', 'sites list');
    expect(parsed.meta).toHaveProperty('version', '1.0.0');
    expect(parsed.meta).toHaveProperty('timestamp');
  });

  /**
   * GOLDEN TEST: Error output produces valid JSON
   */
  it('error output produces valid JSON that parses cleanly', () => {
    const error = new InputError('Invalid site ID', { expected: 'number' });

    const output = errorOutput(error, {
      command: 'sites get',
      version: '1.0.0',
    });

    const jsonString = formatJSON(output);

    // Must be valid JSON
    let parsed: CLIOutput;
    expect(() => {
      parsed = JSON.parse(jsonString);
    }).not.toThrow();

    parsed = JSON.parse(jsonString);

    // Must have required structure
    expect(parsed).toHaveProperty('success', false);
    expect(parsed).toHaveProperty('error');
    expect(parsed.error).toHaveProperty('code');
    expect(parsed.error).toHaveProperty('message');
  });

  /**
   * GOLDEN TEST: Output has stable envelope structure
   */
  it('output envelope structure is stable', () => {
    // Test various data types
    const testCases = [
      null,
      undefined,
      42,
      'string',
      [],
      {},
      { nested: { deeply: { nested: true } } },
      [1, 2, 3],
    ];

    for (const data of testCases) {
      const output = successOutput(data);
      const jsonString = formatJSON(output);
      const parsed = JSON.parse(jsonString);

      // All outputs must have success field
      expect(parsed).toHaveProperty('success');
      expect(typeof parsed.success).toBe('boolean');
    }
  });

  /**
   * GOLDEN TEST: No non-JSON output in JSON mode
   */
  it('formatJSON returns only JSON with no extra characters', () => {
    const output = successOutput({ test: true });
    const jsonString = formatJSON(output);

    // Should start with { and end with }
    expect(jsonString.trim()).toMatch(/^\{[\s\S]*\}$/);

    // Should not contain any non-JSON preamble
    expect(jsonString).not.toMatch(/^[^{]/);
    expect(jsonString).not.toMatch(/[^}]$/);
  });
});

describe('Golden Test: Error Code Propagation', () => {
  it.each([
    ['Bearer token', 'Request failed with Bearer abc123secret', 'abc123secret', 'Bearer [REDACTED]'],
    ['credential URL', 'Request failed at https://user:pass@host/x', 'user:pass', '[URL_WITH_CREDENTIALS]'],
  ])('redacts %s credentials from Error messages', (_label, message, secret, marker) => {
    const output = errorOutput(new Error(message));

    expect(output.error?.message).not.toContain(secret);
    expect(output.error?.message).toContain(marker);
  });

  it('redacts credentials from error details and hints', () => {
    const output = errorOutput(
      new InputError(
        'Request failed with Bearer message-secret',
        { endpoint: 'https://detail-user:detail-pass@host/x' },
        'Retry with Bearer hint-secret'
      )
    );

    expect(JSON.stringify(output.error)).not.toContain('message-secret');
    expect(JSON.stringify(output.error)).not.toContain('detail-user:detail-pass');
    expect(JSON.stringify(output.error)).not.toContain('hint-secret');
  });

  it('propagates MainWPCTLError codes correctly', () => {
    const inputError = new InputError('Bad input');
    const networkError = new NetworkError('Connection failed');
    const apiError = new APIError('RATE_LIMITED', 'Too many requests', 429);

    const inputOutput = errorOutput(inputError);
    const networkOutput = errorOutput(networkError);
    const apiOutput = errorOutput(apiError);

    expect(JSON.parse(formatJSON(inputOutput)).error.code).toBe('INPUT_ERROR');
    expect(JSON.parse(formatJSON(networkOutput)).error.code).toBe('NETWORK_ERROR');
    expect(JSON.parse(formatJSON(apiOutput)).error.code).toBe('RATE_LIMITED');
  });

  it('handles non-MainWPCTL errors gracefully', () => {
    const genericError = new Error('Something went wrong');
    const output = errorOutput(genericError);
    const parsed = JSON.parse(formatJSON(output));

    expect(parsed.success).toBe(false);
    expect(parsed.error.code).toBe('INTERNAL_ERROR');
    expect(parsed.error.message).toBe('Something went wrong');
  });

  it('handles string errors gracefully', () => {
    const output = errorOutput('Plain string error');
    const parsed = JSON.parse(formatJSON(output));

    expect(parsed.success).toBe(false);
    expect(parsed.error.code).toBe('INTERNAL_ERROR');
    expect(parsed.error.message).toBe('Plain string error');
  });
});

describe('Golden Test: Meta Fields', () => {
  it('timestamp is ISO 8601 format', () => {
    const output = successOutput({}, {
      command: 'test',
      version: '1.0.0',
    });
    const parsed = JSON.parse(formatJSON(output));

    const timestamp = parsed.meta?.timestamp;
    expect(timestamp).toBeDefined();

    // Should be valid ISO 8601
    const date = new Date(timestamp);
    expect(date.toISOString()).toBe(timestamp);
  });

  it('meta is optional', () => {
    const output = successOutput({ data: true });
    const parsed = JSON.parse(formatJSON(output));

    // Meta should not be present when not provided
    expect(parsed.meta).toBeUndefined();
  });
});

describe('Golden Test: Special Characters', () => {
  it('handles special characters in data', () => {
    const data = {
      unicode: '日本語テスト',
      emoji: '🎉🚀',
      newlines: 'line1\nline2\nline3',
      tabs: 'col1\tcol2\tcol3',
      quotes: '"quoted"',
      backslash: 'path\\to\\file',
      html: '<script>alert("xss")</script>',
    };

    const output = successOutput(data);
    const jsonString = formatJSON(output);

    // Must parse without error
    const parsed = JSON.parse(jsonString);
    expect(parsed.data).toEqual(data);
  });

  it('handles very long strings', () => {
    const longString = 'x'.repeat(100000);
    const output = successOutput({ long: longString });
    const jsonString = formatJSON(output);

    const parsed = JSON.parse(jsonString);
    expect(parsed.data.long).toBe(longString);
  });

  it('handles deeply nested objects', () => {
    let nested: Record<string, unknown> = { value: 'deep' };
    for (let i = 0; i < 50; i++) {
      nested = { level: i, child: nested };
    }

    const output = successOutput(nested);
    const jsonString = formatJSON(output);

    const parsed = JSON.parse(jsonString);
    expect(parsed.data).toBeDefined();
  });
});
