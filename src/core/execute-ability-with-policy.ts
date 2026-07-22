/**
 * Shared policy-enforcing choke point for ability execution.
 *
 * UX decisions such as prompting and preview rendering remain with callers.
 */

import type {
  AbilitiesExecutor,
  Ability,
  ExecutionOptions,
  ExecutionResult,
} from './abilities-executor.js';
import { getSafetyController } from './safety-controller.js';

export async function executeAbilityWithPolicy<T = unknown>(
  executor: AbilitiesExecutor,
  ability: Ability,
  input: Record<string, unknown>,
  options?: ExecutionOptions
): Promise<ExecutionResult<T>> {
  const safetyController = getSafetyController();

  // This shared gate classifies the ability, rejects mutually exclusive flags,
  // and refuses destructive execution unless the call is a preview or carries
  // explicit confirmation. AbilitiesExecutor keeps its own transport-level
  // control-flag enforcement as defense in depth.
  safetyController.validateExecutionFlags(
    ability,
    options?.dryRun,
    options?.confirm
  );

  if (options === undefined) {
    return executor.execute<T>(ability.name, input);
  }

  return executor.execute<T>(ability.name, input, options);
}
