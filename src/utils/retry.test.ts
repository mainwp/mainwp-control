/**
 * Tests for retry utilities
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ExponentialBackoff } from './retry.js';

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

});

