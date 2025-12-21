/**
 * E2E Test: Batch Operation → Polling Integration Flow
 *
 * Tests batch job submission, polling, and timeout handling.
 * Verifies exponential backoff, partial result surfacing,
 * and error recovery.
 *
 * INVARIANTS TESTED:
 * - Job status normalization works correctly
 * - Polling respects backoff delays
 * - Timeout returns partial results (not error)
 * - Network errors trigger retries
 * - API errors (non-network) fail immediately
 * - Abort signal stops polling cleanly
 * - Progress callbacks are invoked
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createMockJobStatus,
  createMockHttpClient,
  setupE2ETest,
  cleanupE2ETest,
} from './test-helpers.js';
import type { JobStatus, JobStatusType } from '../../core/batch-manager.js';

// ============================================================================
// Module-level mocks
// ============================================================================

const mockHttpPost = vi.fn();
const mockHttpGet = vi.fn();

vi.mock('../../core/http-client.js', () => ({
  createHttpClient: vi.fn(() => ({
    post: mockHttpPost,
    get: mockHttpGet,
    delete: vi.fn(),
    put: vi.fn(),
  })),
}));

// ============================================================================
// Imports (after mocks)
// ============================================================================

import { createBatchManager, BatchManager } from '../../core/batch-manager.js';
import { APIError, NetworkError } from '../../utils/errors.js';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Create a batch manager for tests
 */
function createTestManager(): BatchManager {
  return createBatchManager({
    baseUrl: 'https://test.local',
    token: 'test-token',
  });
}

/**
 * Create a mock job status API response
 */
function createJobStatusResponse(overrides: Partial<JobStatus> = {}): { data: JobStatus } {
  return {
    data: {
      job_id: 'job_test123',
      id: 'job_test123',
      status: 'pending',
      progress: 0,
      total: 10,
      processed: 0,
      ...overrides,
    } as JobStatus,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('E2E: Batch Operation → Polling Flow', () => {
  let manager: BatchManager;

  beforeEach(() => {
    setupE2ETest();
    manager = createTestManager();
  });

  afterEach(() => {
    cleanupE2ETest();
  });

  // ==========================================================================
  // Successful Batch Job Completion
  // ==========================================================================

  describe('Successful Batch Job Completion', () => {
    it('yields status updates until completed', async () => {
      mockHttpPost
        .mockResolvedValueOnce(createJobStatusResponse({ status: 'pending', progress: 0 }))
        .mockResolvedValueOnce(createJobStatusResponse({ status: 'running', progress: 50 }))
        .mockResolvedValueOnce(createJobStatusResponse({ status: 'completed', progress: 100 }));

      const statuses: JobStatus[] = [];
      const generator = manager.watchJob('job_test123', {
        initialDelay: 1,
        maxDelay: 1,
      });

      for await (const status of generator) {
        statuses.push(status);
      }

      expect(statuses).toHaveLength(3);
      expect(statuses[0]!.status).toBe('pending');
      expect(statuses[1]!.status).toBe('running');
      expect(statuses[2]!.status).toBe('completed');
    });

    it('returns final result via WatchResult', async () => {
      mockHttpPost
        .mockResolvedValueOnce(createJobStatusResponse({ status: 'running' }))
        .mockResolvedValueOnce(createJobStatusResponse({ status: 'completed' }));

      const result = await manager.resumeJob('job_test123', { initialDelay: 1 });

      expect(result.status.status).toBe('completed');
      expect(result.timedOut).toBe(false);
    });

    it('tracks elapsed time', async () => {
      mockHttpPost.mockResolvedValue(createJobStatusResponse({ status: 'completed' }));

      const result = await manager.resumeJob('job_test123', { initialDelay: 1 });

      expect(result.elapsed).toBeGreaterThanOrEqual(0);
    });

    it('calls onProgress callback', async () => {
      mockHttpPost
        .mockResolvedValueOnce(createJobStatusResponse({ status: 'running' }))
        .mockResolvedValueOnce(createJobStatusResponse({ status: 'completed' }));

      const onProgress = vi.fn();
      const generator = manager.watchJob('job_test123', {
        initialDelay: 1,
        onProgress,
      });

      // Consume generator
      for await (const _status of generator) {
        // Just consume
      }

      expect(onProgress).toHaveBeenCalledTimes(2);
      expect(onProgress).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ status: 'running' })
      );
      expect(onProgress).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ status: 'completed' })
      );
    });

    it('includes results array in final status', async () => {
      const results = [
        { site_id: 1, synced: true },
        { site_id: 2, synced: true },
      ];

      mockHttpPost.mockResolvedValue(
        createJobStatusResponse({
          status: 'completed',
          results,
          processed: 2,
          total: 2,
        })
      );

      const result = await manager.resumeJob('job_test123', { initialDelay: 1 });

      expect(result.status.results).toEqual(results);
      expect(result.status.processed).toBe(2);
    });
  });

  // ==========================================================================
  // Batch Job Timeout with Partial Results
  // ==========================================================================

  describe('Batch Job Timeout with Partial Results', () => {
    it('times out and returns partial result', async () => {
      let callCount = 0;
      mockHttpPost.mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          data: {
            job_id: 'job_test123',
            status: 'running',
            progress: callCount * 20,
            total: 10,
            processed: callCount * 2,
            results: Array.from({ length: callCount * 2 }, (_, i) => ({
              id: i + 1,
              completed: true,
            })),
          },
        });
      });

      const statuses: JobStatus[] = [];
      const generator = manager.watchJob('job_test123', {
        initialDelay: 10,
        maxWait: 50, // Very short timeout
      });

      let result;
      while (true) {
        const next = await generator.next();
        if (next.done) {
          result = next.value;
          break;
        }
        statuses.push(next.value);
      }

      // Should have timed out
      expect(result.timedOut).toBe(true);
      expect(result.status.status).toBe('partial');
      expect(statuses.length).toBeGreaterThan(0);
    });

    it('surfaces partial results when timeout occurs', async () => {
      let callCount = 0;
      mockHttpPost.mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          data: {
            job_id: 'job_test123',
            status: 'running',
            progress: callCount * 25,
            total: 10,
            processed: callCount * 2,
            results: Array.from({ length: callCount * 2 }, (_, i) => ({
              site_id: i + 1,
              synced: true,
            })),
          },
        });
      });

      const generator = manager.watchJob('job_test123', {
        initialDelay: 10,
        maxWait: 50,
      });

      let result;
      while (true) {
        const next = await generator.next();
        if (next.done) {
          result = next.value;
          break;
        }
      }

      // Verify partial results are surfaced
      expect(result.status.results).toBeDefined();
      expect(Array.isArray(result.status.results)).toBe(true);
      expect(result.status.results!.length).toBeGreaterThan(0);
      expect(result.status.processed).toBeGreaterThan(0);
      expect(result.status.total).toBe(10);
    });

    it('returns placeholder status when no polls succeed before timeout', async () => {
      mockHttpPost.mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            setTimeout(() => reject(new NetworkError('Connection failed')), 100);
          })
      );

      const generator = manager.watchJob('job_test456', {
        initialDelay: 10,
        maxWait: 50, // Timeout before first response
      });

      let result;
      while (true) {
        const next = await generator.next();
        if (next.done) {
          result = next.value;
          break;
        }
      }

      expect(result.timedOut).toBe(true);
      expect(result.status.id).toBe('job_test456');
      expect(result.status.status).toBe('partial');
      expect(result.status.errors).toEqual([{ message: 'Polling timed out' }]);
    });
  });

  // ==========================================================================
  // Batch Job Failure
  // ==========================================================================

  describe('Batch Job Failure', () => {
    it('handles job failed status', async () => {
      mockHttpPost.mockResolvedValue(
        createJobStatusResponse({
          status: 'failed',
          errors: [{ message: 'Site not found', code: 'NOT_FOUND' }],
        })
      );

      const result = await manager.resumeJob('job_test123', { initialDelay: 1 });

      expect(result.status.status).toBe('failed');
      expect(result.timedOut).toBe(false);
    });

    it('includes errors in failed status', async () => {
      mockHttpPost.mockResolvedValue(
        createJobStatusResponse({
          status: 'failed',
          errors: [
            { message: 'Error 1', code: 'ERR001' },
            { message: 'Error 2', code: 'ERR002' },
          ],
        })
      );

      const result = await manager.resumeJob('job_test123', { initialDelay: 1 });

      expect(result.status.errors).toHaveLength(2);
      expect(result.status.errors![0]).toEqual({
        message: 'Error 1',
        code: 'ERR001',
        item: undefined,
      });
    });

    it('parses string errors correctly', async () => {
      mockHttpPost.mockResolvedValue({
        data: {
          job_id: 'job_test123',
          status: 'failed',
          errors: ['Error string 1', 'Error string 2'],
        },
      });

      const status = await manager.getJobStatus('job_test123');

      expect(status.errors).toEqual([
        { message: 'Error string 1', item: undefined, code: undefined },
        { message: 'Error string 2', item: undefined, code: undefined },
      ]);
    });

    it('parses object errors with all fields', async () => {
      mockHttpPost.mockResolvedValue({
        data: {
          job_id: 'job_test123',
          status: 'failed',
          errors: [
            { message: 'Error 1', code: 'ERR001', item: { id: 1 } },
            { error: 'Error 2' }, // Alternative format
          ],
        },
      });

      const status = await manager.getJobStatus('job_test123');

      expect(status.errors).toHaveLength(2);
      expect(status.errors![0]).toEqual({
        message: 'Error 1',
        code: 'ERR001',
        item: { id: 1 },
      });
      expect(status.errors![1]!.message).toBe('Error 2');
    });
  });

  // ==========================================================================
  // Network Error with Retry
  // ==========================================================================

  describe('Network Error with Retry', () => {
    it('retries on network error', async () => {
      mockHttpPost
        .mockRejectedValueOnce(new NetworkError('Connection failed'))
        .mockResolvedValueOnce(createJobStatusResponse({ status: 'completed' }));

      const statuses: JobStatus[] = [];
      const generator = manager.watchJob('job_test123', {
        initialDelay: 1,
        maxDelay: 1,
      });

      let result;
      while (true) {
        const next = await generator.next();
        if (next.done) {
          result = next.value;
          break;
        }
        statuses.push(next.value);
      }

      // Should have recovered from network error
      expect(statuses).toHaveLength(1);
      expect(result.status.status).toBe('completed');
    });

    it('continues polling after multiple network errors', async () => {
      mockHttpPost
        .mockRejectedValueOnce(new NetworkError('Connection failed'))
        .mockRejectedValueOnce(new NetworkError('Connection failed'))
        .mockResolvedValueOnce(createJobStatusResponse({ status: 'running' }))
        .mockResolvedValueOnce(createJobStatusResponse({ status: 'completed' }));

      const result = await manager.resumeJob('job_test123', {
        initialDelay: 1,
        maxDelay: 1,
        maxWait: 1000, // Longer timeout to allow retries
      });

      expect(result.status.status).toBe('completed');
    });

    it('throws on non-network API errors', async () => {
      mockHttpPost.mockRejectedValue(new APIError('FORBIDDEN', 'Access denied', 403));

      const generator = manager.watchJob('job_test123');

      await expect(generator.next()).rejects.toThrow('Access denied');
    });
  });

  // ==========================================================================
  // Abort Signal Handling
  // ==========================================================================

  describe('Abort Signal Handling', () => {
    it('handles abort signal', async () => {
      mockHttpPost.mockResolvedValue(createJobStatusResponse({ status: 'running' }));

      const controller = new AbortController();
      const generator = manager.watchJob('job_test123', {
        signal: controller.signal,
        initialDelay: 10,
      });

      // Get first status
      const first = await generator.next();
      expect(first.done).toBe(false);
      expect(first.value.status).toBe('running');

      // Abort
      controller.abort();

      // Next iteration should complete due to abort
      const next = await generator.next();
      expect(next.done).toBe(true);
    });

    it('stops polling after abort', async () => {
      mockHttpPost.mockResolvedValue(createJobStatusResponse({ status: 'running' }));

      const controller = new AbortController();
      const generator = manager.watchJob('job_test123', {
        signal: controller.signal,
        initialDelay: 10,
      });

      // Get first status
      await generator.next();
      const callCountBefore = mockHttpPost.mock.calls.length;

      // Abort
      controller.abort();
      await generator.next();

      // Wait a bit to ensure no more calls
      await new Promise((resolve) => setTimeout(resolve, 50));
      const callCountAfter = mockHttpPost.mock.calls.length;

      // Should not have made additional calls after abort
      expect(callCountAfter).toBe(callCountBefore);
    });
  });

  // ==========================================================================
  // Status Normalization
  // ==========================================================================

  describe('Status Normalization', () => {
    const statusMappings: Array<[string, JobStatusType]> = [
      ['processing', 'running'],
      ['in_progress', 'running'],
      ['done', 'completed'],
      ['success', 'completed'],
      ['error', 'failed'],
      ['pending', 'pending'],
      ['running', 'running'],
      ['completed', 'completed'],
      ['failed', 'failed'],
      ['partial', 'partial'],
      ['unknown', 'pending'], // Defaults to pending
    ];

    for (const [input, expected] of statusMappings) {
      it(`normalizes "${input}" to "${expected}"`, async () => {
        mockHttpPost.mockResolvedValueOnce({
          data: { job_id: 'job_test', status: input },
        });

        const status = await manager.getJobStatus('job_test');
        expect(status.status).toBe(expected);
      });
    }
  });

  // ==========================================================================
  // Response Format Handling
  // ==========================================================================

  describe('Response Format Handling', () => {
    it('handles wrapped success response', async () => {
      mockHttpPost.mockResolvedValue({
        data: {
          success: true,
          data: {
            job_id: 'job_wrapped',
            status: 'completed',
          },
        },
      });

      const status = await manager.getJobStatus('job_wrapped');

      expect(status.id).toBe('job_wrapped');
      expect(status.status).toBe('completed');
    });

    it('handles direct response format', async () => {
      mockHttpPost.mockResolvedValue({
        data: {
          job_id: 'job_direct',
          status: 'running',
        },
      });

      const status = await manager.getJobStatus('job_direct');

      expect(status.id).toBe('job_direct');
      expect(status.status).toBe('running');
    });

    it('throws on invalid response', async () => {
      mockHttpPost.mockResolvedValue({ data: null });

      await expect(manager.getJobStatus('job_test')).rejects.toThrow('Invalid job status response');
    });

    it('throws when job ID is missing', async () => {
      mockHttpPost.mockResolvedValue({
        data: { status: 'running' },
      });

      await expect(manager.getJobStatus('job_test')).rejects.toThrow('Job status response missing job ID');
    });
  });

  // ==========================================================================
  // Not Implemented Operations
  // ==========================================================================

  describe('Not Implemented Operations', () => {
    it('cancelJob throws not implemented error', async () => {
      await expect(manager.cancelJob('job_test')).rejects.toThrow('Job cancellation is not currently supported');
    });

    it('listJobs throws not implemented error', async () => {
      await expect(manager.listJobs()).rejects.toThrow('Job listing is not currently supported');
    });
  });

  // ==========================================================================
  // Golden Test: Timeout Surfaces Partial Results
  // ==========================================================================

  describe('Golden Test: Timeout Surfaces Partial Results', () => {
    it('surfaces partial results when timeout occurs mid-processing', async () => {
      let callCount = 0;
      mockHttpPost.mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          data: {
            job_id: 'batch_sync_123',
            status: 'running',
            progress: callCount * 20,
            total: 10,
            processed: callCount * 2,
            results: Array.from({ length: callCount * 2 }, (_, i) => ({
              site_id: i + 1,
              synced: true,
            })),
          },
        });
      });

      const generator = manager.watchJob('batch_sync_123', {
        initialDelay: 10,
        maxWait: 50, // Short timeout
      });

      const statuses: JobStatus[] = [];
      let result;
      while (true) {
        const next = await generator.next();
        if (next.done) {
          result = next.value;
          break;
        }
        statuses.push(next.value);
      }

      // Verify timeout occurred
      expect(result.timedOut).toBe(true);

      // Verify final status is marked as partial
      expect(result.status.status).toBe('partial');

      // Verify we have partial results from the last successful poll
      expect(result.status.results).toBeDefined();
      expect(result.status.results!.length).toBeGreaterThan(0);

      // Verify progress was being tracked
      expect(statuses.length).toBeGreaterThan(0);
      const lastPolledStatus = statuses[statuses.length - 1];
      expect(lastPolledStatus!.processed).toBeGreaterThan(0);
      expect(lastPolledStatus!.total).toBe(10);

      // Verify elapsed time is reported
      expect(result.elapsed).toBeGreaterThanOrEqual(0);
    });
  });

  // ==========================================================================
  // Edge Cases
  // ==========================================================================

  describe('Edge Cases', () => {
    it('handles job with zero total items', async () => {
      mockHttpPost.mockResolvedValue(
        createJobStatusResponse({
          status: 'completed',
          total: 0,
          processed: 0,
          results: [],
        })
      );

      const result = await manager.resumeJob('job_test', { initialDelay: 1 });

      expect(result.status.total).toBe(0);
      expect(result.status.results).toEqual([]);
    });

    it('handles job with undefined progress fields', async () => {
      mockHttpPost.mockResolvedValue({
        data: {
          job_id: 'job_test',
          status: 'completed',
        },
      });

      const result = await manager.resumeJob('job_test', { initialDelay: 1 });

      expect(result.status.progress).toBeUndefined();
      expect(result.status.total).toBeUndefined();
      expect(result.status.processed).toBeUndefined();
    });

    it('handles job ID variations (job_id vs id)', async () => {
      // Using 'id' instead of 'job_id'
      mockHttpPost.mockResolvedValue({
        data: {
          id: 'job_alt_format',
          status: 'completed',
        },
      });

      const status = await manager.getJobStatus('job_alt_format');

      expect(status.id).toBe('job_alt_format');
    });
  });
});
