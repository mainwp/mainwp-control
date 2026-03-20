/**
 * Tests for HTTP Client Security Features
 *
 * Security tests verifying:
 * - Same-origin redirect following
 * - Cross-origin redirect blocking (credential protection)
 * - SSL verification configuration
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpClient, createHttpClient, type HttpClientConfig } from './http-client.js';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('HttpClient Redirect Security', () => {
  const baseConfig: HttpClientConfig = {
    baseUrl: 'https://dashboard.example.com',
    username: 'admin',
    appPassword: 'test-password',
  };

  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * GOLDEN TEST: Same-origin redirects are followed
   */
  it('follows same-origin redirects', async () => {
    // First request returns redirect
    mockFetch.mockResolvedValueOnce({
      status: 302,
      ok: false,
      headers: new Headers({
        location: '/wp-json/wp-abilities/v1/abilities',
      }),
    });

    // Second request (after redirect) returns success
    mockFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      text: () => Promise.resolve('{"abilities":[]}'),
    });

    const client = createHttpClient(baseConfig);
    const response = await client.get('/old-path');

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(200);
    expect(response.data).toEqual({ abilities: [] });
  });

  /**
   * GOLDEN TEST: Cross-origin redirects are blocked
   */
  it('blocks cross-origin redirects', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 302,
      ok: false,
      headers: new Headers({
        location: 'https://evil.com/capture-creds',
      }),
    });

    const client = createHttpClient(baseConfig);

    await expect(client.get('/api/test')).rejects.toThrow(
      /Cross-origin redirect blocked/
    );

    // Should only call fetch once (not follow the redirect)
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  /**
   * GOLDEN TEST: Auth header is not leaked to cross-origin
   */
  it('does not send auth header to cross-origin redirects', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 302,
      ok: false,
      headers: new Headers({
        location: 'https://attacker.com/steal',
      }),
    });

    const client = createHttpClient(baseConfig);

    await expect(client.get('/api/test')).rejects.toThrow();

    // Verify the first request had auth header
    const firstCall = mockFetch.mock.calls[0];
    expect(firstCall[1].headers['Authorization']).toMatch(/^Basic /);

    // Verify no second request was made
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  /**
   * GOLDEN TEST: Same-origin with different path is allowed
   */
  it('allows redirect to different path on same origin', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 301,
      ok: false,
      headers: new Headers({
        location: 'https://dashboard.example.com/new-api/path',
      }),
    });

    mockFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      statusText: 'OK',
      headers: new Headers(),
      text: () => Promise.resolve('{"success":true}'),
    });

    const client = createHttpClient(baseConfig);
    const response = await client.get('/old-api/path');

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(200);
  });

  /**
   * GOLDEN TEST: Relative redirects are resolved against base URL
   */
  it('resolves relative redirect URLs correctly', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 302,
      ok: false,
      headers: new Headers({
        location: '/wp-json/v2/new-endpoint',
      }),
    });

    mockFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      statusText: 'OK',
      headers: new Headers(),
      text: () => Promise.resolve('{}'),
    });

    const client = createHttpClient(baseConfig);
    await client.get('/old-endpoint');

    // Second call should be to the resolved URL
    const secondCall = mockFetch.mock.calls[1];
    expect(secondCall[0]).toBe('https://dashboard.example.com/wp-json/v2/new-endpoint');
  });

  /**
   * GOLDEN TEST: Too many redirects are rejected
   */
  it('rejects too many redirects', async () => {
    // Return 302 redirect 15 times (exceeds MAX_REDIRECTS of 10)
    for (let i = 0; i < 15; i++) {
      mockFetch.mockResolvedValueOnce({
        status: 302,
        ok: false,
        headers: new Headers({
          location: `/redirect-${i + 1}`,
        }),
      });
    }

    const client = createHttpClient(baseConfig);

    await expect(client.get('/start')).rejects.toThrow(/Too many redirects/);

    // Should stop after MAX_REDIRECTS + 1 calls
    expect(mockFetch.mock.calls.length).toBeLessThanOrEqual(11);
  });

  /**
   * GOLDEN TEST: Redirect with missing Location header is rejected
   */
  it('rejects redirect without Location header', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 302,
      ok: false,
      headers: new Headers({}), // No Location header
    });

    const client = createHttpClient(baseConfig);

    await expect(client.get('/api/test')).rejects.toThrow(/missing Location header/);
  });

  /**
   * GOLDEN TEST: Invalid redirect URL is rejected
   */
  it('rejects invalid redirect URL', async () => {
    // javascript: protocol has origin "null" → cross-origin → blocked
    mockFetch.mockResolvedValueOnce({
      status: 302,
      ok: false,
      headers: new Headers({
        location: 'javascript:alert(1)',
      }),
    });

    const client = createHttpClient(baseConfig);
    await expect(client.get('/api/test')).rejects.toThrow(/Cross-origin redirect blocked/);
  });

  /**
   * Test redirect behavior with protocol downgrade (HTTPS to HTTP)
   */
  it('blocks protocol downgrade redirects', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 302,
      ok: false,
      headers: new Headers({
        location: 'http://dashboard.example.com/insecure', // HTTP not HTTPS
      }),
    });

    const client = createHttpClient(baseConfig);

    // Different origin due to different protocol
    await expect(client.get('/api/test')).rejects.toThrow(/Cross-origin redirect blocked/);
  });

  /**
   * Test redirect behavior with port change
   */
  it('blocks redirect to different port', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 302,
      ok: false,
      headers: new Headers({
        location: 'https://dashboard.example.com:8443/different-port',
      }),
    });

    const client = createHttpClient(baseConfig);

    // Different origin due to different port
    await expect(client.get('/api/test')).rejects.toThrow(/Cross-origin redirect blocked/);
  });

  /**
   * Test subdomain redirect blocking
   */
  it('blocks redirect to subdomain', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 302,
      ok: false,
      headers: new Headers({
        location: 'https://api.dashboard.example.com/endpoint',
      }),
    });

    const client = createHttpClient(baseConfig);

    // Different origin due to different subdomain
    await expect(client.get('/api/test')).rejects.toThrow(/Cross-origin redirect blocked/);
  });
});

describe('HttpClient SSL Configuration', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits warning to stderr when SSL verification is disabled', () => {
    const errorSpy = vi.spyOn(console, 'error');

    createHttpClient({
      baseUrl: 'https://dashboard.example.com',
      username: 'admin',
      appPassword: 'password',
      skipSSLVerification: true,
    });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('SSL verification is disabled')
    );
  });

  it('throws TLSError when using HTTP URL without allowInsecureHttp', () => {
    expect(() =>
      createHttpClient({
        baseUrl: 'http://dashboard.example.com',
        username: 'admin',
        appPassword: 'password',
      })
    ).toThrow(/HTTPS is required/);
  });

  it('emits warning when using HTTP URL with allowInsecureHttp', () => {
    const errorSpy = vi.spyOn(console, 'error');

    createHttpClient({
      baseUrl: 'http://dashboard.example.com',
      username: 'admin',
      appPassword: 'password',
      allowInsecureHttp: true,
    });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Dashboard URL uses HTTP')
    );
  });

  it('emits warning when using HTTP URL with MAINWP_ALLOW_HTTP env', () => {
    const errorSpy = vi.spyOn(console, 'error');
    const original = process.env['MAINWP_ALLOW_HTTP'];
    process.env['MAINWP_ALLOW_HTTP'] = '1';

    try {
      createHttpClient({
        baseUrl: 'http://dashboard.example.com',
        username: 'admin',
        appPassword: 'password',
      });

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Dashboard URL uses HTTP')
      );
    } finally {
      if (original === undefined) {
        delete process.env['MAINWP_ALLOW_HTTP'];
      } else {
        process.env['MAINWP_ALLOW_HTTP'] = original;
      }
    }
  });

  it('does not emit warning for HTTPS URL without SSL skip', () => {
    const errorSpy = vi.spyOn(console, 'error');

    createHttpClient({
      baseUrl: 'https://dashboard.example.com',
      username: 'admin',
      appPassword: 'password',
    });

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('passes dispatcher option when skipSSLVerification is true', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      statusText: 'OK',
      headers: new Headers(),
      text: () => Promise.resolve('{}'),
    });

    const client = createHttpClient({
      baseUrl: 'https://dashboard.example.com',
      username: 'admin',
      appPassword: 'password',
      skipSSLVerification: true,
    });

    await client.get('/test');

    // Verify dispatcher was passed to fetch
    const fetchCall = mockFetch.mock.calls[0];
    expect(fetchCall[1]).toHaveProperty('dispatcher');
  });

  it('does not pass dispatcher when skipSSLVerification is false', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      statusText: 'OK',
      headers: new Headers(),
      text: () => Promise.resolve('{}'),
    });

    const client = createHttpClient({
      baseUrl: 'https://dashboard.example.com',
      username: 'admin',
      appPassword: 'password',
      skipSSLVerification: false,
    });

    await client.get('/test');

    // Verify dispatcher was not passed
    const fetchCall = mockFetch.mock.calls[0];
    expect(fetchCall[1].dispatcher).toBeUndefined();
  });
});

describe('HttpClient Response Size Checking', () => {
  const baseConfig: HttpClientConfig = {
    baseUrl: 'https://dashboard.example.com',
    username: 'admin',
    appPassword: 'test-password',
    maxResponseSize: 100,
  };

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('handles non-numeric Content-Length gracefully', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      statusText: 'OK',
      headers: new Headers({ 'content-length': 'abc' }),
      text: () => Promise.resolve('{"ok":true}'),
    });

    const client = createHttpClient(baseConfig);
    const response = await client.get('/test');

    expect(response.data).toEqual({ ok: true });
  });

  it('skips post-read body check when Content-Length already validated', async () => {
    // Content-Length is 50, which is under the 100 limit.
    // Body is also under limit. No error should occur.
    mockFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      statusText: 'OK',
      headers: new Headers({ 'content-length': '50' }),
      text: () => Promise.resolve('x'.repeat(50)),
    });

    const client = createHttpClient(baseConfig);
    const response = await client.get('/test');

    expect(response.status).toBe(200);
  });

  it('rejects oversized Content-Length before reading body', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      statusText: 'OK',
      headers: new Headers({ 'content-length': '200' }),
      text: () => Promise.resolve('x'.repeat(200)),
    });

    const client = createHttpClient(baseConfig);
    await expect(client.get('/test')).rejects.toThrow(/Response too large/);
  });

  it('checks body length when Content-Length is absent', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      statusText: 'OK',
      headers: new Headers({}),
      text: () => Promise.resolve('x'.repeat(200)),
    });

    const client = createHttpClient(baseConfig);
    await expect(client.get('/test')).rejects.toThrow(/Response too large/);
  });
});

describe('HttpClient sanitizeErrorData — Recursive Redaction', () => {
  const baseConfig: HttpClientConfig = {
    baseUrl: 'https://dashboard.example.com',
    username: 'admin',
    appPassword: 'test-password',
  };

  beforeEach(() => {
    mockFetch.mockReset();
  });

  /**
   * Helper: trigger handleHttpError by returning a non-ok status.
   * The error data is sanitized internally before being thrown.
   */
  async function triggerErrorWithData(data: unknown): Promise<Error> {
    mockFetch.mockResolvedValueOnce({
      status: 500,
      ok: false,
      statusText: 'Internal Server Error',
      headers: new Headers({ 'content-type': 'application/json' }),
      text: () => Promise.resolve(JSON.stringify(data)),
    });

    const client = createHttpClient(baseConfig);
    try {
      await client.get('/test');
      throw new Error('Expected error to be thrown');
    } catch (error) {
      return error as Error;
    }
  }

  it('redacts top-level sensitive fields', async () => {
    const error = await triggerErrorWithData({
      message: 'Auth failed',
      password: 'secret123',
      token: 'tok_abc',
    });

    expect(error.message).toContain('Server error');
    // The sanitized data is embedded in the thrown error
    const errorData = (error as any).details;
    expect(errorData.password).toBe('[REDACTED]');
    expect(errorData.token).toBe('[REDACTED]');
    expect(errorData.message).toBe('Auth failed');
  });

  it('redacts nested sensitive fields recursively', async () => {
    const error = await triggerErrorWithData({
      error: 'Auth error',
      details: {
        authorization: 'Basic cHduZWQ=',
        nested: {
          secret: 'deep-secret',
          safe: 'visible',
        },
      },
    });

    const errorData = (error as any).details;
    expect(errorData.details.authorization).toBe('[REDACTED]');
    expect(errorData.details.nested.secret).toBe('[REDACTED]');
    expect(errorData.details.nested.safe).toBe('visible');
  });

  it('handles case-insensitive key matching', async () => {
    const error = await triggerErrorWithData({
      Authorization: 'Bearer tok_abc',
      PASSWORD: 'secret',
      Cookie: 'session=xyz',
    });

    const errorData = (error as any).details;
    expect(errorData.Authorization).toBe('[REDACTED]');
    expect(errorData.PASSWORD).toBe('[REDACTED]');
    expect(errorData.Cookie).toBe('[REDACTED]');
  });

  it('handles arrays in error data', async () => {
    const error = await triggerErrorWithData({
      errors: [
        { message: 'Error 1', token: 'tok_1' },
        { message: 'Error 2', secret: 'sec_2' },
      ],
    });

    const errorData = (error as any).details;
    expect(errorData.errors[0].token).toBe('[REDACTED]');
    expect(errorData.errors[0].message).toBe('Error 1');
    expect(errorData.errors[1].secret).toBe('[REDACTED]');
    expect(errorData.errors[1].message).toBe('Error 2');
  });

  it('handles primitive values unchanged', async () => {
    const error = await triggerErrorWithData({
      code: 500,
      message: 'Internal error',
      active: true,
    });

    const errorData = (error as any).details;
    expect(errorData.code).toBe(500);
    expect(errorData.message).toBe('Internal error');
    expect(errorData.active).toBe(true);
  });
});

describe('HttpClient buildUrl Origin Validation', () => {
  const baseConfig: HttpClientConfig = {
    baseUrl: 'https://dashboard.example.com',
    username: 'admin',
    appPassword: 'test-password',
  };

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('rejects full URL with different origin', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      statusText: 'OK',
      headers: new Headers(),
      text: () => Promise.resolve('{}'),
    });

    const client = createHttpClient(baseConfig);

    await expect(
      client.get('https://evil.com/steal-creds')
    ).rejects.toThrow(/origin mismatch/);

    // fetch should not have been called
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects full URL with different port', async () => {
    const client = createHttpClient(baseConfig);

    await expect(
      client.get('https://dashboard.example.com:8443/api')
    ).rejects.toThrow(/origin mismatch/);
  });

  it('rejects protocol downgrade in full URL', async () => {
    const client = createHttpClient(baseConfig);

    await expect(
      client.get('http://dashboard.example.com/api')
    ).rejects.toThrow(/origin mismatch/);
  });

  it('accepts full URL with same origin', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      statusText: 'OK',
      headers: new Headers(),
      text: () => Promise.resolve('{"ok":true}'),
    });

    const client = createHttpClient(baseConfig);
    const response = await client.get('https://dashboard.example.com/wp-json/v1/test');

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('handles relative paths normally', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      statusText: 'OK',
      headers: new Headers(),
      text: () => Promise.resolve('{}'),
    });

    const client = createHttpClient(baseConfig);
    await client.get('/wp-json/test');

    const fetchCall = mockFetch.mock.calls[0];
    expect(fetchCall[0]).toBe('https://dashboard.example.com/wp-json/test');
  });
});

describe('HttpClient Manual Redirect Mode', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('sets redirect: manual in fetch options', async () => {
    mockFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      statusText: 'OK',
      headers: new Headers(),
      text: () => Promise.resolve('{}'),
    });

    const client = createHttpClient({
      baseUrl: 'https://dashboard.example.com',
      username: 'admin',
      appPassword: 'password',
    });

    await client.get('/test');

    const fetchCall = mockFetch.mock.calls[0];
    expect(fetchCall[1].redirect).toBe('manual');
  });
});
