/**
 * Shared SSE (Server-Sent Events) line reader for LLM providers
 *
 * Handles the common boilerplate: response validation, chunked reading,
 * line buffering, and "data: " prefix stripping. Yields raw JSON strings
 * for provider-specific interpretation.
 */

import {
  readBoundedResponseText,
  sanitizeProviderErrorBody,
} from './provider-fetch.js';

export const MAX_SSE_LINE_BUFFER_BYTES = 1024 * 1024;
export const SSE_IDLE_TIMEOUT_MS = 60_000;
export const SSE_MAX_DURATION_MS = 5 * 60_000;

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
  const deadline = Date.now() + SSE_MAX_DURATION_MS;
  const durationSignal = AbortSignal.timeout(SSE_MAX_DURATION_MS);
  const combinedSignal = options.signal
    ? AbortSignal.any([options.signal, durationSignal])
    : durationSignal;
  const fetchOptions: RequestInit = {
    method: 'POST',
    headers: options.headers,
    body: JSON.stringify(options.body),
    signal: combinedSignal,
  };

  const response = await fetch(options.url, fetchOptions);

  if (!response.ok) {
    const error = await readBoundedResponseText(response, undefined, combinedSignal);
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

  try {
    while (true) {
      const { done, value } = await readWithIdleTimeout(
        reader,
        options.providerName,
        options.signal,
        deadline
      );
      if (done) break;
      if (!value) continue;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (Buffer.byteLength(line, 'utf8') > MAX_SSE_LINE_BUFFER_BYTES) {
          throw new Error(`${options.providerName} SSE line buffer limit exceeded`);
        }
        if (!line.startsWith('data: ')) continue;
        yield line.slice(6);
      }

      if (Buffer.byteLength(buffer, 'utf8') > MAX_SSE_LINE_BUFFER_BYTES) {
        throw new Error(`${options.providerName} SSE line buffer limit exceeded`);
      }
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  providerName: string,
  signal: AbortSignal | undefined,
  deadline: number
): Promise<{ done: boolean; value?: Uint8Array }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(`${providerName} SSE stream aborted`));
      return;
    }

    const remainingDuration = deadline - Date.now();
    if (remainingDuration <= 0) {
      reject(new Error(`${providerName} SSE maximum duration exceeded`));
      return;
    }

    const timeoutMs = Math.min(SSE_IDLE_TIMEOUT_MS, remainingDuration);
    const timeoutMessage = remainingDuration <= SSE_IDLE_TIMEOUT_MS
      ? `${providerName} SSE maximum duration exceeded`
      : `${providerName} SSE idle timeout exceeded`;
    const timeoutId = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);
    const onAbort = (): void => {
      clearTimeout(timeoutId);
      reject(new Error(`${providerName} SSE stream aborted`));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    reader.read().then(
      (result) => {
        clearTimeout(timeoutId);
        signal?.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timeoutId);
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}
