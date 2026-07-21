/**
 * Shared HTTP fetch utility for LLM providers
 *
 * Extracts the common makeRequest pattern: timeout via AbortController,
 * combined abort signals, JSON POST, error handling.
 */

import { stripControlChars } from '../../utils/terminal-sanitizer.js';
import { isSensitiveKey } from '../../utils/redaction.js';
import type { ReadableStreamReadResult } from 'node:stream/web';

export const MAX_PROVIDER_ERROR_BODY_BYTES = 16 * 1024;

/**
 * Redact values of sensitive-looking keys in JSON-shaped error text, e.g.
 * {"api_key":"secret"}. Regex-based rather than JSON.parse so it also works
 * on truncated or almost-JSON bodies; key sensitivity comes from the shared
 * redaction list.
 */
function redactJsonLikeSecrets(text: string): string {
  // Value alternatives: a JSON string, or a bare scalar (number/bool/null).
  // Object/array openers are deliberately excluded so a non-sensitive key
  // with an object value doesn't swallow the nested keys inside it.
  return text.replace(
    /"([^"\\]{1,64})"(\s*:\s*)("(?:[^"\\]|\\.)*"|[^,{}[\]\s"]+)/g,
    (match, key: string, sep: string) =>
      isSensitiveKey(key) ? `"${key}"${sep}"[REDACTED]"` : match
  );
}

export function sanitizeProviderErrorBody(errorText: string): string {
  const sanitized = redactJsonLikeSecrets(stripControlChars(errorText));
  return sanitized.length > 500 ? sanitized.slice(0, 500) + '...' : sanitized;
}

/**
 * Reject redirect responses on provider requests. Following a redirect would
 * re-send the Authorization header (the user's API key) to whatever origin
 * the response names — same policy as the Dashboard transport's manual
 * redirect handling. All provider fetches use `redirect: 'manual'` and call
 * this on the response.
 */
export function assertNoRedirect(response: Response, providerName: string): void {
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    const target = location ? ` to "${sanitizeProviderErrorBody(location)}"` : '';
    throw new Error(
      `${providerName} API error: unexpected redirect (${response.status})${target} — provider requests never follow redirects`
    );
  }
}

export async function readBoundedResponseText(
  response: Response,
  maxBytes = MAX_PROVIDER_ERROR_BODY_BYTES,
  signal?: AbortSignal
): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    return Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (totalBytes < maxBytes) {
      const { done, value } = await readWithAbort(reader, signal);
      if (done) break;

      const remaining = maxBytes - totalBytes;
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      chunks.push(chunk);
      totalBytes += chunk.byteLength;

      if (value.byteLength > remaining || totalBytes >= maxBytes) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), totalBytes).toString('utf8');
}

function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) return reader.read();
  if (signal.aborted) return Promise.reject(new Error('Provider response read aborted'));

  return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    const onAbort = (): void => reject(new Error('Provider response read aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

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
      redirect: 'manual',
    });

    assertNoRedirect(response, options.providerName);

    if (!response.ok) {
      const errorText = await readBoundedResponseText(
        response,
        MAX_PROVIDER_ERROR_BODY_BYTES,
        combinedSignal,
      );
      // SECURITY: Strip control characters and truncate to prevent exfiltration
      // of large payloads from untrusted API error bodies
      const sanitized = sanitizeProviderErrorBody(errorText);
      throw new Error(`${options.providerName} API error: ${response.status} ${sanitized}`);
    }

    return (await response.json()) as T;
  } finally {
    clearTimeout(timeoutId);
  }
}
