/**
 * Batch Manager for mainwpctl
 *
 * Handles batch operations with polling and resume capabilities.
 * Provides exponential backoff for job status polling.
 */

import { HttpClient, type HttpClientConfig, createHttpClient } from './http-client.js';
import { APIError, NetworkError } from '../utils/errors.js';
import { ExponentialBackoff } from '../utils/retry.js';

/**
 * Job status types
 */
export type JobStatusType = 'pending' | 'running' | 'completed' | 'failed' | 'partial';

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

/**
 * Batch Manager class
 */
export class BatchManager {
  private readonly httpClient: HttpClient;
  private readonly baseEndpoint = '/wp-json/wp-abilities/v1';

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
        const status = await this.getJobStatus(jobId, options.signal);
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
        id: jobId,
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
    const endpoint = `${this.baseEndpoint}/abilities/mainwp/get-batch-job-status-v1/run`;

    const response = await this.httpClient.post<JobStatusResponse>(
      endpoint,
      { job_id: jobId },
      signal ? { signal } : undefined
    );

    return this.normalizeJobStatus(response.data);
  }

  /**
   * Check if a status is terminal (job finished)
   */
  private isTerminalStatus(status: JobStatusType): boolean {
    return status === 'completed' || status === 'failed' || status === 'partial';
  }

  /**
   * Normalize API response to JobStatus
   */
  private normalizeJobStatus(data: unknown): JobStatus {
    // Handle the response format from get-batch-job-status-v1
    if (typeof data !== 'object' || data === null) {
      throw new APIError('INVALID_RESPONSE', 'Invalid job status response');
    }

    const response = data as Record<string, unknown>;

    // Check for success envelope
    if ('success' in response && 'data' in response) {
      const innerData = response['data'] as Record<string, unknown>;
      return this.extractJobStatus(innerData);
    }

    return this.extractJobStatus(response);
  }

  /**
   * Extract job status from response data
   */
  private extractJobStatus(data: Record<string, unknown>): JobStatus {
    const id = String(data['job_id'] ?? data['id'] ?? '');

    // Validate that we have a job ID
    if (!id) {
      throw new APIError('INVALID_RESPONSE', 'Job status response missing job ID');
    }

    const status: JobStatus = {
      id,
      status: this.parseJobStatus(data['status']),
      progress: typeof data['progress'] === 'number' ? data['progress'] : undefined,
      total: typeof data['total'] === 'number' ? data['total'] : undefined,
      processed: typeof data['processed'] === 'number' ? data['processed'] : undefined,
      results: Array.isArray(data['results']) ? data['results'] : undefined,
      errors: this.parseJobErrors(data['errors']),
      created_at: typeof data['created_at'] === 'string' ? data['created_at'] : undefined,
      completed_at: typeof data['completed_at'] === 'string' ? data['completed_at'] : undefined,
    };

    return status;
  }

  /**
   * Parse job status string
   */
  private parseJobStatus(value: unknown): JobStatusType {
    if (typeof value !== 'string') {
      return 'pending';
    }

    const status = value.toLowerCase();

    switch (status) {
      case 'pending':
      case 'running':
      case 'completed':
      case 'failed':
      case 'partial':
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
        return 'pending';
    }
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
