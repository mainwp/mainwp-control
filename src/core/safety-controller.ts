/**
 * Safety Controller for mainwpctl
 *
 * Enforces the destructive action protocol defined in PLAN.md:
 * - Safety check happens BEFORE any network call
 * - dry_run and confirm are mutually exclusive
 * - Destructive abilities require preview first
 *
 * INVARIANT: AI is the primary interaction surface, NOT the execution authority.
 */

import type { Ability, AbilityAnnotations, ExecutionResult } from './abilities-executor.js';
import { MutualExclusionError, ConfirmationRequiredError } from '../utils/errors.js';

/**
 * Preview result from dry_run execution
 */
export interface PreviewResult {
  /** Items that would be affected */
  affected: unknown[];
  /** Summary of changes */
  summary: string;
  /** Whether approval is required to execute */
  requiresApproval: boolean;
  /** The ability being previewed */
  abilityName: string;
  /** Original input parameters */
  input: Record<string, unknown>;
}

/**
 * Safety classification for an ability
 */
export interface SafetyClassification {
  /** Whether this ability is destructive */
  isDestructive: boolean;
  /** Whether this ability is read-only */
  isReadOnly: boolean;
  /** Whether this ability is idempotent */
  isIdempotent: boolean;
  /** Whether safety flow is required */
  requiresSafetyFlow: boolean;
}

/**
 * Execution intent from user
 */
export type ExecutionIntent =
  | { mode: 'preview' }      // dry_run=true - show what would happen
  | { mode: 'execute' }      // confirm=true - execute after preview
  | { mode: 'auto' };        // Neither specified - let system decide

/**
 * Safety Controller class
 *
 * SAFETY RULES (HARD - from PLAN.md §2.1):
 * 1. If destructive === true:
 *    - dry_run: true → preview mode
 *    - confirm: true → execution mode
 *    - Neither → error mainwp_confirmation_required
 * 2. dry_run and confirm are MUTUALLY EXCLUSIVE
 * 3. Safety check happens BEFORE any network call
 */
export class SafetyController {
  /**
   * Classify an ability's safety requirements
   *
   * Safety classification derives ONLY from ability annotations.
   * No heuristics are permitted.
   */
  classify(ability: Ability): SafetyClassification {
    const annotations = ability.meta?.annotations ?? this.getDefaultAnnotations();

    return {
      isDestructive: annotations.destructive,
      isReadOnly: annotations.readonly,
      isIdempotent: annotations.idempotent,
      requiresSafetyFlow: annotations.destructive && !annotations.readonly,
    };
  }

  /**
   * Check if an ability requires the safety flow
   */
  requiresSafetyFlow(ability: Ability): boolean {
    return this.classify(ability).requiresSafetyFlow;
  }

  /**
   * Validate execution flags BEFORE any network call
   *
   * @throws MutualExclusionError if dry_run and confirm are both true
   * @throws InputError if destructive ability has neither flag
   */
  validateExecutionFlags(
    ability: Ability,
    dryRun?: boolean,
    confirm?: boolean
  ): void {
    // RULE 2: Mutual exclusion check
    if (dryRun === true && confirm === true) {
      throw new MutualExclusionError();
    }

    const classification = this.classify(ability);

    // RULE 1: Destructive abilities require explicit flag
    if (classification.requiresSafetyFlow) {
      if (dryRun !== true && confirm !== true) {
        throw new ConfirmationRequiredError(
          `Destructive ability "${ability.name}" requires --dry-run (preview) or --confirm (execute).`
        );
      }
    }
  }

  /**
   * Determine execution intent from flags
   */
  determineIntent(dryRun?: boolean, confirm?: boolean): ExecutionIntent {
    if (dryRun === true) {
      return { mode: 'preview' };
    }
    if (confirm === true) {
      return { mode: 'execute' };
    }
    return { mode: 'auto' };
  }

  /**
   * Check if execution should proceed directly (without preview)
   *
   * Returns true for:
   * - Read-only abilities
   * - Explicit confirm flag
   * - Non-destructive abilities
   */
  shouldExecuteDirectly(
    ability: Ability,
    dryRun?: boolean,
    confirm?: boolean
  ): boolean {
    const classification = this.classify(ability);

    // Read-only abilities always execute directly
    if (classification.isReadOnly) {
      return true;
    }

    // Explicit confirm flag means execute
    if (confirm === true) {
      return true;
    }

    // Non-destructive abilities execute directly
    if (!classification.requiresSafetyFlow) {
      return true;
    }

    // Preview mode
    if (dryRun === true) {
      return false;
    }

    // Destructive without flags - this should have been caught by validateExecutionFlags
    return false;
  }

  /**
   * Build execution parameters with appropriate flags
   */
  buildExecutionParams(
    input: Record<string, unknown>,
    ability: Ability,
    dryRun?: boolean,
    confirm?: boolean
  ): Record<string, unknown> {
    const params = { ...input };
    const classification = this.classify(ability);

    // Only add flags for abilities that support them
    if (classification.requiresSafetyFlow) {
      if (dryRun === true) {
        params['dry_run'] = true;
      } else if (confirm === true) {
        params['confirm'] = true;
        params['user_confirmed'] = true;
      }
    }

    return params;
  }

  /**
   * Format a preview result from API response
   */
  formatPreviewResult(
    ability: Ability,
    input: Record<string, unknown>,
    apiResult: ExecutionResult
  ): PreviewResult {
    // Extract affected items from result
    const data = apiResult.data as Record<string, unknown> | undefined;
    const affected = this.extractAffectedItems(data);

    return {
      affected,
      summary: this.generatePreviewSummary(ability, affected),
      requiresApproval: true,
      abilityName: ability.name,
      input,
    };
  }

  /**
   * Extract affected items from API preview response
   */
  private extractAffectedItems(data: Record<string, unknown> | undefined): unknown[] {
    if (!data) {
      return [];
    }

    // Common patterns for affected items
    if (Array.isArray(data['affected'])) {
      return data['affected'];
    }
    if (Array.isArray(data['items'])) {
      return data['items'];
    }
    if (Array.isArray(data['sites'])) {
      return data['sites'];
    }
    if (Array.isArray(data['data'])) {
      return data['data'];
    }

    // Single item preview
    if (data['preview']) {
      return [data['preview']];
    }

    return [];
  }

  /**
   * Generate human-readable preview summary
   */
  private generatePreviewSummary(ability: Ability, affected: unknown[]): string {
    const count = affected.length;
    const action = this.getActionVerb(ability.name);

    if (count === 0) {
      return `No items would be ${action}.`;
    }

    if (count === 1) {
      return `1 item would be ${action}.`;
    }

    return `${count} items would be ${action}.`;
  }

  /**
   * Get action verb from ability name
   */
  private getActionVerb(abilityName: string): string {
    const name = abilityName.toLowerCase();

    if (name.includes('delete')) return 'deleted';
    if (name.includes('remove')) return 'removed';
    if (name.includes('update')) return 'updated';
    if (name.includes('activate')) return 'activated';
    if (name.includes('deactivate')) return 'deactivated';
    if (name.includes('suspend')) return 'suspended';
    if (name.includes('disconnect')) return 'disconnected';

    return 'affected';
  }

  /**
   * Get default annotations for abilities without explicit annotations
   */
  private getDefaultAnnotations(): AbilityAnnotations {
    return {
      readonly: false,
      destructive: false,
      idempotent: false,
    };
  }
}

/**
 * Singleton instance
 */
let instance: SafetyController | null = null;

/**
 * Get the safety controller singleton
 */
export function getSafetyController(): SafetyController {
  if (!instance) {
    instance = new SafetyController();
  }
  return instance;
}

/**
 * Create a new safety controller (for testing)
 */
export function createSafetyController(): SafetyController {
  return new SafetyController();
}
