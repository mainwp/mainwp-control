import { describe, expect, it } from 'vitest';
import { readBoundedResponseText, sanitizeProviderErrorBody } from './provider-fetch.js';

describe('sanitizeProviderErrorBody', () => {
  it('strips terminal control characters', () => {
    expect(sanitizeProviderErrorBody('\x1b]0;Injected\x07failure')).toBe('failure');
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
