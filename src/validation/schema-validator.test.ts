/**
 * Tests for Schema Validator
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SchemaValidator } from './schema-validator.js';

describe('SchemaValidator', () => {
  let validator: SchemaValidator;

  beforeEach(() => {
    validator = new SchemaValidator();
  });

  it('does not mutate the original input object', () => {
    const input: Record<string, unknown> = { count: '5' };
    const original = { ...input };
    const schema = {
      type: 'object',
      properties: { count: { type: 'number' } },
    };

    validator.validate(input, schema);

    // Original input must remain unmodified (string '5', not coerced to number 5)
    expect(input).toEqual(original);
    expect(typeof input.count).toBe('string');
  });

  it('returns coerced values in the result', () => {
    const input: Record<string, unknown> = { count: '5' };
    const schema = {
      type: 'object',
      properties: { count: { type: 'number' } },
    };

    const result = validator.validate(input, schema);

    expect(result.valid).toBe(true);
    expect(result.coerced).toBeDefined();
    expect(result.coerced!.count).toBe(5);
    expect(typeof result.coerced!.count).toBe('number');
  });

  it('applies schema defaults to the coerced copy, not the original', () => {
    const input: Record<string, unknown> = {};
    const schema = {
      type: 'object',
      properties: {
        status: { type: 'string', default: 'active' },
      },
    };

    const result = validator.validate(input, schema);

    expect(result.valid).toBe(true);
    expect(result.coerced!.status).toBe('active');
    // Original must not have the default applied
    expect(input.status).toBeUndefined();
  });

  it('validateOrThrow returns coerced data on success', () => {
    const input: Record<string, unknown> = { count: '10' };
    const schema = {
      type: 'object',
      properties: { count: { type: 'number' } },
    };

    const result = validator.validateOrThrow(input, schema, 'test-ability');

    expect(result.coerced!.count).toBe(10);
    expect(input.count).toBe('10'); // original unchanged
  });

  it('validateOrThrow throws on invalid input', () => {
    const input: Record<string, unknown> = { count: 'not-a-number' };
    const schema = {
      type: 'object',
      properties: { count: { type: 'number' } },
    };

    expect(() => validator.validateOrThrow(input, schema, 'test-ability')).toThrow(
      'Invalid input for ability "test-ability"'
    );
  });

  it('isValid does not mutate original input', () => {
    const input: Record<string, unknown> = { count: '5' };
    const original = { ...input };
    const schema = {
      type: 'object',
      properties: { count: { type: 'number' } },
    };

    const valid = validator.isValid(input, schema);

    expect(valid).toBe(true);
    expect(input).toEqual(original);
  });
});
