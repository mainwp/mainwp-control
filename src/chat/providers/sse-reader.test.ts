import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readSSEStream,
  SSE_IDLE_TIMEOUT_MS,
  SSE_MAX_DURATION_MS,
} from './sse-reader.js';

describe('readSSEStream bounds', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('rejects an oversized unterminated SSE line', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(
      `data: ${'x'.repeat(1024 * 1024 + 1)}`,
      { status: 200 },
    ));

    const stream = readSSEStream({
      url: 'https://provider.example.com/stream',
      headers: {},
      body: {},
      providerName: 'TestProvider',
    });

    await expect(stream.next()).rejects.toThrow(/buffer limit/i);
  });

  it('rejects when no stream data arrives before the idle timeout', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start() {
        // Never produce a chunk.
      },
    }), { status: 200 }));

    const stream = readSSEStream({
      url: 'https://provider.example.com/stream',
      headers: {},
      body: {},
      providerName: 'TestProvider',
    });
    const next = stream.next();
    const rejection = expect(next).rejects.toThrow(/idle timeout/i);
    await vi.advanceTimersByTimeAsync(SSE_IDLE_TIMEOUT_MS + 1);

    await rejection;
  });

  it('applies an abort signal before response headers arrive', async () => {
    const controller = new AbortController();
    vi.mocked(fetch).mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(new Error('fetch aborted')), { once: true });
    }));

    const stream = readSSEStream({
      url: 'https://provider.example.com/stream',
      headers: {},
      body: {},
      providerName: 'TestProvider',
      signal: controller.signal,
    });
    const next = stream.next();
    const rejection = expect(next).rejects.toThrow(/aborted/i);
    controller.abort();

    await rejection;
  });

  it('rejects a periodically active stream at the maximum duration', async () => {
    vi.useFakeTimers();
    let controller: ReadableStreamDefaultController<Uint8Array>;
    vi.mocked(fetch).mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
      },
    }), { status: 200 }));

    const stream = readSSEStream({
      url: 'https://provider.example.com/stream',
      headers: {},
      body: {},
      providerName: 'TestProvider',
    });

    for (let elapsed = 0; elapsed < SSE_MAX_DURATION_MS; elapsed += 30_000) {
      const next = stream.next();
      controller!.enqueue(new TextEncoder().encode('data: {}\n'));
      await expect(next).resolves.toMatchObject({ value: '{}', done: false });
      await vi.advanceTimersByTimeAsync(30_000);
    }

    await expect(stream.next()).rejects.toThrow(/maximum duration/i);
  });
});
