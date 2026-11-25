/**
 * Golden Tests for SafetyController
 *
 * These tests verify the non-negotiable safety invariants from PLAN.md §2.1:
 * - dry_run and confirm are mutually exclusive
 * - Destructive abilities require preview first
 *
 * CRITICAL: These tests are normative. Any failure indicates a violation
 * of the safety contract.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  SafetyController,
  isKnownDestructiveName,
} from './safety-controller.js';
import { MutualExclusionError, ConfirmationRequiredError } from '../utils/errors.js';
import type { Ability } from './abilities-executor.js';

/**
 * Create a test ability with specified annotations
 */
function createTestAbility(
  name: string,
  annotations: { readonly?: boolean; destructive?: boolean; idempotent?: boolean }
): Ability {
  return {
    name,
    label: name,
    description: `Test ability: ${name}`,
    category: 'test',
    meta: {
      annotations: {
        readonly: annotations.readonly ?? false,
        destructive: annotations.destructive ?? false,
        idempotent: annotations.idempotent ?? false,
      },
    },
  };
}

const NESTED_WRITE_ONLY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    credentials: {
      type: 'object',
      properties: {
        label: { type: 'string' },
        secret: { type: 'string', writeOnly: true },
      },
    },
    targets: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          token: { type: 'string', writeOnly: true },
        },
      },
    },
  },
};

describe('Golden Test: Mutual Exclusion (dry_run XOR confirm)', () => {
  let controller: SafetyController;

  beforeEach(() => {
    controller = new SafetyController();
  });

  /**
   * GOLDEN TEST #1: Mutual exclusion is enforced
   *
   * From PLAN.md §2.1:
   * > dry_run and confirm are mutually exclusive
   *
   * This MUST throw MutualExclusionError when both are true.
   */
  it('throws MutualExclusionError when both dry_run and confirm are true', () => {
    const ability = createTestAbility('delete-site-v1', { destructive: true });

    expect(() => {
      controller.validateExecutionFlags(ability, true, true);
    }).toThrow(MutualExclusionError);
  });

  it('throws MutualExclusionError for any ability when both flags are true', () => {
    // Even for read-only abilities, mutual exclusion must be enforced
    const readonlyAbility = createTestAbility('list-sites-v1', { readonly: true });
    const normalAbility = createTestAbility('update-site-v1', { destructive: false });

    expect(() => {
      controller.validateExecutionFlags(readonlyAbility, true, true);
    }).toThrow(MutualExclusionError);

    expect(() => {
      controller.validateExecutionFlags(normalAbility, true, true);
    }).toThrow(MutualExclusionError);
  });

  it('allows dry_run=true alone', () => {
    const ability = createTestAbility('delete-site-v1', { destructive: true });

    expect(() => {
      controller.validateExecutionFlags(ability, true, false);
    }).not.toThrow();
  });

  it('allows confirm=true alone', () => {
    const ability = createTestAbility('delete-site-v1', { destructive: true });

    expect(() => {
      controller.validateExecutionFlags(ability, false, true);
    }).not.toThrow();
  });

  it('allows neither flag for non-destructive abilities', () => {
    const ability = createTestAbility('list-sites-v1', { readonly: true });

    expect(() => {
      controller.validateExecutionFlags(ability, false, false);
    }).not.toThrow();
  });
});

describe('Golden Test: Destructive Preview Requirement', () => {
  let controller: SafetyController;

  beforeEach(() => {
    controller = new SafetyController();
  });

  /**
   * GOLDEN TEST #2: Destructive abilities require explicit flag
   *
   * From PLAN.md §2.1:
   * > If neither is provided, API returns mainwp_confirmation_required
   *
   * From CHAT_PROMPT.md:
   * > Never skip preview. Never inject confirm.
   */
  it('throws ConfirmationRequiredError for destructive ability without flags', () => {
    const ability = createTestAbility('delete-site-v1', { destructive: true });

    expect(() => {
      controller.validateExecutionFlags(ability, undefined, undefined);
    }).toThrow(ConfirmationRequiredError);

    try {
      controller.validateExecutionFlags(ability, undefined, undefined);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfirmationRequiredError);
      const confirmError = error as ConfirmationRequiredError;
      expect(confirmError.code).toBe('CONFIRMATION_REQUIRED');
    }
  });

  it('throws ConfirmationRequiredError when both flags are false for destructive ability', () => {
    const ability = createTestAbility('delete-site-v1', { destructive: true });

    expect(() => {
      controller.validateExecutionFlags(ability, false, false);
    }).toThrow(ConfirmationRequiredError);
  });

  it('allows dry_run=true for destructive abilities (preview mode)', () => {
    const ability = createTestAbility('delete-site-v1', { destructive: true });

    expect(() => {
      controller.validateExecutionFlags(ability, true, undefined);
    }).not.toThrow();
  });

  it('allows confirm=true for destructive abilities (execution mode)', () => {
    const ability = createTestAbility('delete-site-v1', { destructive: true });

    expect(() => {
      controller.validateExecutionFlags(ability, undefined, true);
    }).not.toThrow();
  });
});

describe('Golden Test: Safety Classification', () => {
  let controller: SafetyController;

  beforeEach(() => {
    controller = new SafetyController();
  });

  /**
   * GOLDEN TEST #3: Classification derives ONLY from annotations
   *
   * From PLAN.md §7:
   * > Safety classification derives ONLY from ability annotations.
   * > No heuristics are permitted.
   */
  it('classifies destructive abilities correctly', () => {
    const ability = createTestAbility('delete-site-v1', { destructive: true });
    const classification = controller.classify(ability);

    expect(classification.isDestructive).toBe(true);
    expect(classification.requiresSafetyFlow).toBe(true);
  });

  it('classifies readonly abilities correctly', () => {
    const ability = createTestAbility('list-sites-v1', { readonly: true });
    const classification = controller.classify(ability);

    expect(classification.isReadOnly).toBe(true);
    expect(classification.requiresSafetyFlow).toBe(false);
  });

  it('contradictory readonly+destructive requires safety flow (treated as destructive)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const ability = createTestAbility('special-v1', {
      readonly: true,
      destructive: true,
    });
    const classification = controller.classify(ability);

    // Contradictory annotations → warn and treat as destructive
    expect(classification.requiresSafetyFlow).toBe(true);
    expect(classification.isReadOnly).toBe(false);
    expect(classification.isDestructive).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('contradictory'));

    errorSpy.mockRestore();
  });

  it('idempotent+destructive still requires safety flow', () => {
    const ability = createTestAbility('delete-cache-v1', {
      destructive: true,
      idempotent: true,
    });
    const classification = controller.classify(ability);

    expect(classification.isDestructive).toBe(true);
    expect(classification.isIdempotent).toBe(true);
    expect(classification.requiresSafetyFlow).toBe(true);
  });

  it('handles abilities without annotations as destructive', () => {
    const ability: Ability = {
      name: 'legacy-ability-v1',
      label: 'Legacy Ability',
      description: 'An ability without annotations',
      category: 'legacy',
      // No meta.annotations
    };
    const classification = controller.classify(ability);

    expect(classification.isDestructive).toBe(true);
    expect(classification.isReadOnly).toBe(false);
    expect(classification.requiresSafetyFlow).toBe(true);
  });
});

describe('Golden Test: Execution Intent', () => {
  let controller: SafetyController;

  beforeEach(() => {
    controller = new SafetyController();
  });

  it('determines preview intent from dry_run flag', () => {
    const intent = controller.determineIntent(true, undefined);
    expect(intent.mode).toBe('preview');
  });

  it('determines execute intent from confirm flag', () => {
    const intent = controller.determineIntent(undefined, true);
    expect(intent.mode).toBe('execute');
  });

  it('determines auto intent when no flags provided', () => {
    const intent = controller.determineIntent(undefined, undefined);
    expect(intent.mode).toBe('auto');
  });

  it('dry_run takes precedence when both are false', () => {
    const intent = controller.determineIntent(false, false);
    expect(intent.mode).toBe('auto');
  });
});

describe('Golden Test: Direct Execution Decision', () => {
  let controller: SafetyController;

  beforeEach(() => {
    controller = new SafetyController();
  });

  it('executes readonly abilities directly', () => {
    const ability = createTestAbility('list-sites-v1', { readonly: true });
    expect(controller.shouldExecuteDirectly(ability, false, false)).toBe(true);
  });

  it('executes with confirm=true directly', () => {
    const ability = createTestAbility('delete-site-v1', { destructive: true });
    expect(controller.shouldExecuteDirectly(ability, false, true)).toBe(true);
  });

  it('does NOT execute destructive with dry_run=true directly', () => {
    const ability = createTestAbility('delete-site-v1', { destructive: true });
    expect(controller.shouldExecuteDirectly(ability, true, false)).toBe(false);
  });

  it('does NOT execute destructive without flags directly', () => {
    const ability = createTestAbility('delete-site-v1', { destructive: true });
    expect(controller.shouldExecuteDirectly(ability, false, false)).toBe(false);
  });
});

describe('Annotation Validation (F2)', () => {
  let controller: SafetyController;

  beforeEach(() => {
    controller = new SafetyController();
  });

  it('treats non-boolean annotation values as destructive', () => {
    const ability: Ability = {
      name: 'bad-annotations-v1',
      label: 'Bad',
      description: 'Ability with non-boolean annotations',
      category: 'test',
      meta: {
        annotations: {
          destructive: 'yes' as unknown as boolean,
          readonly: 1 as unknown as boolean,
          idempotent: null as unknown as boolean,
        },
      },
    };

    const classification = controller.classify(ability);

    expect(classification.isDestructive).toBe(true);
    expect(classification.isReadOnly).toBe(false);
    expect(classification.isIdempotent).toBe(false);
    expect(classification.requiresSafetyFlow).toBe(true);
  });

  it('warns on contradictory annotations and requires safety flow', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const ability = createTestAbility('contradictory-v1', {
      destructive: true,
      readonly: true,
    });

    const classification = controller.classify(ability);

    expect(classification.requiresSafetyFlow).toBe(true);
    expect(classification.isDestructive).toBe(true);
    expect(classification.isReadOnly).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('contradictory')
    );

    errorSpy.mockRestore();
  });

  it('missing/undefined annotation fields require the safety flow', () => {
    const ability: Ability = {
      name: 'no-annotations-v1',
      label: 'None',
      description: 'No annotations',
      category: 'test',
      // No meta at all
    };

    const classification = controller.classify(ability);

    expect(classification.isDestructive).toBe(true);
    expect(classification.isReadOnly).toBe(false);
    expect(classification.isIdempotent).toBe(false);
    expect(classification.requiresSafetyFlow).toBe(true);
  });
});

describe('M6: Known-destructive pattern defense-in-depth', () => {
  let controller: SafetyController;

  beforeEach(() => {
    controller = new SafetyController();
  });

  it('forces destructive classification for delete-* even when API says readonly', () => {
    const ability = createTestAbility('mainwp/delete-site-v1', {
      destructive: false,
      readonly: true,
    });

    const classification = controller.classify(ability);
    expect(classification.isDestructive).toBe(true);
    expect(classification.requiresSafetyFlow).toBe(true);
  });

  it('forces destructive classification for disconnect-* patterns', () => {
    const ability = createTestAbility('disconnect-site-v1', {
      destructive: false,
      readonly: true,
    });

    const classification = controller.classify(ability);
    expect(classification.isDestructive).toBe(true);
    expect(classification.requiresSafetyFlow).toBe(true);
  });

  it('forces destructive classification for suspend-* patterns', () => {
    const ability = createTestAbility('mainwp/suspend-site-v1', {
      destructive: false,
    });

    const classification = controller.classify(ability);
    expect(classification.isDestructive).toBe(true);
    expect(classification.requiresSafetyFlow).toBe(true);
  });

  it('forces destructive classification for run-updates-* patterns', () => {
    const ability = createTestAbility('run-updates-v1', {
      destructive: false,
    });

    const classification = controller.classify(ability);
    expect(classification.isDestructive).toBe(true);
    expect(classification.requiresSafetyFlow).toBe(true);
  });

  it.each(['update-site-plugins-v1', 'activate-site-theme-v1'])(
    'forces destructive classification for %s when annotations under-report it',
    (name) => {
      const ability = createTestAbility(name, {
        destructive: false,
        readonly: false,
      });

      const classification = controller.classify(ability);
      expect(classification.isDestructive).toBe(true);
      expect(classification.requiresSafetyFlow).toBe(true);
    }
  );

  // Names and annotations from mainwp/run-safe-update-v1 and its companions in the Dashboard's
  // includes/abilities/class-mainwp-abilities-safe-updates.php.
  it.each([
    'mainwp/run-safe-update-v1',
    'mainwp/continue-safe-update-run-v1',
    'mainwp/cancel-safe-update-run-v1',
    'mainwp/retest-safe-update-site-v1',
    'mainwp/resolve-safe-update-site-v1',
    'mainwp/rollback-safe-update-v1',
    'run-safe-update-v1',
    'continue-safe-update-run-v1',
    'cancel-safe-update-run-v1',
    'retest-safe-update-site-v1',
    'resolve-safe-update-site-v1',
  ])('forces destructive classification for Safe Updates ability %s', (name) => {
    const ability = createTestAbility(name, {
      destructive: false,
      readonly: true,
    });

    expect(isKnownDestructiveName(name)).toBe(true);
    const classification = controller.classify(ability);
    expect(classification.isDestructive).toBe(true);
    expect(classification.isReadOnly).toBe(false);
    expect(classification.requiresSafetyFlow).toBe(true);
  });

  it.each(['mainwp/list-safe-update-runs-v1', 'mainwp/get-safe-update-run-v1'])(
    'keeps Safe Updates read %s read-only',
    (name) => {
      const ability = createTestAbility(name, {
        destructive: false,
        readonly: true,
      });

      expect(isKnownDestructiveName(name)).toBe(false);
      const classification = controller.classify(ability);
      expect(classification.isDestructive).toBe(false);
      expect(classification.isReadOnly).toBe(true);
      expect(classification.requiresSafetyFlow).toBe(false);
    }
  );

  it.each(['list-updates-v1', 'cancel-batch-job-v1', 'continue-sync-v1', 'run-site-checks-v1'])(
    'does not widen the Safe Updates patterns to %s',
    (name) => {
      expect(isKnownDestructiveName(name)).toBe(false);
      expect(isKnownDestructiveName(`mainwp/${name}`)).toBe(false);
    }
  );

  it.each(['get-site-v1', 'sync-sites-v1'])(
    'keeps %s non-destructive',
    (name) => {
      const ability = createTestAbility(name, {
        destructive: false,
        readonly: false,
      });

      const classification = controller.classify(ability);
      expect(classification.isDestructive).toBe(false);
      expect(classification.requiresSafetyFlow).toBe(false);
    }
  );

  it('does not force destructive for non-matching ability names', () => {
    const ability = createTestAbility('list-sites-v1', {
      destructive: false,
      readonly: true,
    });

    const classification = controller.classify(ability);
    expect(classification.isDestructive).toBe(false);
    expect(classification.requiresSafetyFlow).toBe(false);
  });

  it('does not interfere when API already reports destructive correctly', () => {
    const ability = createTestAbility('delete-site-v1', {
      destructive: true,
    });

    const classification = controller.classify(ability);
    expect(classification.isDestructive).toBe(true);
    expect(classification.requiresSafetyFlow).toBe(true);
  });

  it('forces destructive classification for reset-* patterns', () => {
    const ability = createTestAbility('mainwp/reset-site-v1', {
      destructive: false,
      readonly: true,
    });

    const classification = controller.classify(ability);
    expect(classification.isDestructive).toBe(true);
    expect(classification.requiresSafetyFlow).toBe(true);
  });

  it('forces destructive classification for restore-* patterns', () => {
    const ability = createTestAbility('restore-backup-v1', {
      destructive: false,
    });

    const classification = controller.classify(ability);
    expect(classification.isDestructive).toBe(true);
    expect(classification.requiresSafetyFlow).toBe(true);
  });

  it('forces destructive classification for rollback-* patterns', () => {
    const ability = createTestAbility('mainwp/rollback-plugin-v1', {
      destructive: false,
    });

    const classification = controller.classify(ability);
    expect(classification.isDestructive).toBe(true);
    expect(classification.requiresSafetyFlow).toBe(true);
  });

  it('forces destructive classification for wipe-* patterns', () => {
    const ability = createTestAbility('wipe-site-v1', {
      destructive: false,
    });

    const classification = controller.classify(ability);
    expect(classification.isDestructive).toBe(true);
    expect(classification.requiresSafetyFlow).toBe(true);
  });

  it('forces destructive classification for purge-* patterns', () => {
    const ability = createTestAbility('mainwp/purge-cache-v1', {
      destructive: false,
      readonly: true,
    });

    const classification = controller.classify(ability);
    expect(classification.isDestructive).toBe(true);
    expect(classification.requiresSafetyFlow).toBe(true);
  });

  it('forces destructive classification for uninstall-* patterns', () => {
    const ability = createTestAbility('uninstall-plugin-v1', {
      destructive: false,
    });

    const classification = controller.classify(ability);
    expect(classification.isDestructive).toBe(true);
    expect(classification.requiresSafetyFlow).toBe(true);
  });

  it('does not force destructive for generic update-* patterns', () => {
    const ability = createTestAbility('update-dashboard-settings-v1', {
      destructive: false,
      readonly: true,
    });

    const classification = controller.classify(ability);
    expect(classification.isDestructive).toBe(false);
    expect(classification.requiresSafetyFlow).toBe(false);
  });
});

describe('formatPreviewResult: fail closed on absent preview evidence', () => {
  let controller: SafetyController;

  beforeEach(() => {
    controller = new SafetyController();
  });

  it('data undefined: honest "no data" warning, affected [], requiresApproval true', () => {
    const ability = createTestAbility('delete-site-v1', { destructive: true });
    const result = controller.formatPreviewResult(ability, {}, {
      success: true,
    });

    expect(result.affected).toEqual([]);
    expect(result.summary).toContain('Preview returned no data');
    expect(result.summary).not.toContain('No items would be affected');
    expect(result.requiresApproval).toBe(true);
  });

  it('data {}: same "no data" warning path as undefined data', () => {
    const ability = createTestAbility('delete-site-v1', { destructive: true });
    const result = controller.formatPreviewResult(ability, {}, {
      success: true,
      data: {},
    });

    expect(result.affected).toEqual([]);
    expect(result.summary).toContain('Preview returned no data');
    expect(result.summary).not.toContain('No items would be affected');
    expect(result.requiresApproval).toBe(true);
  });

  it('data in an unrecognized shape: "unrecognized format" warning, raw payload as affected', () => {
    const ability = createTestAbility('delete-site-v1', { destructive: true });
    const data = { foo: 'bar' };
    const result = controller.formatPreviewResult(ability, {}, {
      success: true,
      data,
    });

    expect(result.summary).toContain('unrecognized format');
    expect(result.affected).toEqual([data]);
    expect(result.requiresApproval).toBe(true);
  });

  it('data {affected: []}: recognized-but-empty summary "No items would be <verb>."', () => {
    const ability = createTestAbility('delete-site-v1', { destructive: true });
    const result = controller.formatPreviewResult(ability, {}, {
      success: true,
      data: { affected: [] },
    });

    expect(result.summary).toBe('No items would be deleted.');
    expect(result.affected).toEqual([]);
    expect(result.requiresApproval).toBe(true);
  });

  it('data {affected: [{id: 1}]}: counts 1 item, affected contains the item', () => {
    const ability = createTestAbility('delete-site-v1', { destructive: true });
    const item = { id: 1 };
    const result = controller.formatPreviewResult(ability, {}, {
      success: true,
      data: { affected: [item] },
    });

    expect(result.summary).toBe('1 item would be deleted.');
    expect(result.affected).toEqual([item]);
    expect(result.requiresApproval).toBe(true);
  });

  it('data {preview: {...}}: single-item preview still works', () => {
    const ability = createTestAbility('delete-site-v1', { destructive: true });
    const preview = { name: 'site-1' };
    const result = controller.formatPreviewResult(ability, {}, {
      success: true,
      data: { preview },
    });

    expect(result.summary).toBe('1 item would be deleted.');
    expect(result.affected).toEqual([preview]);
    expect(result.requiresApproval).toBe(true);
  });

  it('masks nested object and array writeOnly input values on the recognized path', () => {
    const ability = createTestAbility('delete-site-v1', { destructive: true });
    ability.input_schema = NESTED_WRITE_ONLY_SCHEMA;

    const result = controller.formatPreviewResult(ability, {
      credentials: { label: 'visible', secret: 'input-object-secret' },
      targets: [{ id: 7, token: 'input-array-secret' }],
    }, {
      success: true,
      data: { affected: [{ id: 7 }] },
    });

    expect(result.input).toEqual({
      credentials: { label: 'visible', secret: '[REDACTED]' },
      targets: [{ id: 7, token: '[REDACTED]' }],
    });
  });

  it('masks writeOnly values behind JSON-derived prototype-like own keys', () => {
    const ability = createTestAbility('delete-site-v1', { destructive: true });
    const dangerousProperties = JSON.parse(JSON.stringify({
      ['__proto__']: NESTED_WRITE_ONLY_SCHEMA,
      constructor: NESTED_WRITE_ONLY_SCHEMA,
      prototype: NESTED_WRITE_ONLY_SCHEMA,
    })) as Record<string, unknown>;
    ability.input_schema = {
      type: 'object',
      properties: dangerousProperties,
    };
    const input = JSON.parse(`{
      "__proto__":{"credentials":{"secret":"proto-secret"}},
      "constructor":{"targets":[{"token":"constructor-secret"}]},
      "prototype":{"credentials":{"secret":"prototype-secret"}}
    }`) as Record<string, unknown>;
    Object.setPrototypeOf(input, null);

    const result = controller.formatPreviewResult(ability, input, {
      success: true,
      data: { affected: [{ id: 7 }] },
    });

    expect(Object.getPrototypeOf(result.input)).toBe(null);
    expect(result.input).toEqual({
      ['__proto__']: { credentials: { secret: '[REDACTED]' } },
      constructor: { targets: [{ token: '[REDACTED]' }] },
      prototype: { credentials: { secret: '[REDACTED]' } },
    });
    expect(JSON.stringify(result.input)).not.toMatch(/proto-secret|constructor-secret|prototype-secret/);
  });

  it('masks nested object and array writeOnly response values on the recognized path', () => {
    const ability = createTestAbility('delete-site-v1', { destructive: true });
    ability.output_schema = {
      type: 'object',
      properties: {
        affected: {
          type: 'array',
          items: NESTED_WRITE_ONLY_SCHEMA,
        },
      },
    };

    const result = controller.formatPreviewResult(ability, {}, {
      success: true,
      data: {
        affected: [{
          credentials: { label: 'visible', secret: 'response-object-secret' },
          targets: [{ id: 7, token: 'response-array-secret' }],
        }],
      },
    });

    expect(result.affected).toEqual([{
      credentials: { label: 'visible', secret: '[REDACTED]' },
      targets: [{ id: 7, token: '[REDACTED]' }],
    }]);
  });

  it('masks nested object and array writeOnly input values on the unrecognized path', () => {
    const ability = createTestAbility('delete-site-v1', { destructive: true });
    ability.input_schema = NESTED_WRITE_ONLY_SCHEMA;

    const result = controller.formatPreviewResult(ability, {
      credentials: { label: 'visible', secret: 'input-object-secret' },
      targets: [{ id: 7, token: 'input-array-secret' }],
    }, {
      success: true,
      data: { payload: { name: 'visible' } },
    });

    expect(result.summary).toContain('unrecognized format');
    expect(result.input).toEqual({
      credentials: { label: 'visible', secret: '[REDACTED]' },
      targets: [{ id: 7, token: '[REDACTED]' }],
    });
  });

  it('masks nested object and array writeOnly response values on the unrecognized path', () => {
    const ability = createTestAbility('delete-site-v1', { destructive: true });
    ability.output_schema = {
      type: 'object',
      properties: {
        payload: NESTED_WRITE_ONLY_SCHEMA,
      },
    };

    const result = controller.formatPreviewResult(ability, {}, {
      success: true,
      data: {
        payload: {
          credentials: { label: 'visible', secret: 'response-object-secret' },
          targets: [{ id: 7, token: 'response-array-secret' }],
        },
      },
    });

    expect(result.summary).toContain('unrecognized format');
    expect(result.affected).toEqual([{
      payload: {
        credentials: { label: 'visible', secret: '[REDACTED]' },
        targets: [{ id: 7, token: '[REDACTED]' }],
      },
    }]);
  });
});

describe('ACTION_VERBS substring ordering', () => {
  it('uses "deactivated" verb for deactivate abilities, not "activated"', () => {
    const controller = new SafetyController();
    const ability = createTestAbility('mainwp/deactivate-site-plugins-v1', {
      destructive: true,
    });
    const result = controller.formatPreviewResult(ability, {}, {
      success: true,
      data: { affected: [{ id: 1 }] },
    });
    expect(result.summary).toContain('deactivated');
    // Ensure it matched "deactivate" not "activate" — the word before
    // "activated" must be "de" (i.e., only "deactivated" appears, not
    // a separate "activated" match)
    expect(result.summary).not.toMatch(/(?<!de)activated/);
  });
});
