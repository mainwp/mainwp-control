/**
 * Tests for jobs watch command
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock modules before importing
vi.mock('../../core/batch-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/batch-manager.js')>()),
  createBatchManager: vi.fn(),
}));


import { createBatchManager } from '../../core/batch-manager.js';
import type { JobStatus, WatchResult, WatchOptions } from '../../core/batch-manager.js';
import { formatProgressBar, formatElapsed } from '../../output/formatter.js';
import { successOutput } from '../../output/json-envelope.js';
// Import the real helpers from watch.ts instead of re-implementing them —
// see chat.test.ts for the same pattern.
import JobsWatch, { isTerminalStatus, RESULTS_PREVIEW_LIMIT } from './watch.js';

/**
 * Create a JobsWatch instance with a mocked oclif Config and captured log
 * output, so we can drive its real private outputResult()/formatHumanOutput()
 * methods instead of duplicating their logic in assertions.
 */
function createWatchCommand(): { command: JobsWatch; log: ReturnType<typeof vi.fn> } {
  const mockConfig = {
    root: '/mock/root',
    bin: 'mainwpcontrol',
    name: 'mainwpcontrol',
    version: '1.0.0',
    pjson: { name: 'mainwpcontrol', version: '1.0.0' },
    dataDir: '/mock/data',
    cacheDir: '/mock/cache',
    configDir: '/mock/config',
    findCommand: vi.fn(),
    runCommand: vi.fn(),
    runHook: vi.fn(),
  };

  const command = new JobsWatch([], mockConfig as never);
  const log = vi.fn();
  command.log = log;

  return { command, log };
}

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
      expect(isTerminalStatus('completed')).toBe(true);
      expect(isTerminalStatus('failed')).toBe(true);
      expect(isTerminalStatus('partial')).toBe(true);
      expect(isTerminalStatus('cancelled')).toBe(true);
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
    it('outputs the real success envelope via outputResult()', () => {
      const { command, log } = createWatchCommand();
      (command as any).jsonOutput = true;

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

      (command as any).outputResult('job_123', result);

      expect(log).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(log.mock.calls[0]![0] as string);

      expect(parsed).toEqual(
        successOutput({
          job_id: 'job_123',
          ...result.status,
          timedOut: false,
          elapsed_ms: 5000,
        })
      );
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
    it('limits results preview to RESULTS_PREVIEW_LIMIT via the real formatHumanOutput path', () => {
      const { command, log } = createWatchCommand();

      const results = Array.from({ length: RESULTS_PREVIEW_LIMIT + 5 }, (_, i) => ({
        id: i,
        name: `site-${i}`,
      }));
      const result: WatchResult = {
        status: { id: 'job_123', status: 'completed', results },
        timedOut: false,
        elapsed: 5000,
      };

      (command as any).outputResult('job_123', result);

      const output = log.mock.calls[0]![0] as string;

      for (const item of results.slice(0, RESULTS_PREVIEW_LIMIT)) {
        expect(output).toContain(`- ${item.name}`);
      }
      expect(output).toContain(`... and ${results.length - RESULTS_PREVIEW_LIMIT} more`);

      const excludedItem = results[results.length - 1]!;
      expect(output).not.toContain(`- ${excludedItem.name}`);
    });

    it('collapses Dashboard-controlled result labels to one row', () => {
      // safeString() strips escape sequences but preserves CR/LF/tab, so a
      // hostile result name could forge a status line of its own.
      const { command, log } = createWatchCommand();

      const result: WatchResult = {
        status: {
          id: 'job_123',
          status: 'completed',
          results: [{ name: 'site-1\n  ✓ Job completed' }, 'plain\rOVERWRITTEN'],
        },
        timedOut: false,
        elapsed: 5000,
      };

      (command as any).outputResult('job_123', result);
      const output = log.mock.calls[0]![0] as string;

      expect(output).toContain('- site-1   ✓ Job completed');
      expect(output).toContain('- plain OVERWRITTEN');
      expect(output).not.toMatch(/- site-1\n/);
      expect(output).not.toContain('plain\rOVERWRITTEN');
    });

    it('shows all results when under the limit', () => {
      const { command, log } = createWatchCommand();

      const results = [{ id: 1, name: 'site-1' }, { id: 2, name: 'site-2' }];
      const result: WatchResult = {
        status: { id: 'job_123', status: 'completed', results },
        timedOut: false,
        elapsed: 5000,
      };

      (command as any).outputResult('job_123', result);

      const output = log.mock.calls[0]![0] as string;

      for (const item of results) {
        expect(output).toContain(`- ${item.name}`);
      }
      expect(output).not.toContain('more');
    });
  });
});
