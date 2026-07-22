import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertNoRedirect,
  makeProviderRequest,
  readBoundedResponseText,
  sanitizeProviderErrorBody,
} from './provider-fetch.js';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('sanitizeProviderErrorBody', () => {
  it('strips terminal control characters', () => {
    expect(sanitizeProviderErrorBody('\x1b]0;Injected\x07failure')).toBe('failure');
  });

  it('redacts values of sensitive-looking keys in JSON-shaped bodies', () => {
    const body = '{"error":"bad request","api_key":"sk-live-12345","nested":{"authToken": "abc"},"count":2}';
    const sanitized = sanitizeProviderErrorBody(body);

    expect(sanitized).not.toContain('sk-live-12345');
    expect(sanitized).not.toContain('abc"');
    expect(sanitized).toContain('"api_key":"[REDACTED]"');
    expect(sanitized).toContain('"authToken": "[REDACTED]"');
    expect(sanitized).toContain('"error":"bad request"');
    expect(sanitized).toContain('"count":2');
  });

  it('truncates response bodies to 500 characters', () => {
    const output = sanitizeProviderErrorBody('x'.repeat(501));

    expect(output).toHaveLength(503);
    expect(output).toBe(`${'x'.repeat(500)}...`);
  });
});

describe('readBoundedResponseText', () => {
  it('stops reading and cancels after the byte limit', async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(12));
        controller.enqueue(new Uint8Array(12));
      },
      cancel() {
        cancelled = true;
      },
    }));

    const text = await readBoundedResponseText(response, 16);

    expect(Buffer.byteLength(text)).toBe(16);
    expect(cancelled).toBe(true);
  });

  it('cancels a stalled error body when its signal aborts', async () => {
    let cancelled = false;
    const controller = new AbortController();
    const response = new Response(new ReadableStream<Uint8Array>({
      start() {
        // Never produce a chunk.
      },
      cancel() {
        cancelled = true;
      },
    }));

    const read = readBoundedResponseText(response, 16, controller.signal);
    controller.abort();

    await expect(read).rejects.toThrow(/aborted/i);
    expect(cancelled).toBe(true);
  });
});

describe('assertNoRedirect', () => {
  it('throws on a redirect response, naming the redirect and the location', () => {
    const response = {
      status: 302,
      headers: { get: () => 'https://elsewhere.example' },
    } as unknown as Response;

    expect(() => assertNoRedirect(response, 'openai')).toThrow(
      /redirect.*elsewhere\.example/i
    );
  });

  it('does not throw on a success response', () => {
    const response = {
      status: 200,
      headers: { get: () => null },
    } as unknown as Response;

    expect(() => assertNoRedirect(response, 'openai')).not.toThrow();
  });

  it('does not throw on a not-found response', () => {
    const response = {
      status: 404,
      headers: { get: () => null },
    } as unknown as Response;

    expect(() => assertNoRedirect(response, 'openai')).not.toThrow();
  });
});

describe('makeProviderRequest', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects a redirect response and requests fetch without following it', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 307,
      ok: false,
      headers: new Headers({ location: 'https://elsewhere.example' }),
    });

    await expect(
      makeProviderRequest({
        url: 'https://api.openai.com/v1/chat/completions',
        headers: { authorization: 'Bearer test-key' },
        body: {},
        timeout: 5000,
        providerName: 'openai',
      })
    ).rejects.toThrow(/redirect/i);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.objectContaining({ redirect: 'manual' })
    );
  });
});
