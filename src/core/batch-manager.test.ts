/**
 * Tests for BatchManager
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BatchManager, createBatchManager, type JobStatus } from './batch-manager.js';
import { APIError, NetworkError } from '../utils/errors.js';

// Mock the http-client module
vi.mock('./http-client.js', () => ({
  createHttpClient: vi.fn(() => ({
    post: vi.fn(),
  })),
}));

import { createHttpClient } from './http-client.js';

describe('BatchManager', () => {
  let manager: BatchManager;
  let mockGet: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockGet = vi.fn();
    vi.mocked(createHttpClient).mockReturnValue({
      post: vi.fn(),
      get: mockGet,
      put: vi.fn(),
      delete: vi.fn(),
    } as never);

    manager = createBatchManager({
      baseUrl: 'https://test.local',
      token: 'test-token',
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('getJobStatus', () => {
    it('fetches and normalizes job status', async () => {
      mockGet.mockResolvedValue({
        data: {
          job_id: 'job_123',
          status: 'running',
          progress: 50,
          total: 100,
          processed: 50,
        },
      });

      const status = await manager.getJobStatus('job_123');

      expect(status).toEqual({
        id: 'job_123',
        status: 'running',
        progress: 50,
        total: 100,
        processed: 50,
        results: undefined,
        errors: undefined,
        created_at: undefined,
        completed_at: undefined,
      });
    });

    it('handles wrapped success response', async () => {
      mockGet.mockResolvedValue({
        data: {
          success: true,
          data: {
            job_id: 'job_456',
            status: 'completed',
          },
        },
      });

      const status = await manager.getJobStatus('job_456');
      expect(status.id).toBe('job_456');
      expect(status.status).toBe('completed');
    });

    it('normalizes various status strings', async () => {
      const statusMappings: Array<[string, string]> = [
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
        ['cancelled', 'cancelled'],
      ];

      for (const [input, expected] of statusMappings) {
        const jobId = `job_${input}`;
        mockGet.mockResolvedValueOnce({
          data: { job_id: jobId, status: input },
        });

        const status = await manager.getJobStatus(jobId);
        expect(status.status).toBe(expected);
      }
    });

    it('rejects unknown or missing status values', async () => {
      mockGet
        .mockResolvedValueOnce({ data: { job_id: 'job', status: 'mystery' } })
        .mockResolvedValueOnce({ data: { job_id: 'job' } });

      await expect(manager.getJobStatus('job')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
      await expect(manager.getJobStatus('job')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    });

    it('rejects a response for a different job id', async () => {
      mockGet.mockResolvedValue({
        data: { job_id: 'job_other', status: 'running' },
      });

      await expect(manager.getJobStatus('job_expected')).rejects.toMatchObject({
        code: 'INVALID_RESPONSE',
      });
    });

    it('rejects unsafe requested and response job ids', async () => {
      await expect(manager.getJobStatus('bad\njob')).rejects.toMatchObject({
        code: 'INVALID_RESPONSE',
      });
      expect(mockGet).not.toHaveBeenCalled();

      mockGet.mockResolvedValue({
        data: { job_id: 'bad\njob', status: 'running' },
      });
      await expect(manager.getJobStatus('job')).rejects.toMatchObject({
        code: 'INVALID_RESPONSE',
      });
    });

    it.each([
      ['negative progress', { progress: -1 }],
      ['progress above 100', { progress: 101 }],
      ['non-finite progress', { progress: Number.NaN }],
      ['negative total', { total: -1 }],
      ['negative processed', { processed: -1 }],
      ['processed above total', { processed: 2, total: 1 }],
    ])('rejects invalid numeric status data: %s', async (_label, fields) => {
      mockGet.mockResolvedValue({
        data: { job_id: 'job', status: 'running', ...fields },
      });

      await expect(manager.getJobStatus('job')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    });

    it.each(['results', 'errors'])('rejects oversized %s arrays', async (field) => {
      mockGet.mockResolvedValue({
        data: {
          job_id: 'job',
          status: 'running',
          [field]: Array.from({ length: 10_001 }, () => null),
        },
      });

      await expect(manager.getJobStatus('job')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    });

    it.each(['results', 'errors'])('rejects non-array %s fields', async (field) => {
      mockGet.mockResolvedValue({
        data: {
          job_id: 'job',
          status: 'running',
          [field]: 'invalid',
        },
      });

      await expect(manager.getJobStatus('job')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    });

    it('rejects regression after a terminal status was observed', async () => {
      mockGet
        .mockResolvedValueOnce({ data: { job_id: 'job', status: 'completed' } })
        .mockResolvedValueOnce({ data: { job_id: 'job', status: 'running' } });

      await expect(manager.getJobStatus('job')).resolves.toMatchObject({ status: 'completed' });
      await expect(manager.getJobStatus('job')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    });

    it('throws on invalid response', async () => {
      mockGet.mockResolvedValue({ data: null });

      await expect(manager.getJobStatus('job')).rejects.toThrow('Invalid job status response');
    });

    it('throws when job ID is missing', async () => {
      mockGet.mockResolvedValue({
        data: { status: 'running' },
      });

      await expect(manager.getJobStatus('job')).rejects.toThrow('Job status response missing job ID');
    });
  });

  describe('watchJob', () => {
    it('rejects an invalid job ID before polling or building a placeholder', async () => {
      const generator = manager.watchJob('job\x1b[2Jmalicious');

      await expect(generator.next()).rejects.toMatchObject({
        code: 'INVALID_RESPONSE',
      });
      expect(mockGet).not.toHaveBeenCalled();
    });

    it('yields status updates until completed', async () => {
      mockGet
        .mockResolvedValueOnce({
          data: { job_id: 'job_123', status: 'pending', progress: 0 },
        })
        .mockResolvedValueOnce({
          data: { job_id: 'job_123', status: 'running', progress: 50 },
        })
        .mockResolvedValueOnce({
          data: { job_id: 'job_123', status: 'completed', progress: 100 },
        });

      const statuses: JobStatus[] = [];
      const generator = manager.watchJob('job_123', {
        initialDelay: 1, // Very short delay for testing
        maxDelay: 1,
      });

      for await (const status of generator) {
        statuses.push(status);
      }

      // Note: The return value isn't captured with for-await
      expect(statuses).toHaveLength(3);
      expect(statuses[0]!.status).toBe('pending');
      expect(statuses[1]!.status).toBe('running');
      expect(statuses[2]!.status).toBe('completed');
    });

    it('times out and returns partial result', async () => {
      // Simulate a job that accumulates partial results over multiple polls
      // but never completes before the timeout expires
      let callCount = 0;
      mockGet.mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          data: {
            job_id: 'job_123',
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
      const generator = manager.watchJob('job_123', {
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

      // Verify partial results are properly surfaced
      expect(result.status.results).toBeDefined();
      expect(Array.isArray(result.status.results)).toBe(true);
      expect(result.status.results!.length).toBeGreaterThan(0);
      expect(result.status.processed).toBeGreaterThan(0);
      expect(result.status.total).toBe(10);
      expect(result.status.results![0]).toHaveProperty('id');
    });

    it('handles abort signal', async () => {
      mockGet.mockResolvedValue({
        data: { job_id: 'job_123', status: 'running' },
      });

      const controller = new AbortController();
      const generator = manager.watchJob('job_123', {
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
      // After abort, it may either throw or return done
      expect(next.done).toBe(true);
    });

    it('retries on network error', async () => {
      mockGet
        .mockRejectedValueOnce(new NetworkError('Connection failed'))
        .mockResolvedValueOnce({
          data: { job_id: 'job_123', status: 'completed' },
        });

      const statuses: JobStatus[] = [];
      const generator = manager.watchJob('job_123', {
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

    it('throws on non-network API errors', async () => {
      mockGet.mockRejectedValue(new APIError('FORBIDDEN', 'Access denied', 403));

      const generator = manager.watchJob('job_123');

      await expect(generator.next()).rejects.toThrow('Access denied');
    });

    it('calls onProgress callback', async () => {
      mockGet
        .mockResolvedValueOnce({
          data: { job_id: 'job_123', status: 'running' },
        })
        .mockResolvedValueOnce({
          data: { job_id: 'job_123', status: 'completed' },
        });

      const onProgress = vi.fn();
      const generator = manager.watchJob('job_123', {
        initialDelay: 1,
        onProgress,
      });

      // Consume generator
      for await (const _status of generator) {
        // Just consume
      }

      expect(onProgress).toHaveBeenCalledTimes(2);
      expect(onProgress).toHaveBeenNthCalledWith(1, expect.objectContaining({ status: 'running' }));
      expect(onProgress).toHaveBeenNthCalledWith(2, expect.objectContaining({ status: 'completed' }));
    });
  });

  describe('resumeJob', () => {
    it('returns final result after watching completes', async () => {
      mockGet
        .mockResolvedValueOnce({
          data: { job_id: 'job_123', status: 'running' },
        })
        .mockResolvedValueOnce({
          data: { job_id: 'job_123', status: 'completed' },
        });

      const result = await manager.resumeJob('job_123', { initialDelay: 1 });

      expect(result.status.status).toBe('completed');
      expect(result.timedOut).toBe(false);
    });
  });

  describe('error parsing', () => {
    it('parses string errors', async () => {
      mockGet.mockResolvedValue({
        data: {
          job_id: 'job_123',
          status: 'failed',
          errors: ['Error 1', 'Error 2'],
        },
      });

      const status = await manager.getJobStatus('job_123');

      expect(status.errors).toEqual([
        { message: 'Error 1', item: undefined, code: undefined },
        { message: 'Error 2', item: undefined, code: undefined },
      ]);
    });

    it('parses object errors', async () => {
      mockGet.mockResolvedValue({
        data: {
          job_id: 'job_123',
          status: 'failed',
          errors: [
            { message: 'Error 1', code: 'ERR001', item: { id: 1 } },
            { error: 'Error 2' }, // Alternative format
          ],
        },
      });

      const status = await manager.getJobStatus('job_123');

      expect(status.errors).toHaveLength(2);
      expect(status.errors![0]).toEqual({
        message: 'Error 1',
        code: 'ERR001',
        item: { id: 1 },
      });
      expect(status.errors![1]!.message).toBe('Error 2');
    });
  });
});

describe('Timeout with partial results (Golden Test)', () => {
  let manager: BatchManager;
  let mockGet: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockGet = vi.fn();
    vi.mocked(createHttpClient).mockReturnValue({
      post: vi.fn(),
      get: mockGet,
      put: vi.fn(),
      delete: vi.fn(),
    } as never);

    manager = createBatchManager({
      baseUrl: 'https://test.local',
      token: 'test-token',
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('surfaces partial results when timeout occurs mid-processing', async () => {
    // Simulate a job that returns partial results over time
    let callCount = 0;
    mockGet.mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        data: {
          job_id: 'batch_sync_123',
          status: 'running',
          progress: callCount * 20, // 20%, 40%, 60%...
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

  it('returns placeholder status when no polls succeed before timeout', async () => {
    // Network error on all attempts - but timeout first
    mockGet.mockImplementation(
      () =>
        new Promise((_, reject) => {
          // Delay rejection to simulate network delay
          setTimeout(() => reject(new NetworkError('Connection failed')), 100);
        })
    );

    const generator = manager.watchJob('batch_sync_456', {
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
    expect(result.status.id).toBe('batch_sync_456');
    expect(result.status.status).toBe('partial');
    expect(result.status.errors).toEqual([{ message: 'Polling timed out' }]);
  });
});
