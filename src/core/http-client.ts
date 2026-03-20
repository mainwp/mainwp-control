/**
 * HTTP Client for mainwpctl
 *
 * Single abstraction for all API traffic.
 * INVARIANT: All HTTP requests MUST go through this module.
 */

import { Agent } from 'undici';
import { NetworkError, TLSError, APIError, AuthError } from '../utils/errors.js';

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

      clearTimeout(timeoutId);

      // SECURITY: Handle redirects manually - only follow same-origin
      if (this.isRedirect(response.status)) {
        return this.handleRedirect<T>(response, method, body, options, redirectCount);
      }

      // Check response size via Content-Length header (pre-read guard)
      const contentLength = response.headers.get('content-length');
      const parsedContentLength = contentLength ? parseInt(contentLength, 10) : NaN;
      if (!isNaN(parsedContentLength) && parsedContentLength > this.maxResponseSize) {
        throw new NetworkError(
          `Response too large: ${parsedContentLength} bytes`,
          undefined,
          'Response is too large. Check the Dashboard logs or try a simpler query'
        );
      }

      // Parse response
      const text = await response.text();

      // Post-read body length check (only when Content-Length was absent or unparseable)
      if (isNaN(parsedContentLength) && text.length > this.maxResponseSize) {
        throw new NetworkError(
          `Response too large: ${text.length} bytes`,
          undefined,
          'Response is too large. Check the Dashboard logs or try a simpler query'
        );
      }

      let data: T;
      try {
        data = text ? (JSON.parse(text) as T) : ({} as T);
      } catch {
        // If not JSON, wrap as string
        data = text as unknown as T;
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
      clearTimeout(timeoutId);
      throw this.normalizeError(error);
    }
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
      'User-Agent': 'mainwpctl/1.0.0',
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
          'Run `mainwpctl login` to update your credentials'
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

  /**
   * Normalize errors to MainWPCTLError types
   */
  private normalizeError(error: unknown): Error {
    if (error instanceof Error) {
      // Check for abort/timeout
      if (error.name === 'AbortError') {
        return new NetworkError(
          'Request timed out',
          undefined,
          'Increase timeout with --timeout flag or check network connection'
        );
      }

      // Check for network errors (check both error and cause chain)
      const errorCode = this.extractErrorCode(error);
      if (errorCode) {
        if (errorCode === 'ECONNREFUSED') {
          return new NetworkError(
            'Connection refused. Is the Dashboard running?',
            undefined,
            'Verify the Dashboard is running and the URL is correct'
          );
        }
        if (errorCode === 'ENOTFOUND') {
          return new NetworkError(
            'Host not found. Check the Dashboard URL.',
            undefined,
            'Check the Dashboard URL in your profile with `mainwpctl config show`'
          );
        }
        if (errorCode === 'CERT_HAS_EXPIRED' || errorCode === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
          return new TLSError(
            'SSL certificate error. Use --skip-ssl-verify if needed.',
            undefined,
            'Use --skip-ssl-verify flag if using self-signed certificates (not recommended for production)'
          );
        }
      }

      // Already a MainWPCTL error or known network error type
      if (error.name === 'NetworkError' || error.name === 'TLSError' ||
          error.name === 'APIError' || error.name === 'AuthError') {
        return error;
      }
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
    if (typeof data !== 'object' || data === null) return data;
    if (Array.isArray(data)) return data.map(item => this.sanitizeErrorData(item));

    const sanitized: Record<string, unknown> = {};
    const sensitiveFields = ['password', 'token', 'secret', 'authorization', 'cookie'];

    for (const [key, value] of Object.entries(data)) {
      if (sensitiveFields.includes(key.toLowerCase())) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = this.sanitizeErrorData(value);
      }
    }
    return sanitized;
  }
}

/**
 * Create an HTTP client from configuration
 */
export function createHttpClient(config: HttpClientConfig): HttpClient {
  return new HttpClient(config);
}
