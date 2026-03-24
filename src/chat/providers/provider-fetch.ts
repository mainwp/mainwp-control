/**
 * Shared HTTP fetch utility for LLM providers
 *
 * Extracts the common makeRequest pattern: timeout via AbortController,
 * combined abort signals, JSON POST, error handling.
 */

import { stripControlChars } from '../../utils/terminal-sanitizer.js';

export async function makeProviderRequest<T>(options: {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  timeout: number;
  signal?: AbortSignal | undefined;
  providerName: string;
}): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeout);

  const combinedSignal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;

  try {
    const response = await fetch(options.url, {
      method: 'POST',
      headers: options.headers,
      body: JSON.stringify(options.body),
      signal: combinedSignal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      // SECURITY: Strip control characters and truncate to prevent exfiltration
      // of large payloads from untrusted API error bodies
      const sanitized = stripControlChars(errorText);
      const truncated = sanitized.length > 500 ? sanitized.slice(0, 500) + '...' : sanitized;
      throw new Error(`${options.providerName} API error: ${response.status} ${truncated}`);
    }

    return (await response.json()) as T;
  } finally {
    clearTimeout(timeoutId);
  }
}
