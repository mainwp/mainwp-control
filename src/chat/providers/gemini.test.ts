/**
 * Tests for Gemini Provider Security — API Key Handling
 *
 * Verifies that API keys are sent via headers, not URL parameters.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { GeminiProvider } from './gemini.js';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('C1: Gemini API key not in URL', () => {
  afterEach(() => {
    mockFetch.mockReset();
  });

  it('sends API key via x-goog-api-key header in chat()', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        candidates: [{
          content: { parts: [{ text: 'Hello' }], role: 'model' },
          finishReason: 'STOP',
        }],
      }),
    });

    const provider = new GeminiProvider({ apiKey: 'test-secret-key' });
    await provider.chat([{ role: 'user', content: 'Hi' }]);

    const [url, options] = mockFetch.mock.calls[0];

    // URL must NOT contain the API key
    expect(url).not.toContain('test-secret-key');
    expect(url).not.toContain('key=');

    // Header must contain the API key
    expect(options.headers['x-goog-api-key']).toBe('test-secret-key');
  });

  it('sends API key via x-goog-api-key header in chatStream()', async () => {
    const mockBody = {
      getReader: () => ({
        read: vi.fn()
          .mockResolvedValueOnce({
            done: false,
            value: new TextEncoder().encode(
              'data: {"candidates":[{"content":{"parts":[{"text":"Hi"}],"role":"model"},"finishReason":"STOP"}]}\n\n'
            ),
          })
          .mockResolvedValueOnce({ done: true, value: undefined }),
      }),
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: mockBody,
    });

    const provider = new GeminiProvider({ apiKey: 'stream-secret-key' });
    const stream = provider.chatStream([{ role: 'user', content: 'Hi' }]);

    // Consume stream
    for await (const _chunk of stream) { /* drain */ }

    const [url, options] = mockFetch.mock.calls[0];

    // URL must NOT contain the API key
    expect(url).not.toContain('stream-secret-key');
    expect(url).not.toContain('key=');

    // Header must contain the API key
    expect(options.headers['x-goog-api-key']).toBe('stream-secret-key');
  });

  it('does not expose API key in error messages', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized'),
    });

    const provider = new GeminiProvider({ apiKey: 'error-secret-key' });

    try {
      await provider.chat([{ role: 'user', content: 'Hi' }]);
    } catch (error) {
      // Error message must not contain the API key
      expect((error as Error).message).not.toContain('error-secret-key');
    }
  });
});
