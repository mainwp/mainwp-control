import { describe, expect, it } from 'vitest';
import { sanitizeProviderErrorBody } from './provider-fetch.js';

describe('sanitizeProviderErrorBody', () => {
  it('strips terminal control characters', () => {
    expect(sanitizeProviderErrorBody('\x1b]0;Injected\x07failure')).toBe('failure');
  });

  it('truncates response bodies to 500 characters', () => {
    const output = sanitizeProviderErrorBody('x'.repeat(501));

    expect(output).toHaveLength(503);
    expect(output).toBe(`${'x'.repeat(500)}...`);
  });
});
