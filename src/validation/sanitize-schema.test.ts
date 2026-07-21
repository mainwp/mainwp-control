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

  it('drops a short but catastrophic nested-quantifier pattern', () => {
    const input = {
      type: 'object',
      properties: {
        redos: { type: 'string', pattern: '^(a+)+$' },
        redosStar: { type: 'string', pattern: '(\\d*)*x' },
        safeGroup: { type: 'string', pattern: '^(abc)$' },
      },
      patternProperties: {
        '^(b+)+$': { type: 'string' },
      },
    };

    const result = sanitizeInputSchema(input);
    const props = result['properties'] as Record<string, Record<string, unknown>>;

    expect('pattern' in props['redos']!).toBe(false);
    expect('pattern' in props['redosStar']!).toBe(false);
    expect(props['safeGroup']!['pattern']).toBe('^(abc)$');
    expect(Object.keys(result['patternProperties'] as Record<string, unknown>)).toEqual([]);
  });

  it('sanitizes subschemas reached through contains and dependentSchemas', () => {
    const input = {
      type: 'object',
      properties: {
        list: {
          type: 'array',
          contains: { type: 'string', pattern: '^(a+)+$' },
        },
      },
      dependentSchemas: {
        list: { properties: { extra: { type: 'string', pattern: 'b'.repeat(1001) } } },
      },
    };

    const result = sanitizeInputSchema(input);
    const props = result['properties'] as Record<string, Record<string, unknown>>;
    const contains = props['list']!['contains'] as Record<string, unknown>;
    expect('pattern' in contains).toBe(false);

    const dependent = (result['dependentSchemas'] as Record<string, Record<string, unknown>>)['list']!;
    const extra = (dependent['properties'] as Record<string, Record<string, unknown>>)['extra']!;
    expect('pattern' in extra).toBe(false);
  });

  it('applies the depth cap to nesting through contains', () => {
    let schema: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < 40; i++) {
      schema = { type: 'array', contains: schema };
    }

    const result = sanitizeInputSchema({ type: 'object', properties: { deep: schema } });

    let node = (result['properties'] as Record<string, Record<string, unknown>>)['deep']!;
    let depth = 0;
    while (node && typeof node === 'object' && 'contains' in node) {
      node = node['contains'] as Record<string, Record<string, unknown>>;
      depth++;
    }
    // The chain is cut off at the cap instead of recursing all 40 levels.
    expect(depth).toBeLessThanOrEqual(33);
    expect(node).toEqual({});
  });
});
