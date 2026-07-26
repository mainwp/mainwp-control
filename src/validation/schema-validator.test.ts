/**
 * Tests for Schema Validator
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { APIError } from '../utils/errors.js';
import { ExitCode } from '../utils/exit-codes.js';
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

  it('accepts a whole schema serialized as a PHP empty array', () => {
    const schema = [] as unknown as Record<string, unknown>;

    const result = validator.validate({}, schema, 'mainwp/no-input-v1');

    expect(result.valid).toBe(true);
    expect(result.coerced).toEqual({});
  });

  it('accepts properties serialized as a PHP empty array', () => {
    const schema = {
      type: 'object',
      properties: [] as unknown as Record<string, unknown>,
    };

    const result = validator.validate({}, schema, 'mainwp/empty-properties-v1');

    expect(result.valid).toBe(true);
    expect(result.coerced).toEqual({});
  });

  it('accepts a nullable top-level object type array', () => {
    const schema = {
      type: ['object', 'null'],
      properties: {},
    };

    const result = validator.validate({}, schema, 'mainwp/nullable-input-v1');

    expect(result.valid).toBe(true);
    expect(result.coerced).toEqual({});
  });

  it('maps an irreparably invalid ability schema to a typed API error', () => {
    const schema = { type: 42 };
    let thrown: unknown;

    try {
      validator.validate({}, schema, 'mainwp/broken-schema-v1');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(APIError);
    expect(thrown).toMatchObject({
      code: 'ABILITY_SCHEMA_INVALID',
      exitCode: ExitCode.API_ERROR,
    });
    expect((thrown as Error).message).toContain('mainwp/broken-schema-v1');
  });

  describe('async-schema hardening (F13)', () => {
    let unhandled: unknown[];
    let onUnhandled: (reason: unknown) => void;

    beforeEach(() => {
      unhandled = [];
      onUnhandled = (reason) => unhandled.push(reason);
      process.on('unhandledRejection', onUnhandled);
    });

    afterEach(() => {
      process.off('unhandledRejection', onUnhandled);
      vi.restoreAllMocks();
    });

    it('strips $async so an invalid input is reported invalid, not passed as a truthy Promise', async () => {
      // A hostile Dashboard schema declaring $async: true. Before the fix, AJV
      // compiled a Promise-returning validator, the truthy Promise read as
      // valid, and the rejection crashed the process. After the strip it is a
      // plain sync validator that correctly rejects the missing required field.
      const schema = {
        $async: true,
        type: 'object',
        properties: { site_id: { type: 'integer' } },
        required: ['site_id'],
      };

      const result = validator.validate({}, schema, 'mainwp/async-schema-v1');

      expect(result.valid).toBe(false);
      expect(typeof result.valid).toBe('boolean');
      // Let any stray rejection surface before we assert none happened.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
    });

    it('fails closed when a compiled validator returns a non-boolean (defense in depth)', () => {
      // Simulate a future async path the sanitizer does not neutralize: the
      // compiled validator returns a Promise. The guard must reject it as an
      // invalid schema rather than reading the truthy Promise as valid.
      const asyncValidator = Object.assign(() => Promise.resolve(true), { errors: null });
      vi.spyOn(
        (validator as unknown as { ajv: { compile: unknown } }).ajv,
        'compile'
      ).mockReturnValue(asyncValidator);

      let thrown: unknown;
      try {
        validator.validate({}, { type: 'object' }, 'mainwp/would-be-async-v1');
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(APIError);
      expect(thrown).toMatchObject({ code: 'ABILITY_SCHEMA_INVALID' });
    });

    it('isValid also fails closed on a non-boolean validation result', () => {
      const asyncValidator = Object.assign(() => Promise.resolve(true), { errors: null });
      vi.spyOn(
        (validator as unknown as { ajv: { compile: unknown } }).ajv,
        'compile'
      ).mockReturnValue(asyncValidator);

      expect(() => validator.isValid({}, { type: 'object' }, 'mainwp/would-be-async-v1')).toThrow(
        APIError
      );
    });
  });
});
