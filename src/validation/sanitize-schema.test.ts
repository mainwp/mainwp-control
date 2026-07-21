/**
 * Tests for sanitizeInputSchema: PHP empty-array normalization, schema depth
 * cap, and pattern-length cap.
 */

import { describe, it, expect } from 'vitest';
import { sanitizeInputSchema } from './sanitize-schema.js';

function nestedSchema(depth: number): Record<string, unknown> {
  let schema: Record<string, unknown> = { type: 'string' };
  for (let i = 0; i < depth; i++) {
    schema = { type: 'object', properties: { child: schema } };
  }
  return schema;
}

function descend(schema: Record<string, unknown>, times: number): Record<string, unknown> {
  let node = schema;
  for (let i = 0; i < times; i++) {
    node = (node['properties'] as Record<string, unknown>)['child'] as Record<string, unknown>;
  }
  return node;
}

describe('sanitizeInputSchema', () => {
  it('passes a normal schema through unchanged', () => {
    const input = {
      type: 'object',
      properties: {
        site_id: { type: 'integer' },
        name: { type: 'string' },
      },
      required: ['site_id'],
    };

    expect(sanitizeInputSchema(input)).toEqual(input);
  });

  it('normalizes PHP empty-array artifacts', () => {
    const input = {
      type: ['object', 'null'],
      properties: [],
    };

    const result = sanitizeInputSchema(input);

    expect(result['type']).toBe('object');
    expect(result['properties']).toEqual({});
  });

  it('collapses nesting past the depth cap to {}', () => {
    const result = sanitizeInputSchema(nestedSchema(33));

    expect(descend(result, 33)).toEqual({});
  });

  it('preserves nesting within the depth cap', () => {
    const result = sanitizeInputSchema(nestedSchema(5));

    expect(descend(result, 5)).toEqual({ type: 'string' });
  });

  it('drops an overlong or non-string pattern but keeps a short one', () => {
    const input = {
      type: 'object',
      properties: {
        short: { type: 'string', pattern: '^[a-z]+$' },
        long: { type: 'string', pattern: 'a'.repeat(1001) },
        notString: { type: 'string', pattern: 123 },
      },
    };

    const result = sanitizeInputSchema(input);
    const props = result['properties'] as Record<string, Record<string, unknown>>;

    expect(props['short']['pattern']).toBe('^[a-z]+$');
    expect('pattern' in props['long']).toBe(false);
    expect('pattern' in props['notString']).toBe(false);
  });

  it('drops a patternProperties entry whose regex key exceeds the cap', () => {
    const longKey = 'x'.repeat(1001);
    const input = {
      type: 'object',
      patternProperties: {
        '^[a-z]+$': { type: 'string' },
        [longKey]: { type: 'string' },
      },
    };

    const result = sanitizeInputSchema(input);
    const patternProperties = result['patternProperties'] as Record<string, unknown>;

    expect(Object.keys(patternProperties)).toEqual(['^[a-z]+$']);
  });
});
