/**
 * Retry utilities for mainwpcontrol
 *
 * Provides exponential backoff functionality for polling operations.
 */

/**
 * Backoff configuration options
 */
export interface BackoffOptions {
  /** Initial delay in milliseconds (default: 1000) */
  initialDelay?: number | undefined;
  /** Maximum delay in milliseconds (default: 30000) */
  maxDelay?: number | undefined;
  /** Delay multiplier (default: 2) */
  multiplier?: number | undefined;
  /** Maximum number of retries (default: Infinity) */
  maxRetries?: number | undefined;
  /** Optional abort signal */
  signal?: AbortSignal | undefined;
}

/**
 * Default backoff configuration
 */
const DEFAULTS = {
  initialDelay: 1000,
  maxDelay: 30000,
  multiplier: 2,
  maxRetries: Infinity,
} as const;

/**
 * Exponential backoff delay calculator
 */
export class ExponentialBackoff {
  private readonly initialDelay: number;
  private readonly maxDelay: number;
  private readonly multiplier: number;
  private readonly maxRetries: number;
  private readonly signal: AbortSignal | undefined;

  private currentDelay: number;
  private retryCount = 0;

  constructor(options: BackoffOptions = {}) {
    this.initialDelay = options.initialDelay ?? DEFAULTS.initialDelay;
    this.maxDelay = options.maxDelay ?? DEFAULTS.maxDelay;
    this.multiplier = options.multiplier ?? DEFAULTS.multiplier;
    this.maxRetries = options.maxRetries ?? DEFAULTS.maxRetries;
    this.signal = options.signal;
    this.currentDelay = this.initialDelay;
  }

  /**
   * Get the current retry count
   */
  get attempts(): number {
    return this.retryCount;
  }

  /**
   * Get the current delay
   */
  get delay(): number {
    return this.currentDelay;
  }

  /**
   * Check if more retries are allowed
   */
  get canRetry(): boolean {
    return this.retryCount < this.maxRetries;
  }

  /**
   * Reset the backoff state
   */
  reset(): void {
    this.currentDelay = this.initialDelay;
    this.retryCount = 0;
  }

  /**
   * Wait for the current delay, then advance to the next interval
   * Returns false if aborted or max retries exceeded
   */
  async wait(): Promise<boolean> {
    if (!this.canRetry) {
      return false;
    }

    if (this.signal?.aborted) {
      return false;
    }

    const delay = this.currentDelay;

    // Create a promise that resolves after delay or rejects on abort
    await new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(resolve, delay);

      if (this.signal) {
        this.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timeoutId);
            reject(new Error('Backoff aborted'));
          },
          { once: true }
        );
      }
    });

    // Advance to next interval
    this.retryCount++;
    this.currentDelay = Math.min(this.currentDelay * this.multiplier, this.maxDelay);

    return true;
  }

  /**
   * Get delay for a specific retry attempt (without advancing state)
   */
  getDelayForAttempt(attempt: number): number {
    if (attempt === 0) return 0;
    const delay = this.initialDelay * Math.pow(this.multiplier, attempt - 1);
    return Math.min(delay, this.maxDelay);
  }
}

