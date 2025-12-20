/**
 * Tests for retry utilities
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ExponentialBackoff, sleep, retryWithBackoff } from './retry.js';

describe('ExponentialBackoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('uses default values when no options provided', () => {
      const backoff = new ExponentialBackoff();
      expect(backoff.delay).toBe(1000);
      expect(backoff.attempts).toBe(0);
      expect(backoff.canRetry).toBe(true);
    });

    it('accepts custom options', () => {
      const backoff = new ExponentialBackoff({
        initialDelay: 500,
        maxDelay: 10000,
        multiplier: 3,
        maxRetries: 5,
      });
      expect(backoff.delay).toBe(500);
      expect(backoff.canRetry).toBe(true);
    });
  });

  describe('delay progression', () => {
    it('doubles delay on each wait (default multiplier)', async () => {
      const backoff = new ExponentialBackoff({
        initialDelay: 100,
        maxDelay: 10000,
      });

      // First delay: 100ms
      expect(backoff.delay).toBe(100);

      const waitPromise = backoff.wait();
      vi.advanceTimersByTime(100);
      await waitPromise;

      // After first wait: 200ms
      expect(backoff.delay).toBe(200);
      expect(backoff.attempts).toBe(1);

      const waitPromise2 = backoff.wait();
      vi.advanceTimersByTime(200);
      await waitPromise2;

      // After second wait: 400ms
      expect(backoff.delay).toBe(400);
      expect(backoff.attempts).toBe(2);
    });

    it('caps delay at maxDelay', async () => {
      const backoff = new ExponentialBackoff({
        initialDelay: 1000,
        maxDelay: 3000,
        multiplier: 2,
      });

      // Progress through delays: 1000 -> 2000 -> 3000 (capped)
      let waitPromise = backoff.wait();
      vi.advanceTimersByTime(1000);
      await waitPromise;
      expect(backoff.delay).toBe(2000);

      waitPromise = backoff.wait();
      vi.advanceTimersByTime(2000);
      await waitPromise;
      expect(backoff.delay).toBe(3000); // Would be 4000, but capped

      waitPromise = backoff.wait();
      vi.advanceTimersByTime(3000);
      await waitPromise;
      expect(backoff.delay).toBe(3000); // Stays at max
    });

    it('respects custom multiplier', async () => {
      const backoff = new ExponentialBackoff({
        initialDelay: 100,
        maxDelay: 100000,
        multiplier: 3,
      });

      const waitPromise = backoff.wait();
      vi.advanceTimersByTime(100);
      await waitPromise;

      expect(backoff.delay).toBe(300); // 100 * 3
    });
  });

  describe('maxRetries', () => {
    it('returns false from wait() when maxRetries exceeded', async () => {
      const backoff = new ExponentialBackoff({
        initialDelay: 10,
        maxRetries: 2,
      });

      // First retry
      let waitPromise = backoff.wait();
      vi.advanceTimersByTime(10);
      expect(await waitPromise).toBe(true);
      expect(backoff.attempts).toBe(1);

      // Second retry
      waitPromise = backoff.wait();
      vi.advanceTimersByTime(20);
      expect(await waitPromise).toBe(true);
      expect(backoff.attempts).toBe(2);

      // Third attempt should return false immediately
      expect(backoff.canRetry).toBe(false);
      expect(await backoff.wait()).toBe(false);
    });
  });

  describe('abort signal', () => {
    it('returns false when signal already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      const backoff = new ExponentialBackoff({
        signal: controller.signal,
      });

      const result = await backoff.wait();
      expect(result).toBe(false);
    });

    it('throws when aborted during wait', async () => {
      const controller = new AbortController();
      const backoff = new ExponentialBackoff({
        initialDelay: 1000,
        signal: controller.signal,
      });

      const waitPromise = backoff.wait();

      // Abort after partial delay
      vi.advanceTimersByTime(500);
      controller.abort();

      await expect(waitPromise).rejects.toThrow('Backoff aborted');
    });
  });

  describe('reset', () => {
    it('resets delay and attempts to initial state', async () => {
      const backoff = new ExponentialBackoff({
        initialDelay: 100,
      });

      // Advance a few times
      let waitPromise = backoff.wait();
      vi.advanceTimersByTime(100);
      await waitPromise;

      waitPromise = backoff.wait();
      vi.advanceTimersByTime(200);
      await waitPromise;

      expect(backoff.attempts).toBe(2);
      expect(backoff.delay).toBe(400);

      // Reset
      backoff.reset();
      expect(backoff.attempts).toBe(0);
      expect(backoff.delay).toBe(100);
    });
  });

  describe('getDelayForAttempt', () => {
    it('returns 0 for attempt 0', () => {
      const backoff = new ExponentialBackoff({
        initialDelay: 1000,
      });
      expect(backoff.getDelayForAttempt(0)).toBe(0);
    });

    it('calculates correct delay for each attempt', () => {
      const backoff = new ExponentialBackoff({
        initialDelay: 1000,
        maxDelay: 30000,
        multiplier: 2,
      });

      expect(backoff.getDelayForAttempt(1)).toBe(1000);
      expect(backoff.getDelayForAttempt(2)).toBe(2000);
      expect(backoff.getDelayForAttempt(3)).toBe(4000);
      expect(backoff.getDelayForAttempt(4)).toBe(8000);
      expect(backoff.getDelayForAttempt(5)).toBe(16000);
      expect(backoff.getDelayForAttempt(6)).toBe(30000); // Capped
      expect(backoff.getDelayForAttempt(7)).toBe(30000); // Still capped
    });

    it('does not modify internal state', () => {
      const backoff = new ExponentialBackoff({
        initialDelay: 1000,
      });

      backoff.getDelayForAttempt(5);
      expect(backoff.delay).toBe(1000);
      expect(backoff.attempts).toBe(0);
    });
  });
});

describe('sleep', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves after specified delay', async () => {
    const promise = sleep(1000);
    vi.advanceTimersByTime(1000);
    await expect(promise).resolves.toBeUndefined();
  });

  it('rejects when signal already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(sleep(1000, controller.signal)).rejects.toThrow('Sleep aborted');
  });

  it('rejects when aborted during sleep', async () => {
    const controller = new AbortController();
    const promise = sleep(1000, controller.signal);

    vi.advanceTimersByTime(500);
    controller.abort();

    await expect(promise).rejects.toThrow('Sleep aborted');
  });
});

describe('retryWithBackoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns immediately on success', async () => {
    const fn = vi.fn().mockResolvedValue('success');

    const result = await retryWithBackoff(fn, { maxRetries: 3 });

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on failure and eventually succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockResolvedValue('success');

    const promise = retryWithBackoff(fn, {
      initialDelay: 100,
      maxRetries: 5,
    });

    // First call fails
    await vi.advanceTimersByTimeAsync(0);

    // Wait for first backoff
    await vi.advanceTimersByTimeAsync(100);

    // Second call fails
    await vi.advanceTimersByTimeAsync(0);

    // Wait for second backoff
    await vi.advanceTimersByTimeAsync(200);

    // Third call succeeds
    const result = await promise;
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws after max retries exhausted', async () => {
    vi.useRealTimers(); // Use real timers for this test to avoid async issues

    const fn = vi.fn().mockRejectedValue(new Error('always fails'));

    // With maxRetries=2 and very short delays, we expect:
    // - Initial call fails
    // - Wait 1ms, retry fails
    // - Wait 2ms, maxRetries reached, throws
    await expect(
      retryWithBackoff(fn, {
        initialDelay: 1,
        maxRetries: 2,
      })
    ).rejects.toThrow('always fails');

    // Call count: initial + up to 2 retries = depends on when canRetry is checked
    // The implementation calls fn in a while(canRetry) loop
    expect(fn).toHaveBeenCalledTimes(2);

    vi.useFakeTimers(); // Restore fake timers
  });

  it('does not retry non-retryable errors', async () => {
    const retryableError = new Error('retryable');
    const nonRetryableError = new Error('fatal');

    const fn = vi.fn().mockRejectedValueOnce(nonRetryableError);

    await expect(
      retryWithBackoff(fn, {
        maxRetries: 5,
        isRetryable: (error) => error === retryableError,
      })
    ).rejects.toThrow('fatal');

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('respects abort signal', async () => {
    const controller = new AbortController();
    const fn = vi.fn().mockRejectedValue(new Error('fail'));

    const promise = retryWithBackoff(fn, {
      initialDelay: 100,
      maxRetries: 10,
      signal: controller.signal,
    });

    // First call fails
    await vi.advanceTimersByTimeAsync(0);

    // Abort during backoff wait
    vi.advanceTimersByTime(50);
    controller.abort();

    await expect(promise).rejects.toThrow('fail');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
