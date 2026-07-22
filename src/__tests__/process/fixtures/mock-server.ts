/**
 * Mock HTTP Server for Process Tests
 *
 * Simulates the MainWP Dashboard's /wp-json/wp-abilities/v1/* endpoints.
 * One instance per test file (beforeAll/afterAll), routes reset per test.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { abilitiesListResponse, STANDARD_ABILITIES } from './api-responses.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RecordedRequest {
  method: string;
  url: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export type RouteHandler = (
  req: RecordedRequest,
  res: ServerResponse,
) => void | Promise<void>;

interface Route {
  method: string;
  /** Exact path or RegExp */
  pattern: string | RegExp;
  handler: RouteHandler;
}

// ---------------------------------------------------------------------------
// MockServer
// ---------------------------------------------------------------------------

export class MockServer {
  private server: Server | null = null;
  private routes: Route[] = [];
  private recorded: RecordedRequest[] = [];
  private requestWaiters: Array<{ match: (r: RecordedRequest) => boolean; resolve: () => void }> = [];
  private credentials = { username: 'admin', password: 'test-pass' };

  /** The port the server is listening on (available after start()). */
  port = 0;

  /** Base URL including port. */
  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        void this.handleRequest(req, res);
      });
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address();
        if (typeof addr === 'object' && addr !== null) {
          this.port = addr.port;
        }
        resolve();
      });
      this.server.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  // -----------------------------------------------------------------------
  // Route management (reset between tests)
  // -----------------------------------------------------------------------

  reset(): void {
    this.routes = [];
    this.recorded = [];
    this.requestWaiters = [];
    this.credentials = { username: 'admin', password: 'test-pass' };
  }

  setCredentials(username: string, password: string): void {
    this.credentials = { username, password };
  }

  addRoute(method: string, pattern: string | RegExp, handler: RouteHandler): void {
    this.routes.push({ method: method.toUpperCase(), pattern, handler });
  }

  // -----------------------------------------------------------------------
  // Convenience helpers
  // -----------------------------------------------------------------------

  /** Register GET /wp-json/wp-abilities/v1/abilities returning the given list. */
  setAbilities(abilities: Record<string, unknown>[] = STANDARD_ABILITIES): void {
    const body = abilitiesListResponse(abilities);
    this.addRoute('GET', '/wp-json/wp-abilities/v1/abilities', (_req, res) => {
      this.json(res, 200, body);
    });
  }

  /** Register POST (and GET/DELETE) for ability run endpoint. */
  setRunResponse(
    abilityName: string,
    responseBody: Record<string, unknown>,
    statusCode = 200,
  ): void {
    const fullName = abilityName.startsWith('mainwp/') ? abilityName : `mainwp/${abilityName}`;
    const path = `/wp-json/wp-abilities/v1/abilities/${fullName}/run`;

    const handler: RouteHandler = (_req, res) => {
      this.json(res, statusCode, responseBody);
    };

    // Register for all methods that the executor might use
    this.addRoute('GET', path, handler);
    this.addRoute('POST', path, handler);
    this.addRoute('DELETE', path, handler);
  }

  /** Set up batch job status progression (counter-based). */
  setJobProgression(
    jobId: string,
    statuses: Record<string, unknown>[],
  ): void {
    let callCount = 0;
    const path = '/wp-json/wp-abilities/v1/abilities/mainwp/get-batch-job-status-v1/run';

    const handler: RouteHandler = (req, res) => {
      // Extract job_id from POST body (under input wrapper) or GET query params
      let receivedJobId: string | undefined;
      if (req.method === 'GET') {
        receivedJobId = req.query['input[job_id]'];
      } else {
        const body = req.body as Record<string, unknown> | undefined;
        const input = (body?.['input'] as Record<string, unknown> | undefined) ?? body;
        receivedJobId = input?.['job_id'] as string | undefined;
      }
      if (receivedJobId !== undefined && receivedJobId !== jobId) {
        this.json(res, 404, { success: false, error: { code: 'NOT_FOUND', message: 'Job not found' } });
        return;
      }
      const idx = Math.min(callCount, statuses.length - 1);
      callCount++;
      this.json(res, 200, statuses[idx]!);
    };

    // get-batch-job-status-v1 is readonly → executor sends GET
    this.addRoute('GET', path, handler);
    this.addRoute('POST', path, handler);
  }

  // -----------------------------------------------------------------------
  // Request recording & assertions
  // -----------------------------------------------------------------------

  getRecordedRequests(): RecordedRequest[] {
    return [...this.recorded];
  }

  /**
   * Resolves once a request whose path contains the given substring arrives
   * (immediately if one is already recorded). Lets a test key an action, like
   * delivering a signal, off evidence the CLI is booted and talking to the
   * server instead of a wall-clock delay that races slow CI runners.
   */
  waitForRequest(pathSubstring: string): Promise<void> {
    if (this.recorded.some((r) => r.path.includes(pathSubstring))) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.requestWaiters.push({ match: (r) => r.path.includes(pathSubstring), resolve });
    });
  }

  /** Return the last recorded request matching the given path substring. */
  getLastRequest(pathSubstring: string): RecordedRequest | undefined {
    return [...this.recorded].reverse().find((r) => r.path.includes(pathSubstring));
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parsedUrl = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);
    // Decode %2F in path segments so route matching works with encoded ability names
    const decodedPath = decodeURIComponent(parsedUrl.pathname);

    const query: Record<string, string> = {};
    parsedUrl.searchParams.forEach((v, k) => { query[k] = v; });

    const body = await this.readBody(req);

    const recorded: RecordedRequest = {
      method: (req.method ?? 'GET').toUpperCase(),
      url: req.url ?? '/',
      path: decodedPath,
      query,
      headers: req.headers as Record<string, string | string[] | undefined>,
      body,
    };
    this.recorded.push(recorded);
    this.requestWaiters = this.requestWaiters.filter((waiter) => {
      if (waiter.match(recorded)) {
        waiter.resolve();
        return false;
      }
      return true;
    });

    // Auth check
    if (!this.checkAuth(req)) {
      this.json(res, 401, { code: 'rest_forbidden', message: 'Authentication failed' });
      return;
    }

    // Route matching (try decoded path for all patterns)
    const route = this.findRoute(recorded.method, decodedPath, parsedUrl.pathname);
    if (route) {
      try {
        await route.handler(recorded, res);
      } catch (err) {
        this.json(res, 500, { error: String(err) });
      }
      return;
    }

    // 404
    this.json(res, 404, { code: 'rest_no_route', message: `No route for ${recorded.method} ${decodedPath}` });
  }

  private findRoute(method: string, decodedPath: string, rawPath: string): Route | undefined {
    for (const route of this.routes) {
      if (route.method !== method) continue;

      if (typeof route.pattern === 'string') {
        // Match against both decoded and raw path
        if (route.pattern === decodedPath || route.pattern === rawPath) {
          return route;
        }
      } else {
        if (route.pattern.test(decodedPath) || route.pattern.test(rawPath)) {
          return route;
        }
      }
    }
    return undefined;
  }

  private checkAuth(req: IncomingMessage): boolean {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Basic ')) {
      return false;
    }
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString();
    const [user, pass] = decoded.split(':');
    return user === this.credentials.username && pass === this.credentials.password;
  }

  private async readBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        if (chunks.length === 0) { resolve(undefined); return; }
        const raw = Buffer.concat(chunks).toString('utf-8');
        try { resolve(JSON.parse(raw)); }
        catch { resolve(raw); }
      });
      req.on('error', () => resolve(undefined));
    });
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }
}
