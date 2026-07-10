/**
 * Safety Controller for mainwpcontrol
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
/** Default annotations for abilities without explicit metadata */
const DEFAULT_ANNOTATIONS: AbilityAnnotations = {
  readonly: false,
  destructive: false,
  idempotent: false,
};

export class SafetyController {
  /**
   * Classify an ability's safety requirements
   *
   * Safety classification derives ONLY from ability annotations.
   * No heuristics are permitted.
   */
  classify(ability: Ability): SafetyClassification {
    const annotations = this.validateAnnotations(
      ability.meta?.annotations ?? DEFAULT_ANNOTATIONS
    );

    // SECURITY: Defense-in-depth — force destructive classification for
    // abilities whose names match known-destructive patterns, regardless
    // of what the API reports. Prevents a compromised server from
    // downgrading destructive abilities to bypass the safety flow.
    const destructive = annotations.destructive || this.isKnownDestructivePattern(ability.name);
    const readonly_ = destructive ? false : annotations.readonly;

    return {
      isDestructive: destructive,
      isReadOnly: readonly_,
      isIdempotent: annotations.idempotent,
      requiresSafetyFlow: destructive && !readonly_,
    };
  }

  /**
   * Known-destructive ability name patterns.
   * These abilities require the safety flow regardless of API-reported annotations.
   *
   * Defense-in-depth only: intentionally verb-conservative. Each verb here is
   * unambiguously destructive on its own; we do not add generic verbs like
   * `update-` that are frequently non-destructive, since that would force
   * the preview+confirm flow on safe abilities and erode trust in the prompt.
   */
  private static readonly DESTRUCTIVE_PATTERNS = [
    /^(?:mainwp\/)?delete-/,
    /^(?:mainwp\/)?disconnect-/,
    /^(?:mainwp\/)?suspend-/,
    /^(?:mainwp\/)?deactivate-/,
    /^(?:mainwp\/)?remove-/,
    /^(?:mainwp\/)?run-updates-/,
    /^(?:mainwp\/)?update-all-/,
    /^(?:mainwp\/)?reset-/,
    /^(?:mainwp\/)?restore-/,
    /^(?:mainwp\/)?rollback-/,
    /^(?:mainwp\/)?wipe-/,
    /^(?:mainwp\/)?purge-/,
    /^(?:mainwp\/)?uninstall-/,
  ];

  private isKnownDestructivePattern(name: string): boolean {
    return SafetyController.DESTRUCTIVE_PATTERNS.some(pattern => pattern.test(name));
  }

  /**
   * Validate annotation fields and resolve contradictions.
   *
   * - Non-boolean values fall back to safe defaults.
   * - Contradictory annotations (destructive + readonly) → warn and treat as destructive.
   */
  private validateAnnotations(annotations: AbilityAnnotations): AbilityAnnotations {
    const defaults = DEFAULT_ANNOTATIONS;

    const destructive = typeof annotations.destructive === 'boolean'
      ? annotations.destructive : defaults.destructive;
    let readonly_ = typeof annotations.readonly === 'boolean'
      ? annotations.readonly : defaults.readonly;
    const idempotent = typeof annotations.idempotent === 'boolean'
      ? annotations.idempotent : defaults.idempotent;

    // Contradictory: both destructive and readonly — treat as destructive (safe default)
    if (destructive && readonly_) {
      console.error(
        'Warning: Ability has contradictory annotations (destructive + readonly). ' +
        'Treating as destructive for safety.'
      );
      readonly_ = false;
    }

    return { destructive, readonly: readonly_, idempotent };
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
      throw new MutualExclusionError(
        'dry_run and confirm are mutually exclusive',
        'Use either --dry-run (preview) or --confirm (execute), not both'
      );
    }

    const classification = this.classify(ability);

    // RULE 1: Destructive abilities require explicit flag
    if (classification.requiresSafetyFlow) {
      if (dryRun !== true && confirm !== true) {
        throw new ConfirmationRequiredError(
          `Destructive ability "${ability.name}" requires --dry-run (preview) or --confirm (execute).`,
          undefined,
          'Use --dry-run to preview changes or --confirm to execute'
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

  /** Ability name keywords → past-tense action verbs */
  private static readonly ACTION_VERBS: [string, string][] = [
    ['delete', 'deleted'], ['remove', 'removed'], ['update', 'updated'],
    ['deactivate', 'deactivated'], ['activate', 'activated'],
    ['suspend', 'suspended'], ['disconnect', 'disconnected'],
  ];

  /**
   * Generate human-readable preview summary
   */
  private generatePreviewSummary(ability: Ability, affected: unknown[]): string {
    const count = affected.length;
    const name = ability.name.toLowerCase();
    const action = SafetyController.ACTION_VERBS.find(([k]) => name.includes(k))?.[1] ?? 'affected';

    if (count === 0) return `No items would be ${action}.`;
    if (count === 1) return `1 item would be ${action}.`;
    return `${count} items would be ${action}.`;
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

