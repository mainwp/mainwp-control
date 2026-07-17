import { isDeepStrictEqual } from 'node:util';
import type { ConfigDir } from '../../../src/__tests__/process/fixtures/config-dir.js';
import type { MockServer } from '../../../src/__tests__/process/fixtures/mock-server.js';
import type { CLIInvoker } from '../lib/cli.js';
import type { AcceptanceCredentials } from '../lib/env.js';
import type { PackedPackage } from '../lib/pack.js';
import type {
  IndependentVerifier,
  VerifiedPluginResponse,
  VerifiedSite,
} from '../lib/verify.js';

export type AcceptanceTarget = 'live' | 'fixture';
export type AcceptanceMode = 'packed' | 'source';
export type ScenarioStatus = 'passed' | 'failed' | 'skipped' | 'unverified';

export interface AssertionResult {
  name: string;
  expected: unknown;
  actual: unknown;
  pass: boolean;
}

function recordedValue(value: unknown): unknown {
  return value === undefined ? '<undefined>' : value;
}

export class AssertionRecorder {
  readonly results: AssertionResult[] = [];

  equal(name: string, actual: unknown, expected: unknown): void {
    this.results.push({
      name,
      expected: recordedValue(expected),
      actual: recordedValue(actual),
      pass: Object.is(actual, expected),
    });
  }

  deepEqual(name: string, actual: unknown, expected: unknown): void {
    this.results.push({
      name,
      expected: recordedValue(expected),
      actual: recordedValue(actual),
      pass: isDeepStrictEqual(actual, expected),
    });
  }

  truthy(name: string, actual: unknown, expected = true): void {
    this.results.push({
      name,
      expected,
      actual: recordedValue(actual),
      pass: Boolean(actual),
    });
  }

  lessThan(name: string, actual: number, expected: number): void {
    this.results.push({
      name,
      expected,
      actual,
      pass: actual < expected,
    });
  }

  includes(name: string, values: unknown[], expected: unknown): void {
    this.results.push({
      name,
      expected: recordedValue(expected),
      actual: values,
      pass: values.includes(expected),
    });
  }
}

export interface ScenarioLaunch {
  env?: Record<string, string>;
  settings?: Record<string, unknown>;
  omitCredentialEnv?: boolean;
}

export interface ScenarioPreconditionContext {
  target: AcceptanceTarget;
  mode: AcceptanceMode;
  credentials: AcceptanceCredentials;
  verifier: IndependentVerifier;
  packedPackage: PackedPackage | null;
}

export interface ScenarioPreconditionResult {
  status?: 'skipped' | 'unverified';
  reason?: string;
  launch?: ScenarioLaunch;
  state?: Record<string, unknown>;
}

export interface ScenarioContext {
  cli: CLIInvoker;
  verifier: IndependentVerifier;
  configDir: ConfigDir;
  /** Present only for fixture-target scenarios. */
  mockServer: MockServer | null;
  config: {
    target: AcceptanceTarget;
    mode: AcceptanceMode;
    dashboardUrl: string;
    packageVersion: string;
  };
  packedPackage: PackedPackage | null;
  assert: AssertionRecorder;
  state: Record<string, unknown>;
}

export interface ScenarioDefinition {
  id: string;
  purpose: string;
  kind: 'read' | 'write';
  targets: AcceptanceTarget[];
  preconditions?: (
    ctx: ScenarioPreconditionContext
  ) => Promise<ScenarioPreconditionResult> | ScenarioPreconditionResult;
  run(ctx: ScenarioContext): Promise<void>;
  cleanup?(ctx: ScenarioContext): Promise<void>;
}

export interface ScenarioResult {
  id: string;
  purpose: string;
  kind: 'read' | 'write';
  status: ScenarioStatus;
  durationMs: number;
  assertions: AssertionResult[];
  reason?: string;
  error?: string;
}

export async function cliListAllSites(cli: CLIInvoker): Promise<VerifiedSite[]> {
  const sites: VerifiedSite[] = [];
  let page = 1;
  for (;;) {
    const result = await cli.run<{
      mode: string;
      ability: string;
      success: boolean;
      data: { items: VerifiedSite[]; total: number };
    }>([
      'abilities',
      'run',
      'mainwp/list-sites-v1',
      '--input',
      JSON.stringify({ page, per_page: 100 }),
      '--json',
    ]);
    if (result.exitCode !== 0 || result.json?.success !== true) {
      throw new Error(`mainwp/list-sites-v1 failed: ${result.stderr || result.stdout}`);
    }
    const response = result.json.data?.data;
    if (!response || !Array.isArray(response.items) || typeof response.total !== 'number') {
      throw new Error('mainwp/list-sites-v1 returned an unexpected CLI envelope');
    }
    sites.push(...response.items);
    if (sites.length >= response.total || response.items.length === 0) return sites;
    page += 1;
  }
}

export async function findSiteWithPlugins(
  verifier: IndependentVerifier
): Promise<{ site: VerifiedSite; plugins: VerifiedPluginResponse }> {
  for (const site of await verifier.listSites()) {
    const plugins = await verifier.getSitePlugins(site.id);
    if (plugins.plugins.length > 0) return { site, plugins };
  }
  throw new Error('No site with plugins was available for the scenario');
}

export async function findHelloDolly(
  verifier: IndependentVerifier,
  preferredSlug?: string
): Promise<{ site: VerifiedSite; slug: string; active: boolean } | null> {
  const safeSlugs = [preferredSlug, 'hello.php', 'hello-dolly/hello.php'].filter(
    (value): value is string => Boolean(value)
  );
  const inventories = await Promise.all(
    (await verifier.listSites()).map(async site => ({
      site,
      plugins: (await verifier.getSitePlugins(site.id)).plugins,
    }))
  );
  for (const slug of safeSlugs) {
    for (const inventory of inventories) {
      const plugin = inventory.plugins.find(candidate => candidate.slug === slug);
      if (plugin) return { site: inventory.site, slug: plugin.slug, active: plugin.active };
    }
  }
  return null;
}
