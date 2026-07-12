/**
 * Jobs watch command for mainwpcontrol
 *
 * Monitor batch job status with exponential backoff polling.
 * Streams progress updates until job completes or times out.
 */

import { Args, Flags } from '@oclif/core';
import { BaseCommand, commonFlags } from '../../lib/base-command.js';
import {
  formatSuccess,
  formatWarning,
  formatError as formatErrorText,
  formatHeading,
  formatKeyValue,
  formatProgressBar,
  formatElapsed,
} from '../../output/formatter.js';
import { safeString } from '../../utils/terminal-sanitizer.js';
import { APIError } from '../../utils/errors.js';
import { errorOutput } from '../../output/json-envelope.js';
import {
  type BatchManager,
  type JobStatus,
  type WatchResult,
} from '../../core/batch-manager.js';

/** Progress bar width in characters */
const PROGRESS_BAR_WIDTH = 30;

/** Terminal line width for padding */
const TERMINAL_LINE_WIDTH = 80;

/** Maximum number of result items to preview */
export const RESULTS_PREVIEW_LIMIT = 5;

/**
 * Check if a job status is terminal (job finished, no further polling)
 */
export function isTerminalStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'partial';
}

export default class JobsWatch extends BaseCommand {
  static description = 'Monitor batch job status';

  static examples = [
    // Basic watch
    '<%= config.bin %> jobs watch sync_abc123',

    // With timeout
    '<%= config.bin %> jobs watch sync_abc123 --timeout 120',

    // JSON output for scripting
    '<%= config.bin %> jobs watch sync_abc123 --json',

    // With custom poll interval
    '<%= config.bin %> jobs watch sync_abc123 --initial-delay 2000 --max-delay 60000',
  ];

  static flags = {
    ...commonFlags,
    timeout: Flags.integer({
      char: 't',
      description: 'Maximum wait time in seconds (default: 300)',
      default: 300,
    }),
    'initial-delay': Flags.integer({
      description: 'Initial poll delay in milliseconds',
      default: 1000,
    }),
    'max-delay': Flags.integer({
      description: 'Maximum poll delay in milliseconds',
      default: 30000,
    }),
    'no-progress': Flags.boolean({
      description: 'Disable progress output (only show final result)',
      default: false,
    }),
  };

  static args = {
    id: Args.string({
      description: 'Batch job ID',
      required: true,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(JobsWatch);
    await this.initCommon(flags);

    this.debugLog('Watching batch job', {
      jobId: args.id,
      timeoutSeconds: flags.timeout,
      initialDelayMs: flags['initial-delay'],
      maxDelayMs: flags['max-delay'],
    });

    // Initialize batch manager
    const manager = await this.getBatchManager();

    // Set up abort controller for graceful shutdown
    const controller = new AbortController();
    let signalExitCode: 130 | 143 | undefined;
    const handleSignal = (exitCode: 130 | 143) => {
      signalExitCode = exitCode;
      controller.abort();
      if (!this.jsonOutput && !flags['no-progress']) {
        this.log('\nAborted by user.');
      }
    };
    const handleSIGINT = () => handleSignal(130);
    const handleSIGTERM = () => handleSignal(143);

    process.on('SIGINT', handleSIGINT);
    process.on('SIGTERM', handleSIGTERM);

    try {
      // Watch the job
      const result = await this.watchJob(manager, args.id, {
        maxWait: flags.timeout * 1000,
        initialDelay: flags['initial-delay'],
        maxDelay: flags['max-delay'],
        showProgress: !flags['no-progress'] && !this.jsonOutput,
        signal: controller.signal,
      });

      if (signalExitCode !== undefined) {
        const error = new APIError(
          'CANCELLED',
          'Job watch cancelled by signal',
          undefined,
          { jobId: args.id }
        );
        if (this.jsonOutput) {
          this.log(JSON.stringify(errorOutput(error), null, 2));
        } else {
          this.logToStderr(formatErrorText(error.message));
        }
        this.exit(signalExitCode);
      }

      // Non-success outcomes: human mode prints result details before the
      // error; JSON mode must emit exactly ONE document, so only the error
      // envelope is printed (status travels in its details).
      const failedOutcome = result.timedOut
        ? new APIError(
            'BATCH_TIMEOUT',
            `Batch job ${args.id} timed out`,
            undefined,
            { jobId: args.id, partialStatus: result.status }
          )
        : result.status.status === 'failed' || result.status.status === 'partial'
          ? new APIError(
              result.status.status === 'failed' ? 'BATCH_FAILED' : 'BATCH_PARTIAL',
              `Batch job ${args.id} finished with status "${result.status.status}"`,
              undefined,
              { jobId: args.id, status: result.status }
            )
          : undefined;

      if (failedOutcome) {
        if (!this.jsonOutput) {
          this.outputResult(args.id, result);
        }
        throw failedOutcome;
      }

      // Output final result
      this.outputResult(args.id, result);
    } finally {
      process.off('SIGINT', handleSIGINT);
      process.off('SIGTERM', handleSIGTERM);
    }
  }

  /**
   * Watch job with progress updates
   */
  private async watchJob(
    manager: BatchManager,
    jobId: string,
    options: {
      maxWait: number;
      initialDelay: number;
      maxDelay: number;
      showProgress: boolean;
      signal: AbortSignal;
    }
  ): Promise<WatchResult> {
    if (options.showProgress) {
      this.log(formatHeading(`Watching job: ${jobId}`));
      this.log('');
    }

    const generator = manager.watchJob(jobId, {
      maxWait: options.maxWait,
      initialDelay: options.initialDelay,
      maxDelay: options.maxDelay,
      signal: options.signal,
    });

    let lastStatus: JobStatus | undefined;

    // Process status updates
    while (true) {
      const result = await generator.next();

      if (result.done) {
        return result.value;
      }

      lastStatus = result.value;

      if (options.showProgress) {
        this.displayProgress(lastStatus);
      }
    }
  }

  /**
   * Display progress update
   */
  private displayProgress(status: JobStatus): void {
    // Clear previous line(s) and write new status
    // Use simple output that works in all terminals
    const progress = status.progress ?? this.calculateProgress(status);
    const progressBar = formatProgressBar(progress, PROGRESS_BAR_WIDTH);

    const parts = [
      `Status: ${this.formatStatusText(status.status)}`,
      progressBar,
    ];

    if (status.processed !== undefined && status.total !== undefined) {
      parts.push(`(${status.processed}/${status.total})`);
    }

    if (status.errors && status.errors.length > 0) {
      parts.push(formatWarning(`${status.errors.length} errors`));
    }

    // Write progress (overwrite line on TTY, newline otherwise)
    if (process.stdout.isTTY) {
      process.stdout.write(`\r${parts.join(' ')}`.padEnd(TERMINAL_LINE_WIDTH));
    } else {
      this.log(parts.join(' '));
    }
  }

  /**
   * Calculate progress percentage from processed/total
   */
  private calculateProgress(status: JobStatus): number {
    if (status.processed !== undefined && status.total !== undefined && status.total > 0) {
      return Math.round((status.processed / status.total) * 100);
    }

    if (status.status === 'completed') {
      return 100;
    }

    if (isTerminalStatus(status.status)) {
      // failed or partial
      return status.progress ?? 0;
    }

    // Estimate based on non-terminal status
    return status.status === 'running' ? 50 : 0;
  }

  /**
   * Format status text with color
   */
  private formatStatusText(status: string): string {
    switch (status) {
      case 'completed':
        return formatSuccess(status);
      case 'failed':
        return formatErrorText(status);
      case 'partial':
        return formatWarning(status);
      case 'running':
        return `${status}...`;
      default:
        return status;
    }
  }

  /**
   * Output final result
   */
  private outputResult(jobId: string, result: WatchResult): void {
    // Clear progress line on TTY
    if (process.stdout.isTTY && !this.jsonOutput) {
      process.stdout.write('\r'.padEnd(TERMINAL_LINE_WIDTH) + '\r');
    }

    const data = {
      job_id: jobId,
      ...result.status,
      timedOut: result.timedOut,
      elapsed_ms: result.elapsed,
    };

    this.output(data, () => this.formatHumanOutput(jobId, result));
  }

  /**
   * Format human-readable output
   */
  private formatHumanOutput(jobId: string, result: WatchResult): string {
    const lines: string[] = [];
    const { status, timedOut, elapsed } = result;

    // Header
    if (timedOut) {
      lines.push(formatWarning(`Job ${jobId} timed out after ${formatElapsed(elapsed)}`));
    } else if (!isTerminalStatus(status.status)) {
      lines.push(`Job ${jobId}: ${status.status}`);
    } else if (status.status === 'completed') {
      lines.push(formatSuccess(`Job ${jobId} completed`));
    } else if (status.status === 'failed') {
      lines.push(formatErrorText(`Job ${jobId} failed`));
    } else {
      lines.push(formatWarning(`Job ${jobId} partially completed`));
    }

    lines.push('');

    // Status details
    lines.push(formatKeyValue('Status', status.status));

    if (status.progress !== undefined) {
      lines.push(formatKeyValue('Progress', `${status.progress}%`));
    }

    if (status.processed !== undefined && status.total !== undefined) {
      lines.push(formatKeyValue('Processed', `${status.processed}/${status.total}`));
    }

    lines.push(formatKeyValue('Elapsed', formatElapsed(elapsed)));

    // Results summary
    if (status.results && status.results.length > 0) {
      lines.push('');
      lines.push(formatHeading('Results:'));
      lines.push(`  ${status.results.length} items processed`);

      // Show first few results
      const preview = status.results.slice(0, RESULTS_PREVIEW_LIMIT);
      for (const item of preview) {
        if (typeof item === 'object' && item !== null) {
          const obj = item as Record<string, unknown>;
          const label = safeString(obj['name'] ?? obj['url'] ?? obj['id'] ?? JSON.stringify(obj));
          lines.push(`  - ${label}`);
        } else {
          lines.push(`  - ${safeString(item)}`);
        }
      }

      if (status.results.length > RESULTS_PREVIEW_LIMIT) {
        lines.push(`  ... and ${status.results.length - RESULTS_PREVIEW_LIMIT} more`);
      }
    }

    // Errors
    if (status.errors && status.errors.length > 0) {
      lines.push('');
      lines.push(formatHeading('Errors:'));

      for (const error of status.errors) {
        const prefix = error.code ? `[${safeString(error.code)}] ` : '';
        lines.push(formatWarning(`  ${prefix}${safeString(error.message)}`));
        if (error.item) {
          lines.push(`    Item: ${safeString(JSON.stringify(error.item))}`);
        }
      }
    }

    return lines.join('\n');
  }
}
