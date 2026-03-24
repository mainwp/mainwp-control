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
const RESULTS_PREVIEW_LIMIT = 5;

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
    const handleSignal = () => {
      controller.abort();
      if (!flags.json && !flags['no-progress']) {
        this.log('\nAborted by user.');
      }
    };

    process.on('SIGINT', handleSignal);
    process.on('SIGTERM', handleSignal);

    try {
      // Watch the job
      const result = await this.watchJob(manager, args.id, {
        maxWait: flags.timeout * 1000,
        initialDelay: flags['initial-delay'],
        maxDelay: flags['max-delay'],
        showProgress: !flags['no-progress'] && !flags.json,
        signal: controller.signal,
      });

      // Output final result
      this.outputResult(args.id, result);
    } finally {
      process.off('SIGINT', handleSignal);
      process.off('SIGTERM', handleSignal);
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

    // Estimate based on status
    switch (status.status) {
      case 'pending':
        return 0;
      case 'running':
        return 50;
      case 'completed':
        return 100;
      case 'failed':
      case 'partial':
        return status.progress ?? 0;
      default:
        return 0;
    }
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
    } else if (status.status === 'completed') {
      lines.push(formatSuccess(`Job ${jobId} completed`));
    } else if (status.status === 'failed') {
      lines.push(formatErrorText(`Job ${jobId} failed`));
    } else if (status.status === 'partial') {
      lines.push(formatWarning(`Job ${jobId} partially completed`));
    } else {
      lines.push(`Job ${jobId}: ${status.status}`);
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
