import { describe, it, expect, vi, afterEach } from 'vitest';
import AbilitiesRun from './run.js';
import { getSchemaValidator } from '../../validation/schema-validator.js';
import { logDestructiveActionSafe } from '../../utils/audit-logger.js';
import type { Ability } from '../../core/abilities-executor.js';

vi.mock('../../utils/audit-logger.js', () => ({
  logDestructiveActionSafe: vi.fn().mockResolvedValue(undefined),
}));

afterEach(() => vi.restoreAllMocks());

describe('abilities run confirmation refusal ordering', () => {
  it.each([
    ['confirm beside pinned', { confirm: { type: 'boolean' }, confirm_first: { const: true } }, ['confirm_first']],
    ['two pinned', { confirm_first: { const: true }, confirm_second: { enum: [true] } }, ['confirm_first', 'confirm_second']],
    ['single pinned with dry_run', { confirm_first: { enum: [true] }, dry_run: { type: 'boolean' } }, ['confirm_first']],
  ])('refuses %s before schema validation for --dry-run and --confirm', async (label, properties, required) => {
    const ability: Ability = {
      name: 'mainwp/restricted-v1', label: 'Restricted', description: '', category: 'test',
      input_schema: { type: 'object', properties, required, additionalProperties: false },
      meta: { annotations: { readonly: false, destructive: true, idempotent: false } },
    };
    const execute = vi.fn();
    const validate = vi.spyOn(getSchemaValidator(), 'validateOrThrow');
    for (const dryRun of [true, false]) {
      const command = Object.assign(Object.create(AbilitiesRun.prototype) as AbilitiesRun, {
        parse: vi.fn().mockResolvedValue({
          args: { name: ability.name },
          flags: { input: '{}', 'dry-run': dryRun, confirm: !dryRun, force: true },
        }),
        initCommon: vi.fn(),
        getExecutor: vi.fn().mockResolvedValue({ getAbility: vi.fn().mockResolvedValue(ability), execute }),
      });
      const pinned = label === 'single pinned with dry_run';
      await expect(command.run()).rejects.toMatchObject({
        code: pinned && !dryRun ? 'PREVIEW_UNAVAILABLE' : 'INPUT_ERROR',
        message: expect.stringContaining(pinned ? 'no preview the CLI can run' : 'ambiguous confirmation'),
      });
    }
    expect(validate).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    if (label === 'single pinned with dry_run') {
      expect(logDestructiveActionSafe).toHaveBeenCalledWith(expect.objectContaining({
        abilityName: ability.name, userDecision: 'declined',
        execution: { success: false, error: 'No dry_run preview contract' },
      }));
    }
  });
});
