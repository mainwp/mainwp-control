/**
 * Abilities run command for mainwpctl
 *
 * Execute abilities with safety enforcement.
 * Routes through SafetyController for destructive actions.
 *
 * INVARIANT: Commands and chat share the same execution path.
 */

import { Args, Flags } from '@oclif/core';
import { BaseCommand, commonFlags } from '../../lib/base-command.js';
import {
  formatSuccess,
  formatWarning,
  formatPreview,
  formatHeading,
  formatKeyValue,
} from '../../output/formatter.js';
import { InputError, MutualExclusionError } from '../../utils/errors.js';
import { getSafetyController, type PreviewResult } from '../../core/safety-controller.js';
import { getSchemaValidator } from '../../validation/schema-validator.js';
import { getInputSanitizer } from '../../validation/input-sanitizer.js';
import { promptForConfirmation, isInteractive } from '../../utils/prompt.js';

export default class AbilitiesRun extends BaseCommand {
  static description = 'Execute an ability';

  static examples = [
    // Read-only abilities
    '<%= config.bin %> abilities run list-sites-v1',
    '<%= config.bin %> abilities run list-sites-v1 --input \'{"status": "connected"}\'',

    // Destructive abilities - preview first
    '<%= config.bin %> abilities run delete-site-v1 --input \'{"site_id": 1}\' --dry-run',

    // Destructive abilities - execute after preview
    '<%= config.bin %> abilities run delete-site-v1 --input \'{"site_id": 1}\' --confirm',

    // JSON output for scripting
    '<%= config.bin %> abilities run list-sites-v1 --json',
  ];

  static flags = {
    ...commonFlags,
    input: Flags.string({
      char: 'i',
      description: 'Input parameters as JSON',
      default: '{}',
    }),
    'dry-run': Flags.boolean({
      description: 'Preview changes without executing (required for destructive abilities)',
      default: false,
      exclusive: ['confirm'],
    }),
    confirm: Flags.boolean({
      description: 'Execute destructive ability (after preview)',
      default: false,
      exclusive: ['dry-run'],
    }),
    force: Flags.boolean({
      description: 'Skip confirmation prompt (use with --confirm)',
      default: false,
    }),
  };

  static args = {
    name: Args.string({
      description: 'Ability name (e.g., list-sites-v1, delete-site-v1)',
      required: true,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AbilitiesRun);
    await this.initCommon(flags);

    const executor = await this.getExecutor();
    const safetyController = getSafetyController();
    const schemaValidator = getSchemaValidator();
    const inputSanitizer = getInputSanitizer();

    // Get ability metadata
    const ability = await executor.getAbility(args.name);
    if (!ability) {
      throw new InputError(
        `Ability not found: ${args.name}. Run \`mainwpctl abilities list\` to see available abilities.`
      );
    }

    // Parse input JSON
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(flags.input) as Record<string, unknown>;
    } catch {
      throw new InputError(`Invalid JSON input: ${flags.input}`);
    }

    // Sanitize input
    input = inputSanitizer.sanitize(input);

    // Validate input against schema if available
    if (ability.input_schema) {
      schemaValidator.validateOrThrow(input, ability.input_schema, ability.name);
    }

    // Safety validation BEFORE any network call
    const dryRun = flags['dry-run'];
    const confirm = flags.confirm;

    try {
      safetyController.validateExecutionFlags(ability, dryRun, confirm);
    } catch (error) {
      if (error instanceof MutualExclusionError) {
        throw error;
      }
      // For destructive abilities without flags, provide guidance
      if (safetyController.requiresSafetyFlow(ability)) {
        this.outputDestructiveGuidance(ability.name);
        throw error;
      }
      throw error;
    }

    // Determine execution path
    const shouldExecute = safetyController.shouldExecuteDirectly(ability, dryRun, confirm);

    if (!shouldExecute) {
      // Preview mode
      await this.executePreview(ability.name, input, dryRun);
    } else if (confirm && safetyController.requiresSafetyFlow(ability)) {
      // Destructive execution with confirmation
      await this.executeDestructive(ability.name, input, flags.force);
    } else {
      // Direct execution (read-only or non-destructive)
      await this.executeDirect(ability.name, input);
    }
  }

  /**
   * Execute preview (dry_run mode)
   */
  private async executePreview(
    abilityName: string,
    input: Record<string, unknown>,
    _dryRun?: boolean
  ): Promise<void> {
    const executor = await this.getExecutor();

    const result = await executor.execute(abilityName, input, { dryRun: true });

    if (!result.success) {
      throw new InputError(result.error?.message ?? 'Preview failed', result.error);
    }

    const safetyController = getSafetyController();
    const ability = await executor.getAbility(abilityName);
    const preview = safetyController.formatPreviewResult(ability!, input, result);

    this.output(
      {
        mode: 'preview',
        ability: abilityName,
        ...result,
        preview,
      },
      () => this.formatPreviewOutput(preview)
    );
  }

  /**
   * Execute destructive ability with confirmation
   */
  private async executeDestructive(
    abilityName: string,
    input: Record<string, unknown>,
    force: boolean
  ): Promise<void> {
    // In non-interactive mode, require --force or fail
    if (!isInteractive() && !force) {
      throw new InputError(
        'Destructive operations require interactive confirmation or --force flag in non-interactive mode.'
      );
    }

    // Interactive confirmation (unless --force)
    if (!force) {
      const confirmed = await promptForConfirmation(
        `Execute destructive ability "${abilityName}"?`
      );
      if (!confirmed) {
        this.log(formatWarning('Operation cancelled by user.'));
        return;
      }
    }

    const executor = await this.getExecutor();
    const result = await executor.execute(abilityName, input, { confirm: true });

    if (!result.success) {
      throw new InputError(result.error?.message ?? 'Execution failed', result.error);
    }

    this.output(
      {
        mode: 'execute',
        ability: abilityName,
        ...result,
      },
      () => this.formatExecutionOutput(abilityName, result.data)
    );
  }

  /**
   * Execute directly (read-only or non-destructive)
   */
  private async executeDirect(
    abilityName: string,
    input: Record<string, unknown>
  ): Promise<void> {
    const executor = await this.getExecutor();
    const result = await executor.execute(abilityName, input);

    if (!result.success) {
      throw new InputError(result.error?.message ?? 'Execution failed', result.error);
    }

    // Check for batch job
    if (result.jobId) {
      this.output(
        {
          mode: 'batch',
          ability: abilityName,
          jobId: result.jobId,
          ...result,
        },
        () => this.formatBatchOutput(abilityName, result.jobId!)
      );
      return;
    }

    this.output(
      {
        mode: 'execute',
        ability: abilityName,
        ...result,
      },
      () => this.formatExecutionOutput(abilityName, result.data)
    );
  }

  /**
   * Format preview output for human display
   */
  private formatPreviewOutput(preview: PreviewResult): string {
    const lines = [
      formatHeading(`Preview: ${preview.abilityName}`),
      '',
      formatPreview(preview.summary, preview.affected),
    ];

    return lines.join('\n');
  }

  /**
   * Format execution output for human display
   */
  private formatExecutionOutput(abilityName: string, data: unknown): string {
    const lines = [
      formatSuccess(`Executed: ${abilityName}`),
      '',
    ];

    if (data !== undefined) {
      lines.push(formatHeading('Result:'));
      lines.push(JSON.stringify(data, null, 2));
    }

    return lines.join('\n');
  }

  /**
   * Format batch job output
   */
  private formatBatchOutput(abilityName: string, jobId: string): string {
    return [
      formatSuccess(`Batch job started: ${abilityName}`),
      '',
      formatKeyValue('Job ID', jobId),
      '',
      `Monitor progress with: mainwpctl jobs watch ${jobId}`,
    ].join('\n');
  }

  /**
   * Output guidance for destructive abilities
   */
  private outputDestructiveGuidance(abilityName: string): void {
    if (!this.jsonOutput) {
      this.logToStderr('');
      this.logToStderr(formatWarning(`"${abilityName}" is a destructive ability.`));
      this.logToStderr('');
      this.logToStderr('To preview changes:');
      this.logToStderr(`  mainwpctl abilities run ${abilityName} --dry-run --input '{...}'`);
      this.logToStderr('');
      this.logToStderr('To execute after preview:');
      this.logToStderr(`  mainwpctl abilities run ${abilityName} --confirm --input '{...}'`);
      this.logToStderr('');
    }
  }
}
