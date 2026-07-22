import { describe, expect, it, vi } from 'vitest';
import type {
  AbilitiesExecutor,
  Ability,
  ExecutionOptions,
  ExecutionResult,
} from './abilities-executor.js';
import { executeAbilityWithPolicy } from './execute-ability-with-policy.js';
import { ConfirmationRequiredError, MutualExclusionError } from '../utils/errors.js';

function createAbility(name: string, destructive: boolean): Ability {
  return {
    name,
    label: name,
    description: name,
    category: 'test',
    meta: {
      annotations: {
        destructive,
        readonly: !destructive,
        idempotent: false,
      },
    },
  };
}

function createExecutor(result: ExecutionResult = { success: true }): {
  executor: AbilitiesExecutor;
  execute: ReturnType<typeof vi.fn>;
} {
  const execute = vi.fn().mockResolvedValue(result);
  return {
    executor: { execute } as unknown as AbilitiesExecutor,
    execute,
  };
}

describe('executeAbilityWithPolicy', () => {
  it('rejects dryRun and confirm together before execution', async () => {
    const { executor, execute } = createExecutor();

    await expect(
      executeAbilityWithPolicy(
        executor,
        createAbility('list-sites-v1', false),
        {},
        { dryRun: true, confirm: true }
      )
    ).rejects.toBeInstanceOf(MutualExclusionError);
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects destructive execution without confirm unless it is a dry run', async () => {
    const { executor, execute } = createExecutor();

    await expect(
      executeAbilityWithPolicy(executor, createAbility('delete-site-v1', true), {})
    ).rejects.toBeInstanceOf(ConfirmationRequiredError);
    expect(execute).not.toHaveBeenCalled();
  });

  it('passes non-destructive abilities through', async () => {
    const result = { success: true, data: { sites: [] } };
    const { executor, execute } = createExecutor(result);
    const ability = createAbility('list-sites-v1', false);

    await expect(executeAbilityWithPolicy(executor, ability, { page: 2 })).resolves.toBe(result);
    expect(execute).toHaveBeenCalledWith('list-sites-v1', { page: 2 });
  });

  it.each<ExecutionOptions>([
    { dryRun: true },
    { confirm: true },
  ])('forwards execution options faithfully: %j', async (options) => {
    const { executor, execute } = createExecutor();
    const ability = createAbility('delete-site-v1', true);

    await executeAbilityWithPolicy(executor, ability, { site_id: 1 }, options);

    expect(execute).toHaveBeenCalledWith('delete-site-v1', { site_id: 1 }, options);
  });
});
