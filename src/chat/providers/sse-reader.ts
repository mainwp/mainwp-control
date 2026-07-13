/**
 * Shared SSE (Server-Sent Events) line reader for LLM providers
 *
 * Handles the common boilerplate: response validation, chunked reading,
 * line buffering, and "data: " prefix stripping. Yields raw JSON strings
 * for provider-specific interpretation.
 */

import { sanitizeProviderErrorBody } from './provider-fetch.js';

/**
 * Make an SSE streaming request and yield raw JSON strings from "data: " lines.
 *
 * Skips the OpenAI "[DONE]" sentinel (yielded as-is so callers can detect it).
 * Invalid JSON is the caller's responsibility to handle.
 */
export async function* readSSEStream(options: {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal?: AbortSignal | undefined;
  providerName: string;
}): AsyncGenerator<string, void, undefined> {
  const fetchOptions: RequestInit = {
    method: 'POST',
    headers: options.headers,
    body: JSON.stringify(options.body),
  };

  if (options.signal) {
    fetchOptions.signal = options.signal;
  }

  const response = await fetch(options.url, fetchOptions);

  if (!response.ok) {
    const error = await response.text();
    throw new Error(
      `${options.providerName} API error: ${response.status} ${sanitizeProviderErrorBody(error)}`
    );
  }

  if (!response.body) {
    throw new Error('No response body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      yield line.slice(6);
    }
  }
}
