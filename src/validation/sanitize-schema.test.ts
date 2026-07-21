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

  it('drops every remotely supplied pattern, safe-looking or not', () => {
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

    // Guaranteed-safe policy: no remote regex is ever compiled client-side,
    // so even an innocuous-looking pattern is removed.
    expect('pattern' in props['short']!).toBe(false);
    expect('pattern' in props['long']!).toBe(false);
    expect('pattern' in props['notString']!).toBe(false);
  });

  it('drops patternProperties wholesale', () => {
    const input = {
      type: 'object',
      patternProperties: {
        '^[a-z]+$': { type: 'string' },
        '^(b+)+$': { type: 'string' },
      },
    };

    const result = sanitizeInputSchema(input);

    expect('patternProperties' in result).toBe(false);
  });

  it('scrubs patterns reached through draft-07 dependencies (bypass regression)', () => {
    const input = {
      type: 'object',
      dependencies: {
        x: {
          properties: {
            y: { type: 'string', pattern: '^(a+)+$' },
          },
        },
      },
    };

    const result = sanitizeInputSchema(input);
    const dep = (result['dependencies'] as Record<string, Record<string, unknown>>)['x']!;
    const y = (dep['properties'] as Record<string, Record<string, unknown>>)['y']!;

    expect('pattern' in y).toBe(false);
  });

  it('scrubs patterns nested under unknown or future keywords', () => {
    const input = {
      type: 'object',
      someFutureKeyword: {
        deeper: [{ pattern: '^(a+)+$', patternProperties: { x: {} } }],
      },
    };

    const result = sanitizeInputSchema(input);
    const future = result['someFutureKeyword'] as Record<string, unknown>;
    const inner = (future['deeper'] as Record<string, unknown>[])[0]!;

    expect('pattern' in inner).toBe(false);
    expect('patternProperties' in inner).toBe(false);
  });

  it('preserves properties literally named pattern and data-carrying keys', () => {
    const input = {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
      },
      required: [],
      default: { pattern: '^kept$' },
      examples: [{ pattern: '^also-kept$' }],
    };

    const result = sanitizeInputSchema(input);
    const props = result['properties'] as Record<string, unknown>;

    expect(props['pattern']).toEqual({ type: 'string' });
    expect(result['required']).toEqual([]);
    expect(result['default']).toEqual({ pattern: '^kept$' });
    expect(result['examples']).toEqual([{ pattern: '^also-kept$' }]);
  });

  it('applies the depth cap to nesting through unknown keywords', () => {
    let schema: Record<string, unknown> = { pattern: '^(a+)+$' };
    for (let i = 0; i < 60; i++) {
      schema = { someUnknownKeyword: schema };
    }

    const result = sanitizeInputSchema({ type: 'object', extension: schema });

    let node = result['extension'] as Record<string, unknown>;
    let depth = 0;
    while (node && typeof node === 'object' && 'someUnknownKeyword' in node) {
      node = node['someUnknownKeyword'] as Record<string, unknown>;
      depth++;
    }
    expect(depth).toBeLessThanOrEqual(33);
    expect(node).toEqual({});
  });

  it('applies the depth cap to nested arrays under unknown keywords', () => {
    let value: unknown = 'leaf';
    for (let i = 0; i < 60; i++) {
      value = [value];
    }

    const result = sanitizeInputSchema({ type: 'object', extension: { deepArrays: value } });

    // The array chain is cut off at the cap ({}), never passed through whole.
    let node = (result['extension'] as Record<string, unknown>)['deepArrays'];
    let depth = 0;
    while (Array.isArray(node)) {
      node = node[0];
      depth++;
    }
    expect(depth).toBeLessThanOrEqual(33);
    expect(node).toEqual({});
  });

  it.each(['const', 'enum', 'default', 'examples'])(
    'drops %s wholesale when its literal value nests past the depth cap',
    (dataKey) => {
      let value: unknown = { pattern: 'kept-if-shallow' };
      for (let i = 0; i < 60; i++) {
        value = i % 2 === 0 ? [value] : { wrap: value };
      }

      const result = sanitizeInputSchema({ type: 'object', [dataKey]: value });

      expect(dataKey in result).toBe(false);
    }
  );

  it('drops patterns and patternProperties in nested subschemas too', () => {
    const input = {
      type: 'object',
      properties: {
        nested: {
          type: 'object',
          properties: {
            inner: { type: 'string', pattern: '^(a+)+$' },
          },
          patternProperties: { '^x': { type: 'string' } },
        },
      },
    };

    const result = sanitizeInputSchema(input);
    const nested = (result['properties'] as Record<string, Record<string, unknown>>)['nested']!;
    const inner = (nested['properties'] as Record<string, Record<string, unknown>>)['inner']!;

    expect('pattern' in inner).toBe(false);
    expect('patternProperties' in nested).toBe(false);
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
