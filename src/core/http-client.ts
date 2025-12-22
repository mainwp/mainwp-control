/**
 * HTTP Client for mainwpctl
 *
 * Single abstraction for all API traffic.
 * INVARIANT: All HTTP requests MUST go through this module.
 */

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
  private readonly authHeader: string;
  private readonly timeout: number;
  private readonly maxResponseSize: number;
  private readonly skipSSLVerification: boolean;

  constructor(config: HttpClientConfig) {
    // Normalize base URL (remove trailing slash)
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');

    // Create Basic auth header
    const credentials = Buffer.from(`${config.username}:${config.appPassword}`).toString('base64');
    this.authHeader = `Basic ${credentials}`;

    this.timeout = config.timeout ?? DEFAULTS.timeout;
    this.maxResponseSize = config.maxResponseSize ?? DEFAULTS.maxResponseSize;
    this.skipSSLVerification = config.skipSSLVerification ?? false;

    // Warn about insecure configuration
    if (this.skipSSLVerification) {
      console.warn('WARNING: SSL verification is disabled. This is insecure.');
    }

    if (this.baseUrl.startsWith('http://')) {
      console.warn('WARNING: Using HTTP instead of HTTPS. Credentials may be exposed.');
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
    options?: RequestOptions
  ): Promise<HttpResponse<T>> {
    const url = this.buildUrl(path);
    const headers = this.buildHeaders(options?.headers);

    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      options?.timeout ?? this.timeout
    );

    // Combine signals if provided
    if (options?.signal) {
      options.signal.addEventListener('abort', () => controller.abort());
    }

    try {
      const fetchOptions: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };

      if (body !== undefined) {
        fetchOptions.body = JSON.stringify(body);
      }

      // Note: Node.js fetch doesn't support rejectUnauthorized directly
      // SSL verification toggle would need to be handled via agent
      // For now, we document this limitation
      const response = await fetch(url, fetchOptions);

      clearTimeout(timeoutId);

      // Check response size
      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > this.maxResponseSize) {
        throw new NetworkError(
          `Response too large: ${contentLength} bytes`,
          undefined,
          'Response is too large. Check the Dashboard logs or try a simpler query'
        );
      }

      // Parse response
      const text = await response.text();

      // Check size after reading
      if (text.length > this.maxResponseSize) {
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
   * Build full URL from path
   */
  private buildUrl(path: string): string {
    // If path is already a full URL, use it
    if (path.startsWith('http://') || path.startsWith('https://')) {
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

      // Check for network errors
      if ('code' in error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ECONNREFUSED') {
          return new NetworkError(
            'Connection refused. Is the Dashboard running?',
            undefined,
            'Verify the Dashboard is running and the URL is correct'
          );
        }
        if (code === 'ENOTFOUND') {
          return new NetworkError(
            'Host not found. Check the Dashboard URL.',
            undefined,
            'Check the Dashboard URL in your profile with `mainwpctl config show`'
          );
        }
        if (code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
          return new TLSError(
            'SSL certificate error. Use --skip-ssl-verify if needed.',
            undefined,
            'Use --skip-ssl-verify flag if using self-signed certificates (not recommended for production)'
          );
        }
      }

      // Already a proper error type
      if (error.name.includes('Error')) {
        return error;
      }
    }

    return new NetworkError(String(error));
  }

  /**
   * Sanitize error data to prevent credential leaks
   */
  private sanitizeErrorData(data: unknown): unknown {
    if (typeof data !== 'object' || data === null) {
      return data;
    }

    const sanitized = { ...data } as Record<string, unknown>;

    // Remove sensitive fields
    const sensitiveFields = ['password', 'token', 'secret', 'authorization', 'cookie'];
    for (const field of sensitiveFields) {
      if (field in sanitized) {
        sanitized[field] = '[REDACTED]';
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
