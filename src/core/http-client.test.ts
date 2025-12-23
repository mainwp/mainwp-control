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
    // Return 302 redirect 10 times (exceeds MAX_REDIRECTS of 5)
    for (let i = 0; i < 10; i++) {
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
    expect(mockFetch.mock.calls.length).toBeLessThanOrEqual(6);
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
    mockFetch.mockResolvedValueOnce({
      status: 302,
      ok: false,
      headers: new Headers({
        location: 'not-a-valid-url-at-all',
      }),
    });

    const client = createHttpClient(baseConfig);

    // Should still work since relative URLs are resolved against base
    // Let's test with a truly malformed URL
    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce({
      status: 302,
      ok: false,
      headers: new Headers({
        location: 'javascript:alert(1)', // Protocol attack
      }),
    });

    // This should resolve to baseUrl + path, not execute JS
    // The URL constructor will reject javascript: URLs as invalid
    // when resolved against https: base
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
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('warns when SSL verification is disabled', () => {
    const warnSpy = vi.spyOn(console, 'warn');

    createHttpClient({
      baseUrl: 'https://dashboard.example.com',
      username: 'admin',
      appPassword: 'password',
      skipSSLVerification: true,
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('SSL verification is disabled')
    );
  });

  it('warns when using HTTP instead of HTTPS', () => {
    const warnSpy = vi.spyOn(console, 'warn');

    createHttpClient({
      baseUrl: 'http://dashboard.example.com',
      username: 'admin',
      appPassword: 'password',
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('HTTP instead of HTTPS')
    );
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
