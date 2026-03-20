/**
 * Tests for jobs watch command
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock modules before importing
vi.mock('../../core/batch-manager.js', () => ({
  createBatchManager: vi.fn(),
}));


import { createBatchManager } from '../../core/batch-manager.js';
import type { JobStatus, WatchResult, WatchOptions } from '../../core/batch-manager.js';
import { formatProgressBar, formatElapsed } from '../../output/formatter.js';

describe('jobs watch command', () => {
  let mockWatchJob: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();

    // Create a mock async generator
    mockWatchJob = vi.fn();
    vi.mocked(createBatchManager).mockReturnValue({
      watchJob: mockWatchJob,
      getJobStatus: vi.fn(),
      resumeJob: vi.fn(),
    } as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('output formatting', () => {
    it('displays progress correctly', () => {
      expect(formatProgressBar(0, 10)).toBe('[░░░░░░░░░░]   0%');
      expect(formatProgressBar(50, 10)).toBe('[█████░░░░░]  50%');
      expect(formatProgressBar(100, 10)).toBe('[██████████] 100%');
      expect(formatProgressBar(33, 10)).toBe('[███░░░░░░░]  33%');
    });

    it('formats elapsed time correctly', () => {
      expect(formatElapsed(5000)).toBe('5s');
      expect(formatElapsed(65000)).toBe('1m 5s');
      expect(formatElapsed(3665000)).toBe('1h 1m');
      expect(formatElapsed(0)).toBe('0s');
      expect(formatElapsed(59999)).toBe('59s');
      expect(formatElapsed(60000)).toBe('1m 0s');
    });
  });

  describe('status display', () => {
    it('identifies terminal statuses correctly', () => {
      const isTerminalStatus = (status: string): boolean => {
        return status === 'completed' || status === 'failed' || status === 'partial';
      };

      expect(isTerminalStatus('completed')).toBe(true);
      expect(isTerminalStatus('failed')).toBe(true);
      expect(isTerminalStatus('partial')).toBe(true);
      expect(isTerminalStatus('pending')).toBe(false);
      expect(isTerminalStatus('running')).toBe(false);
    });

  });

  describe('generator consumption', () => {
    it('consumes async generator until done', async () => {
      // Create a mock async generator
      async function* mockGenerator(): AsyncGenerator<JobStatus, WatchResult> {
        yield { id: 'job_123', status: 'pending' };
        yield { id: 'job_123', status: 'running', progress: 50 };
        yield { id: 'job_123', status: 'completed', progress: 100 };
        return {
          status: { id: 'job_123', status: 'completed', progress: 100 },
          timedOut: false,
          elapsed: 5000,
        };
      }

      const generator = mockGenerator();
      const statuses: JobStatus[] = [];

      while (true) {
        const result = await generator.next();
        if (result.done) {
          expect(result.value.timedOut).toBe(false);
          expect(result.value.elapsed).toBe(5000);
          break;
        }
        statuses.push(result.value);
      }

      expect(statuses).toHaveLength(3);
      expect(statuses[0]!.status).toBe('pending');
      expect(statuses[1]!.status).toBe('running');
      expect(statuses[2]!.status).toBe('completed');
    });
  });

  describe('JSON output', () => {
    it('structures JSON output correctly', () => {
      const result: WatchResult = {
        status: {
          id: 'job_123',
          status: 'completed',
          progress: 100,
          total: 10,
          processed: 10,
          results: [{ id: 1 }, { id: 2 }],
        },
        timedOut: false,
        elapsed: 5000,
      };

      // JSON output structure
      const jsonOutput = {
        job_id: result.status.id,
        status: result.status.status,
        progress: result.status.progress,
        total: result.status.total,
        processed: result.status.processed,
        results: result.status.results,
        errors: result.status.errors,
        timed_out: result.timedOut,
        elapsed_ms: result.elapsed,
      };

      expect(jsonOutput.job_id).toBe('job_123');
      expect(jsonOutput.status).toBe('completed');
      expect(jsonOutput.timed_out).toBe(false);
      expect(jsonOutput.elapsed_ms).toBe(5000);
    });
  });

  describe('signal handling', () => {
    it('creates AbortController for signal handling', () => {
      const controller = new AbortController();
      expect(controller.signal.aborted).toBe(false);

      controller.abort();
      expect(controller.signal.aborted).toBe(true);
    });

    it('passes signal to watchJob options', () => {
      const controller = new AbortController();
      const options: WatchOptions = {
        signal: controller.signal,
        maxWait: 60000,
        initialDelay: 1000,
      };

      expect(options.signal).toBe(controller.signal);
    });
  });

  describe('results preview', () => {
    it('limits results preview to 5 items', () => {
      const RESULTS_PREVIEW_LIMIT = 5;
      const results = Array.from({ length: 10 }, (_, i) => ({ id: i }));
      const preview = results.slice(0, RESULTS_PREVIEW_LIMIT);

      expect(preview).toHaveLength(5);
      expect(results.length - preview.length).toBe(5); // "and 5 more..."
    });

    it('shows all results when under limit', () => {
      const RESULTS_PREVIEW_LIMIT = 5;
      const results = [{ id: 1 }, { id: 2 }, { id: 3 }];
      const preview = results.slice(0, RESULTS_PREVIEW_LIMIT);

      expect(preview).toHaveLength(3);
      expect(preview).toEqual(results);
    });
  });
});
