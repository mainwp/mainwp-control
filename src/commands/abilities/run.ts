/**
 * Abilities run command for mainwpctl
 *
 * Execute abilities with safety enforcement.
 * Routes through SafetyController for destructive actions.
 *
 * INVARIANT: Commands and chat share the same execution path.
 */

import { Args, Flags } from '@oclif/core';
import { readFile } from 'node:fs/promises';
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
import { logDestructiveActionSafe } from '../../utils/audit-logger.js';
import type { WatchResult } from '../../core/batch-manager.js';
import { APIError } from '../../utils/errors.js';

export default class AbilitiesRun extends BaseCommand {
  static description = 'Execute an ability';

  static examples = [
    // Read-only abilities
    '<%= config.bin %> abilities run list-sites-v1',
    '<%= config.bin %> abilities run list-sites-v1 --input \'{"status": "connected"}\'',

    // Input from file or stdin
    '<%= config.bin %> abilities run update-site-plugins-v1 --input-file params.json --confirm',
    'echo \'{"site_id": 5}\' | <%= config.bin %> abilities run list-sites-v1 --input -',

    // Destructive abilities - preview first
    '<%= config.bin %> abilities run delete-site-v1 --input \'{"site_id": 1}\' --dry-run',

    // Destructive abilities - execute after preview
    '<%= config.bin %> abilities run delete-site-v1 --input \'{"site_id": 1}\' --confirm',

    // Wait for batch job completion
    '<%= config.bin %> abilities run sync-sites-v1 --wait --json',

    // JSON output for scripting
    '<%= config.bin %> abilities run list-sites-v1 --json',

    // Quiet mode (exit code only)
    '<%= config.bin %> abilities run check-site-v1 --input \'{"site_id": 1}\' --quiet',
  ];

  static flags = {
    ...commonFlags,
    input: Flags.string({
      char: 'i',
      description: 'Input parameters as JSON (use "-" to read from stdin)',
      default: '{}',
      exclusive: ['input-file'],
    }),
    'input-file': Flags.string({
      description: 'Read input parameters from a JSON file',
      exclusive: ['input'],
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
    wait: Flags.boolean({
      description: 'Wait for batch job to complete (blocks until done)',
      default: false,
    }),
    'wait-timeout': Flags.integer({
      description: 'Maximum seconds to wait for batch job (default: 300)',
      default: 300,
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

    // Resolve input from --input, --input-file, or stdin
    const rawInput = await this.resolveInput(flags.input, flags['input-file']);

    // Parse input JSON
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(rawInput) as Record<string, unknown>;
    } catch {
      throw new InputError(`Invalid JSON input: ${rawInput}`);
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
    const requiresSafetyFlow = safetyController.requiresSafetyFlow(ability);

    this.debugLog('Resolved ability execution', {
      abilityName: ability.name,
      dryRun,
      confirm,
      wait: flags.wait,
      waitTimeoutSeconds: flags['wait-timeout'],
      requiresSafetyFlow,
    });

    try {
      safetyController.validateExecutionFlags(ability, dryRun, confirm);
    } catch (error) {
      if (error instanceof MutualExclusionError) {
        throw error;
      }
      // For destructive abilities without flags, provide guidance
      if (requiresSafetyFlow) {
        this.outputDestructiveGuidance(ability.name);
        throw error;
      }
      throw error;
    }

    // Determine execution path
    const shouldExecute = safetyController.shouldExecuteDirectly(ability, dryRun, confirm);

    if (dryRun || !shouldExecute) {
      // Preview mode — --dry-run always previews, regardless of ability classification
      await this.executePreview(ability.name, input, dryRun);
    } else if (confirm && safetyController.requiresSafetyFlow(ability)) {
      // Destructive execution with confirmation
      await this.executeDestructive({
        abilityName: ability.name,
        input,
        force: flags.force,
        wait: flags.wait,
        waitTimeout: flags['wait-timeout'],
      });
    } else {
      // Direct execution (read-only or non-destructive)
      await this.executeDirect({
        abilityName: ability.name,
        input,
        wait: flags.wait,
        waitTimeout: flags['wait-timeout'],
      });
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
  private async executeDestructive(opts: {
    abilityName: string;
    input: Record<string, unknown>;
    force: boolean;
    wait?: boolean;
    waitTimeout?: number;
  }): Promise<void> {
    const { abilityName, input, force, wait, waitTimeout } = opts;
    const executor = await this.getExecutor();
    const safetyController = getSafetyController();

    // Get preview data first for audit logging (gracefully handle failures)
    let preview: PreviewResult | undefined;
    try {
      const ability = await executor.getAbility(abilityName);
      const previewResult = await executor.execute(abilityName, input, { dryRun: true });
      if (previewResult.success && ability) {
        preview = safetyController.formatPreviewResult(ability, input, previewResult);
      }
    } catch {
      // Preview failure is non-fatal - continue without preview data in audit
    }

    // Helper to build preview metadata for audit entries (spread-friendly)
    const previewMeta = preview
      ? { preview: { summary: preview.summary, affectedCount: preview.affected.length } }
      : {};

    // In non-interactive mode, require --force or fail
    if (!isInteractive() && !force) {
      await logDestructiveActionSafe({
        abilityName,
        ...previewMeta,
        userDecision: 'declined',
        input,
      });
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
        await logDestructiveActionSafe({
          abilityName,
          ...previewMeta,
          userDecision: 'declined',
          input,
        });
        this.log(formatWarning('Operation cancelled by user.'));
        return;
      }
    }

    // Execute with confirm
    const result = await executor.execute(abilityName, input, { confirm: true });

    // Build execution result for audit
    const executionResult: { success: boolean; error?: string } = {
      success: result.success,
    };
    if (result.error?.message) {
      executionResult.error = result.error.message;
    }

    // Log audit entry (fire-and-forget, covers both success and failure)
    await logDestructiveActionSafe({
      abilityName,
      ...previewMeta,
      userDecision: 'approved',
      execution: executionResult,
      input,
    });

    // Throw after audit logging if execution failed
    if (!result.success) {
      throw new APIError(
        result.error?.code ?? 'ABILITY_EXECUTION_ERROR',
        result.error?.message ?? 'Execution failed',
        undefined,
        result.error
      );
    }

    // Check for batch job
    if (result.jobId) {
      if (wait) {
        await this.waitForBatchJob(abilityName, result.jobId, waitTimeout ?? 300);
        return;
      }

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
   * Execute directly (read-only or non-destructive)
   */
  private async executeDirect(opts: {
    abilityName: string;
    input: Record<string, unknown>;
    wait?: boolean;
    waitTimeout?: number;
  }): Promise<void> {
    const { abilityName, input, wait, waitTimeout } = opts;
    const executor = await this.getExecutor();
    const result = await executor.execute(abilityName, input);

    if (!result.success) {
      throw new APIError(
        result.error?.code ?? 'ABILITY_EXECUTION_ERROR',
        result.error?.message ?? 'Execution failed',
        undefined,
        result.error
      );
    }

    // Check for batch job
    if (result.jobId) {
      if (wait) {
        // --wait: poll until job completes
        await this.waitForBatchJob(abilityName, result.jobId, waitTimeout ?? 300);
        return;
      }

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
   * Wait for a batch job to complete using BatchManager
   */
  private async waitForBatchJob(
    abilityName: string,
    jobId: string,
    timeoutSeconds: number
  ): Promise<void> {
    const batchManager = await this.getBatchManager();

    const watchResult: WatchResult = await batchManager.resumeJob(jobId, {
      maxWait: timeoutSeconds * 1000,
    });

    if (watchResult.timedOut) {
      // Output partial results and throw API error for exit code 4
      this.output(
        {
          mode: 'batch',
          ability: abilityName,
          jobId,
          timedOut: true,
          ...watchResult.status,
          elapsed_ms: watchResult.elapsed,
        },
        () => formatWarning(`Batch job ${jobId} timed out after ${timeoutSeconds}s (partial results returned)`)
      );
      throw new APIError(
        'BATCH_TIMEOUT',
        `Batch job timed out after ${timeoutSeconds}s`,
        undefined,
        { jobId, partialStatus: watchResult.status }
      );
    }

    // Job completed (or failed)
    const data = {
      mode: 'batch',
      ability: abilityName,
      jobId,
      timedOut: false,
      ...watchResult.status,
      elapsed_ms: watchResult.elapsed,
    };

    this.output(data, () => this.formatWatchResultOutput(abilityName, jobId, watchResult));
  }

  /**
   * Format watch result output for human display
   */
  private formatWatchResultOutput(
    abilityName: string,
    jobId: string,
    result: WatchResult
  ): string {
    const { status, elapsed } = result;
    const lines: string[] = [];

    if (status.status === 'completed') {
      lines.push(formatSuccess(`Batch job completed: ${abilityName}`));
    } else if (status.status === 'failed') {
      lines.push(formatWarning(`Batch job failed: ${abilityName}`));
    } else {
      lines.push(formatWarning(`Batch job ${status.status}: ${abilityName}`));
    }

    lines.push('');
    lines.push(formatKeyValue('Job ID', jobId));
    lines.push(formatKeyValue('Status', status.status));
    lines.push(formatKeyValue('Elapsed', `${Math.round(elapsed / 1000)}s`));

    if (status.processed !== undefined && status.total !== undefined) {
      lines.push(formatKeyValue('Processed', `${status.processed}/${status.total}`));
    }

    if (status.results && status.results.length > 0) {
      lines.push('');
      lines.push(`${status.results.length} items processed`);
    }

    if (status.errors && status.errors.length > 0) {
      lines.push('');
      for (const error of status.errors) {
        lines.push(formatWarning(`  ${error.message}`));
      }
    }

    return lines.join('\n');
  }

  /**
   * Resolve input from --input, --input-file, or stdin (--input -)
   */
  private async resolveInput(
    inputFlag: string,
    inputFilePath: string | undefined,
  ): Promise<string> {
    // --input-file takes priority when provided
    if (inputFilePath) {
      try {
        return await readFile(inputFilePath, 'utf-8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new InputError(`Input file not found: ${inputFilePath}`);
        }
        throw new InputError(
          `Failed to read input file: ${inputFilePath}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    // --input - means read from stdin
    if (inputFlag === '-') {
      const data = await this.readStdin();
      if (!data) {
        throw new InputError('No input received from stdin');
      }
      return data;
    }

    // Default: use --input value directly
    return inputFlag;
  }

  /**
   * Read all data from stdin
   */
  private async readStdin(): Promise<string> {
    if (process.stdin.isTTY) {
      return '';
    }
    return new Promise((resolve, reject) => {
      const chunks: string[] = [];
      process.stdin.setEncoding('utf-8');
      process.stdin.on('data', (chunk: string) => chunks.push(chunk));
      process.stdin.on('end', () => resolve(chunks.join('')));
      process.stdin.on('error', reject);
    });
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
