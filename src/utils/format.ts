/**
 * Formatting utilities for mainwpctl
 *
 * Provides consistent secret masking across all commands.
 */

/**
 * Options for customizing secret masking behavior
 */
export interface MaskOptions {
  /** Number of characters to show at the start (default: 4) */
  showFirst?: number;
  /** Number of characters to show at the end (default: 4) */
  showLast?: number;
  /** Minimum length before masking applies; shorter secrets return placeholder (default: 8) */
  minLength?: number;
  /** Placeholder string for secrets that are too short to mask (default: '****') */
  placeholder?: string;
}

/**
 * Masks a secret value by showing only the first and last few characters.
 *
 * @param value - The secret string to mask
 * @param options - Configuration options for masking behavior
 * @returns The masked string in format "xxxx...xxxx" or the placeholder if too short
 *
 * @example
 * ```ts
 * maskSecret('mypassword123') // Returns 'mypa...d123'
 * maskSecret('short') // Returns '****'
 * maskSecret('api-key-12345678', { showFirst: 6, showLast: 4 }) // Returns 'api-ke...5678'
 * ```
 */
export function maskSecret(value: string, options: MaskOptions = {}): string {
  const {
    showFirst = 4,
    showLast = 4,
    minLength = 8,
    placeholder = '****',
  } = options;

  if (!value || value.length <= minLength) {
    return placeholder;
  }

  return `${value.substring(0, showFirst)}...${value.substring(value.length - showLast)}`;
}

/**
 * Masks a password using standard format (4 chars...4 chars).
 *
 * Passwords 8 characters or shorter are fully masked with '****'.
 *
 * @param password - The password to mask
 * @returns The masked password
 *
 * @example
 * ```ts
 * maskPassword('mypassword123') // Returns 'mypa...d123'
 * maskPassword('short') // Returns '****'
 * ```
 */
export function maskPassword(password: string): string {
  return maskSecret(password, {
    showFirst: 4,
    showLast: 4,
    minLength: 8,
  });
}

/**
 * Masks an API key using standard format (6 chars...4 chars).
 *
 * API keys 10 characters or shorter are fully masked with '****'.
 *
 * @param apiKey - The API key to mask
 * @returns The masked API key
 *
 * @example
 * ```ts
 * maskApiKey('sk-1234567890abcdefghij') // Returns 'sk-123...ghij'
 * maskApiKey('shortkey') // Returns '****'
 * ```
 */
export function maskApiKey(apiKey: string): string {
  return maskSecret(apiKey, {
    showFirst: 6,
    showLast: 4,
    minLength: 10,
  });
}
