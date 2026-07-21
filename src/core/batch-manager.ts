/**
 * Batch Manager for mainwpcontrol
 *
 * Handles batch operations with polling and resume capabilities.
 * Provides exponential backoff for job status polling.
 */

import { HttpClient, type HttpClientConfig, createHttpClient } from './http-client.js';
import { APIError, NetworkError } from '../utils/errors.js';
import { ExponentialBackoff } from '../utils/retry.js';
import { validateJobId } from './job-id.js';

/**
 * Job status types
 */
export type JobStatusType = 'pending' | 'running' | 'completed' | 'failed' | 'partial' | 'cancelled';

/**
 * Job status response from API
 */
export interface JobStatus {
  /** Job identifier */
  id: string;
  /** Current job status */
  status: JobStatusType;
  /** Progress percentage (0-100) */
  progress?: number | undefined;
  /** Total items to process */
  total?: number | undefined;
  /** Items processed so far */
  processed?: number | undefined;
  /** Partial or complete results */
  results?: unknown[] | undefined;
  /** Errors encountered */
  errors?: Array<{
    item?: unknown | undefined;
    message: string;
    code?: string | undefined;
  }> | undefined;
  /** Job creation timestamp */
  created_at?: string | undefined;
  /** Job completion timestamp */
  completed_at?: string | undefined;
}

/**
 * Watch options for job polling
 */
export interface WatchOptions {
  /** Maximum total wait time in milliseconds (default: 5 minutes) */
  maxWait?: number | undefined;
  /** Initial poll delay in milliseconds (default: 1000) */
  initialDelay?: number | undefined;
  /** Maximum poll delay in milliseconds (default: 30000) */
  maxDelay?: number | undefined;
  /** Delay multiplier for backoff (default: 2) */
  multiplier?: number | undefined;
  /** Optional abort signal */
  signal?: AbortSignal | undefined;
  /** Callback for progress updates */
  onProgress?: ((status: JobStatus) => void) | undefined;
}

/**
 * Watch result
 */
export interface WatchResult {
  /** Final job status */
  status: JobStatus;
  /** Whether the operation timed out */
  timedOut: boolean;
  /** Total time spent waiting in milliseconds */
  elapsed: number;
}

/**
 * Default configuration
 */
const DEFAULTS = {
  maxWait: 5 * 60 * 1000, // 5 minutes
  initialDelay: 1000,     // 1 second
  maxDelay: 30000,        // 30 seconds
  multiplier: 2,
};

const MAX_STATUS_ARRAY_LENGTH = 10_000;

/**
 * Batch Manager class
 */
export class BatchManager {
  private readonly httpClient: HttpClient;
  private readonly baseEndpoint = '/wp-json/wp-abilities/v1';
  private readonly terminalJobs = new Set<string>();

  constructor(config: HttpClientConfig) {
    this.httpClient = createHttpClient(config);
  }

  /**
   * Watch a batch job status with exponential backoff polling
   *
   * Yields status updates as they're received.
   * Completes when job finishes or times out.
   */
  async *watchJob(
    jobId: string,
    options: WatchOptions = {}
  ): AsyncGenerator<JobStatus, WatchResult> {
    // Validate up front: a timeout/abort before the first poll builds a
    // placeholder status from this ID, which must never carry a raw value.
    const validatedJobId = validateJobId(jobId);
    const maxWait = options.maxWait ?? DEFAULTS.maxWait;
    const startTime = Date.now();

    const backoff = new ExponentialBackoff({
      initialDelay: options.initialDelay ?? DEFAULTS.initialDelay,
      maxDelay: options.maxDelay ?? DEFAULTS.maxDelay,
      multiplier: options.multiplier ?? DEFAULTS.multiplier,
      signal: options.signal,
    });

    let lastStatus: JobStatus | undefined;
    let timedOut = false;

    while (true) {
      // Check timeout
      const elapsed = Date.now() - startTime;
      if (elapsed >= maxWait) {
        timedOut = true;
        break;
      }

      // Check abort
      if (options.signal?.aborted) {
        break;
      }

      // Fetch current status
      try {
        const status = await this.getJobStatus(validatedJobId, options.signal);
        lastStatus = status;

        // Yield the status update
        yield status;

        // Call progress callback if provided
        if (options.onProgress) {
          options.onProgress(status);
        }

        // Check if job is complete
        if (this.isTerminalStatus(status.status)) {
          break;
        }

        // Wait before next poll
        try {
          const shouldContinue = await backoff.wait();
          if (!shouldContinue) {
            // Max retries exceeded or already aborted
            break;
          }
        } catch {
          // Aborted during wait
          break;
        }
      } catch (error) {
        // For network errors, continue polling
        if (error instanceof NetworkError) {
          try {
            const shouldContinue = await backoff.wait();
            if (!shouldContinue) {
              break;
            }
          } catch {
            break;
          }
          continue;
        }

        // For other errors, throw
        throw error;
      }
    }

    const elapsed = Date.now() - startTime;

    // If we don't have a status, create a placeholder
    if (!lastStatus) {
      lastStatus = {
        id: validatedJobId,
        status: timedOut ? 'partial' : 'failed',
        errors: [{ message: timedOut ? 'Polling timed out' : 'Polling aborted' }],
      };
    } else if (timedOut && !this.isTerminalStatus(lastStatus.status)) {
      // Mark as partial if timed out while still running
      lastStatus = {
        ...lastStatus,
        status: 'partial',
      };
    }

    return {
      status: lastStatus,
      timedOut,
      elapsed,
    };
  }

  /**
   * Resume watching a batch job
   *
   * This is a convenience method that wraps watchJob for resuming
   * a previously started job by its ID.
   */
  async resumeJob(jobId: string, options?: WatchOptions): Promise<WatchResult> {
    const generator = this.watchJob(jobId, options);

    // Consume the generator
    while (true) {
      const result = await generator.next();

      if (result.done) {
        return result.value;
      }
      // Status updates are handled via the generator, we just continue
    }
  }

  /**
   * Get the current status of a batch job
   */
  async getJobStatus(jobId: string, signal?: AbortSignal): Promise<JobStatus> {
    const validatedJobId = validateJobId(jobId);
    const endpoint = `${this.baseEndpoint}/abilities/mainwp/get-batch-job-status-v1/run`;

    const qs = `input[job_id]=${encodeURIComponent(validatedJobId)}`;
    const response = await this.httpClient.get<JobStatusResponse>(
      `${endpoint}?${qs}`,
      signal ? { signal } : undefined
    );

    const status = this.normalizeJobStatus(response.data, validatedJobId);
    if (this.terminalJobs.has(validatedJobId) && !this.isServerTerminalStatus(status.status)) {
      throw new APIError(
        'INVALID_RESPONSE',
        'Job status regressed from a terminal state'
      );
    }
    if (this.isServerTerminalStatus(status.status)) {
      this.terminalJobs.add(validatedJobId);
    }
    return status;
  }

  /**
   * Check if a status is terminal (job finished)
   */
  private isTerminalStatus(status: JobStatusType): boolean {
    return status === 'completed' || status === 'failed' ||
      status === 'partial' || status === 'cancelled';
  }

  private isServerTerminalStatus(status: JobStatusType): boolean {
    return status === 'completed' || status === 'failed' || status === 'cancelled';
  }

  /**
   * Normalize API response to JobStatus, unwrapping success envelope if present
   */
  private normalizeJobStatus(data: unknown, requestedJobId: string): JobStatus {
    if (typeof data !== 'object' || data === null) {
      throw new APIError('INVALID_RESPONSE', 'Invalid job status response');
    }

    const response = data as Record<string, unknown>;

    // Unwrap success envelope if present
    let fields = response;
    if ('success' in response && 'data' in response) {
      const inner = response['data'];
      if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) {
        throw new APIError('INVALID_RESPONSE', 'Invalid job status data in success envelope');
      }
      fields = inner as Record<string, unknown>;
    }

    const rawId = fields['job_id'] ?? fields['id'];
    if (rawId === undefined) {
      throw new APIError('INVALID_RESPONSE', 'Job status response missing job ID');
    }
    const responseJobId = validateJobId(rawId);
    if (responseJobId !== requestedJobId) {
      throw new APIError(
        'INVALID_RESPONSE',
        `Job status response ID mismatch for requested job ${requestedJobId}`
      );
    }

    const progress = this.parseStatusNumber(fields, 'progress', 100);
    const total = this.parseStatusNumber(fields, 'total');
    const processed = this.parseStatusNumber(fields, 'processed');
    if (processed !== undefined && total !== undefined && processed > total) {
      throw new APIError('INVALID_RESPONSE', 'Job status processed count exceeds total');
    }

    const results = this.parseStatusArray(fields, 'results');
    const rawErrors = this.parseStatusArray(fields, 'errors');

    return {
      id: responseJobId,
      status: this.parseJobStatus(fields['status']),
      progress,
      total,
      processed,
      results,
      errors: this.parseJobErrors(rawErrors),
      created_at: typeof fields['created_at'] === 'string' ? fields['created_at'] : undefined,
      completed_at: typeof fields['completed_at'] === 'string' ? fields['completed_at'] : undefined,
    };
  }

  /**
   * Parse job status string
   */
  private parseJobStatus(value: unknown): JobStatusType {
    if (typeof value !== 'string') {
      throw new APIError('INVALID_RESPONSE', 'Job status response has an invalid status');
    }

    const status = value.toLowerCase();

    switch (status) {
      case 'pending':
      case 'running':
      case 'completed':
      case 'failed':
      case 'partial':
      case 'cancelled':
        return status;
      case 'processing':
      case 'in_progress':
        return 'running';
      case 'done':
      case 'success':
        return 'completed';
      case 'error':
        return 'failed';
      default:
        throw new APIError('INVALID_RESPONSE', 'Job status response has an unknown status');
    }
  }

  private parseStatusNumber(
    fields: Record<string, unknown>,
    key: 'progress' | 'total' | 'processed',
    maximum?: number
  ): number | undefined {
    const value = fields[key];
    if (value === undefined) return undefined;
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < 0 ||
      (maximum !== undefined && value > maximum)
    ) {
      throw new APIError('INVALID_RESPONSE', `Job status ${key} is invalid`);
    }
    return value;
  }

  private parseStatusArray(
    fields: Record<string, unknown>,
    key: 'results' | 'errors'
  ): unknown[] | undefined {
    const value = fields[key];
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) {
      throw new APIError('INVALID_RESPONSE', `Job status ${key} is not an array`);
    }
    if (value.length > MAX_STATUS_ARRAY_LENGTH) {
      throw new APIError(
        'INVALID_RESPONSE',
        `Job status ${key} exceeds the ${MAX_STATUS_ARRAY_LENGTH}-item limit`
      );
    }
    return value;
  }

  /**
   * Parse job errors
   */
  private parseJobErrors(
    value: unknown
  ): Array<{ item?: unknown | undefined; message: string; code?: string | undefined }> | undefined {
    if (!Array.isArray(value)) {
      return undefined;
    }

    return value.map((error): { item?: unknown | undefined; message: string; code?: string | undefined } => {
      if (typeof error === 'string') {
        return { message: error, item: undefined, code: undefined };
      }

      if (typeof error === 'object' && error !== null) {
        const e = error as Record<string, unknown>;
        return {
          item: e['item'],
          message: String(e['message'] ?? e['error'] ?? 'Unknown error'),
          code: typeof e['code'] === 'string' ? e['code'] : undefined,
        };
      }

      return { message: String(error), item: undefined, code: undefined };
    });
  }
}

/**
 * Job status API response type
 */
interface JobStatusResponse {
  success?: boolean;
  data?: Record<string, unknown>;
  job_id?: string;
  id?: string;
  status?: string;
  progress?: number;
  total?: number;
  processed?: number;
  results?: unknown[];
  errors?: unknown[];
  created_at?: string;
  completed_at?: string;
}

/**
 * Create a batch manager from configuration
 */
export function createBatchManager(config: HttpClientConfig): BatchManager {
  return new BatchManager(config);
}
