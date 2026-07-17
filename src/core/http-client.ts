/**
 * HTTP Client for mainwpcontrol
 *
 * Single abstraction for all API traffic.
 * INVARIANT: All HTTP requests MUST go through this module.
 */

import { createRequire } from 'node:module';
import { Agent } from 'undici';
import { NetworkError, TLSError, APIError, AuthError } from '../utils/errors.js';
import { redactSensitiveKeys } from '../utils/redaction.js';

const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require('../../package.json') as { version: string };

/**
 * Request options
 */
export interface RequestOptions {
  headers?: Record<string, string> | undefined;
  timeout?: number | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * HTTP client configuration
 */
export interface HttpClientConfig {
  baseUrl: string;
  username: string;
  appPassword: string;
  skipSSLVerification?: boolean | undefined;
  timeout?: number | undefined;
  maxResponseSize?: number | undefined;
  allowInsecureHttp?: boolean | undefined;
}

/**
 * Response wrapper with typed JSON parsing
 */
export interface HttpResponse<T = unknown> {
  status: number;
  statusText: string;
  headers: Headers;
  data: T;
}

/**
 * Default configuration values
 */
const DEFAULTS = {
  timeout: 30000, // 30 seconds
  maxResponseSize: 10 * 1024 * 1024, // 10 MB
};

/**
 * HTTP client class
 */
export class HttpClient {
  private readonly baseUrl: string;
  private readonly baseOrigin: string;
  private readonly authHeader: string;
  private readonly timeout: number;
  private readonly maxResponseSize: number;
  private readonly skipSSLVerification: boolean;
  private readonly dispatcher: Agent | undefined;

  /** Maximum redirects to follow (same-origin only) */
  private static readonly MAX_REDIRECTS = 10;

  constructor(config: HttpClientConfig) {
    // Normalize base URL (remove trailing slash)
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');

    // Extract origin for redirect validation
    const parsedUrl = new URL(this.baseUrl);
    this.baseOrigin = parsedUrl.origin;

    // Create Basic auth header
    const credentials = Buffer.from(`${config.username}:${config.appPassword}`).toString('base64');
    this.authHeader = `Basic ${credentials}`;

    this.timeout = config.timeout ?? DEFAULTS.timeout;
    this.maxResponseSize = config.maxResponseSize ?? DEFAULTS.maxResponseSize;
    this.skipSSLVerification = config.skipSSLVerification ?? false;

    // SECURITY: Enforce HTTPS by default
    if (this.baseUrl.startsWith('http://')) {
      const allowHttp = config.allowInsecureHttp || process.env['MAINWP_ALLOW_HTTP'] === '1';
      if (!allowHttp) {
        throw new TLSError(
          'Dashboard URL uses insecure HTTP. HTTPS is required by default.',
          undefined,
          'Switch to HTTPS, or set allowInsecureHttp in settings / MAINWP_ALLOW_HTTP=1 env var to override'
        );
      }
      console.error(
        'Warning: Dashboard URL uses HTTP. Credentials are sent unencrypted. ' +
        'Consider switching to HTTPS.'
      );
    }

    // Configure undici Agent for SSL verification control
    if (this.skipSSLVerification) {
      console.error(
        'Warning: SSL verification is disabled for this profile. ' +
        'Connection is vulnerable to interception.'
      );
      this.dispatcher = new Agent({
        connect: {
          rejectUnauthorized: false,
        },
      });
    }
  }

  /**
   * Make a GET request
   */
  async get<T = unknown>(
    path: string,
    options?: RequestOptions
  ): Promise<HttpResponse<T>> {
    return this.request<T>('GET', path, undefined, options);
  }

  /**
   * Make a POST request
   */
  async post<T = unknown>(
    path: string,
    body?: unknown,
    options?: RequestOptions
  ): Promise<HttpResponse<T>> {
    return this.request<T>('POST', path, body, options);
  }

  /**
   * Make a DELETE request
   */
  async delete<T = unknown>(
    path: string,
    options?: RequestOptions
  ): Promise<HttpResponse<T>> {
    return this.request<T>('DELETE', path, undefined, options);
  }

  /**
   * Core request method
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: RequestOptions,
    redirectCount = 0
  ): Promise<HttpResponse<T>> {
    const url = this.buildUrl(path);
    const headers = this.buildHeaders(options?.headers);

    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      options?.timeout ?? this.timeout
    );

    // Combine user signal with timeout signal
    const effectiveSignal = options?.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;

    try {
      const fetchOptions: RequestInit = {
        method,
        headers,
        signal: effectiveSignal,
        // SECURITY: Disable auto-redirect to prevent auth header leakage to cross-origin
        redirect: 'manual',
      };

      if (body !== undefined) {
        fetchOptions.body = JSON.stringify(body);
      }

      // Use undici dispatcher for SSL verification control
      if (this.dispatcher) {
        // Cast needed due to type mismatch between undici and Node.js fetch types
        (fetchOptions as Record<string, unknown>).dispatcher = this.dispatcher;
      }

      const response = await fetch(url, fetchOptions);

      // SECURITY: Handle redirects manually - only follow same-origin
      if (this.isRedirect(response.status)) {
        clearTimeout(timeoutId);
        return this.handleRedirect<T>(response, method, body, options, redirectCount);
      }

      // Check response size via Content-Length header (pre-read guard).
      // REPORT-ONLY: this trusts the server-reported Content-Length; a server
      // that lies about it still gets fully buffered by the post-read check
      // below. Acceptable here since the only server we talk to is the
      // trusted Dashboard the operator configured, not an arbitrary origin.
      const contentLength = response.headers.get('content-length');
      const parsedContentLength = contentLength ? parseInt(contentLength, 10) : NaN;
      if (!isNaN(parsedContentLength) && parsedContentLength > this.maxResponseSize) {
        controller.abort();
        void response.body?.cancel().catch(() => {});
        throw new NetworkError(
          `Response too large: ${parsedContentLength} bytes`,
          undefined,
          'Response is too large. Check the Dashboard logs or try a simpler query'
        );
      }

      const text = await this.readResponseBody(response, controller, effectiveSignal);

      let data: T;
      if (response.ok) {
        const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
        const mediaType = contentType.split(';', 1)[0]?.trim() ?? '';
        if (mediaType !== 'application/json' && !mediaType.endsWith('+json')) {
          throw new APIError(
            'INVALID_RESPONSE',
            'Dashboard returned a successful response without a JSON content type',
            response.status
          );
        }
        if (text.trim().length === 0) {
          throw new APIError(
            'INVALID_RESPONSE',
            'Dashboard returned an empty successful response',
            response.status
          );
        }

        try {
          data = this.parseJson<T>(text);
        } catch {
          throw new APIError(
            'INVALID_RESPONSE',
            'Dashboard returned malformed JSON in a successful response',
            response.status
          );
        }
      } else {
        try {
          data = text ? this.parseJson<T>(text) : ({} as T);
        } catch {
          // Preserve existing non-2xx behavior: raw bodies are sanitized by
          // handleHttpError before they are exposed through a typed error.
          data = text as unknown as T;
        }
      }

      // Handle HTTP errors
      if (!response.ok) {
        this.handleHttpError(response.status, data);
      }

      return {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        data,
      };
    } catch (error) {
      // Distinguish caller cancellation from our own timeout: AbortSignal.any()
      // erases which signal fired, so check the caller's signal directly.
      throw this.normalizeError(error, options?.signal?.aborted === true);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async readResponseBody(
    response: Response,
    controller: AbortController,
    signal: AbortSignal
  ): Promise<string> {
    if (!response.body) {
      const text = await response.text();
      const byteLength = Buffer.byteLength(text, 'utf8');
      if (byteLength > this.maxResponseSize) {
        controller.abort();
        throw this.responseTooLarge(byteLength);
      }
      return text;
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    try {
      while (true) {
        const { done, value } = await this.readChunk(reader, signal);
        if (done) break;
        if (!value) continue;

        totalBytes += value.byteLength;
        if (totalBytes > this.maxResponseSize) {
          controller.abort();
          await reader.cancel().catch(() => {});
          throw this.responseTooLarge(totalBytes);
        }
        chunks.push(value);
      }
    } catch (error) {
      void reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }

    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), totalBytes).toString('utf8');
  }

  private readChunk(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    signal: AbortSignal
  ): Promise<{ done: boolean; value?: Uint8Array }> {
    if (signal.aborted) {
      return Promise.reject(new DOMException('The operation was aborted', 'AbortError'));
    }

    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        reject(new DOMException('The operation was aborted', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      reader.read().then(
        (result) => {
          signal.removeEventListener('abort', onAbort);
          resolve(result);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        }
      );
    });
  }

  private responseTooLarge(byteLength: number): NetworkError {
    return new NetworkError(
      `Response too large: ${byteLength} bytes`,
      undefined,
      'Response is too large. Check the Dashboard logs or try a simpler query'
    );
  }

  private parseJson<T>(text: string): T {
    // SECURITY: Strip __proto__ and constructor keys to prevent prototype
    // pollution from untrusted API responses.
    return JSON.parse(text, (key, value) => {
      if (key === '__proto__' || key === 'constructor') {
        return undefined;
      }
      return value;
    }) as T;
  }

  /**
   * Check if status code is a redirect
   */
  private isRedirect(status: number): boolean {
    return status >= 300 && status < 400;
  }

  /**
   * Handle HTTP redirects securely
   *
   * SECURITY: Only follows same-origin redirects to prevent credential leakage.
   * Cross-origin redirects are rejected with an error.
   */
  private async handleRedirect<T>(
    response: Response,
    method: string,
    body: unknown,
    options: RequestOptions | undefined,
    redirectCount: number
  ): Promise<HttpResponse<T>> {
    if (redirectCount >= HttpClient.MAX_REDIRECTS) {
      throw new NetworkError(
        'Too many redirects',
        undefined,
        'The Dashboard is redirecting too many times. Check the server configuration.'
      );
    }

    const location = response.headers.get('location');
    if (!location) {
      throw new NetworkError(
        `Redirect response (${response.status}) missing Location header`,
        undefined,
        'The server sent an invalid redirect response'
      );
    }

    // Resolve relative URLs against the current base
    let redirectUrl: URL;
    try {
      redirectUrl = new URL(location, this.baseUrl);
    } catch {
      throw new NetworkError(
        `Invalid redirect URL: ${location}`,
        undefined,
        'The server sent an invalid redirect location'
      );
    }

    // SECURITY: Only follow same-origin redirects
    if (redirectUrl.origin !== this.baseOrigin) {
      throw new NetworkError(
        `Cross-origin redirect blocked: ${this.baseOrigin} → ${redirectUrl.origin}`,
        undefined,
        'The Dashboard is redirecting to a different domain. This may indicate a security issue or misconfiguration.'
      );
    }

    // Follow same-origin redirect (pass full URL to preserve path)
    return this.request<T>(method, redirectUrl.href, body, options, redirectCount + 1);
  }

  /**
   * Build full URL from path
   */
  private buildUrl(path: string): string {
    // If path is already a full URL, validate same-origin
    if (path.startsWith('http://') || path.startsWith('https://')) {
      const parsedUrl = new URL(path);
      if (parsedUrl.origin !== this.baseOrigin) {
        throw new NetworkError(`Request URL origin mismatch: ${parsedUrl.origin} !== ${this.baseOrigin}`);
      }
      return path;
    }

    // Ensure path starts with /
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${this.baseUrl}${normalizedPath}`;
  }

  /**
   * Build request headers
   */
  private buildHeaders(custom?: Record<string, string>): Record<string, string> {
    return {
      Authorization: this.authHeader,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': `mainwpcontrol/${PKG_VERSION}`,
      ...custom,
    };
  }

  /**
   * Handle HTTP error status codes
   */
  private handleHttpError(status: number, data: unknown): never {
    // Sanitize error data (remove any potential credential leaks)
    const sanitizedData = this.sanitizeErrorData(data);

    switch (status) {
      case 401:
        throw new AuthError(
          'Authentication failed. Check your credentials.',
          sanitizedData,
          'Run `mainwpcontrol login` to update your credentials'
        );
      case 403:
        throw new AuthError(
          'Access denied. Insufficient permissions.',
          sanitizedData,
          'Verify your user has the required permissions in WordPress'
        );
      case 404:
        throw new APIError('NOT_FOUND', 'Resource not found', status, sanitizedData);
      case 422:
        throw new APIError('VALIDATION_ERROR', 'Validation failed', status, sanitizedData);
      case 429:
        throw new APIError(
          'RATE_LIMITED',
          'Too many requests',
          status,
          sanitizedData,
          'Wait a few minutes before retrying'
        );
      case 500:
      case 502:
      case 503:
      case 504:
        throw new APIError(
          'SERVER_ERROR',
          'Server error',
          status,
          sanitizedData,
          'Check the Dashboard logs or try again later'
        );
      default:
        throw new APIError('HTTP_ERROR', `HTTP ${status}`, status, sanitizedData);
    }
  }

  /** Error code → typed error mappings */
  private static readonly ERROR_CODE_MAP: Record<string, () => Error> = {
    ECONNREFUSED: () => new NetworkError(
      'Connection refused. Is the Dashboard running?',
      undefined,
      'Verify the Dashboard is running and the URL is correct'
    ),
    ENOTFOUND: () => new NetworkError(
      'Host not found. Check the Dashboard URL.',
      undefined,
      'Check the Dashboard URL in your profile with `mainwpcontrol config show`'
    ),
    CERT_HAS_EXPIRED: () => new TLSError(
      'SSL certificate error. Use --skip-ssl-verify if needed.',
      undefined,
      'Use --skip-ssl-verify flag if using self-signed certificates (not recommended for production)'
    ),
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: () => new TLSError(
      'SSL certificate error. Use --skip-ssl-verify if needed.',
      undefined,
      'Use --skip-ssl-verify flag if using self-signed certificates (not recommended for production)'
    ),
  };

  /** Known MainWPCTL error names that should pass through unchanged */
  private static readonly KNOWN_ERROR_NAMES = new Set([
    'NetworkError', 'TLSError', 'APIError', 'AuthError',
  ]);

  /**
   * Normalize errors to MainWPCTLError types
   */
  private normalizeError(error: unknown, cancelled = false): Error {
    if (!(error instanceof Error)) {
      return new NetworkError(String(error));
    }

    if (error.name === 'AbortError') {
      if (cancelled) {
        return new NetworkError('Request cancelled');
      }
      return new NetworkError(
        'Request timed out',
        undefined,
        'Increase timeout with --timeout flag or check network connection'
      );
    }

    const errorCode = this.extractErrorCode(error);
    const mapped = errorCode ? HttpClient.ERROR_CODE_MAP[errorCode] : undefined;
    if (mapped) return mapped();

    if (HttpClient.KNOWN_ERROR_NAMES.has(error.name)) {
      return error;
    }

    return new NetworkError(String(error));
  }

  /**
   * Extract error code from an error or its cause chain
   * (e.g., fetch wraps ECONNREFUSED in TypeError.cause)
   */
  private extractErrorCode(error: Error): string | undefined {
    // Check the error itself
    if ('code' in error && typeof (error as NodeJS.ErrnoException).code === 'string') {
      return (error as NodeJS.ErrnoException).code;
    }
    // Check the cause chain (Node.js fetch wraps errors in TypeError)
    const cause = (error as Error & { cause?: Error }).cause;
    if (cause instanceof Error) {
      return this.extractErrorCode(cause);
    }
    return undefined;
  }

  /**
   * Sanitize error data to prevent credential leaks
   */
  private sanitizeErrorData(data: unknown): unknown {
    return redactSensitiveKeys(data);
  }
}

/**
 * Create an HTTP client from configuration
 */
export function createHttpClient(config: HttpClientConfig): HttpClient {
  return new HttpClient(config);
}
