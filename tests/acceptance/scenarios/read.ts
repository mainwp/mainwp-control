import type { VerifiedPluginResponse, VerifiedSite } from '../lib/verify.js';
import type {
  ScenarioDefinition,
  ScenarioPreconditionContext,
  ScenarioPreconditionResult,
} from './types.js';

interface CLIEnvelope<T = unknown> {
  success: boolean;
  data?: T;
  error?: { code?: string; message?: string };
}

interface AbilityExecution<T> {
  mode: string;
  ability: string;
  success: boolean;
  data: T;
}

interface Theme {
  slug: string;
  version: string;
  active: boolean;
  update_version?: string | null;
}

interface ThemeResponse {
  site_id: number;
  site_url: string;
  active_theme: string;
  themes: Theme[];
  total: number;
}

interface Update {
  site_id: number;
  site_url: string;
  site_name: string;
  type: string;
  slug: string;
  name: string;
  current_version: string;
  new_version: string;
}

interface UpdatesResponse {
  updates: Update[];
  total: number;
  errors?: unknown[];
}

interface UpdatesSnapshot {
  updates: Update[];
  errors: unknown[];
}

interface Tag {
  id: number;
  name: string;
  sites_count: number;
  sites_ids?: number[];
}

interface PaginatedResponse<T> {
  items: T[];
  total: number;
}

function sorted(values: string[]): string[] {
  return [...values].sort();
}

function envelope<T>(value: unknown): CLIEnvelope<T> {
  if (!value || typeof value !== 'object') throw new Error('CLI did not return a JSON envelope');
  return value as CLIEnvelope<T>;
}

async function runAbility<T>(
  ctx: Parameters<ScenarioDefinition['run']>[0],
  abilityName: string,
  input: Record<string, unknown> = {},
  assertionName = abilityName
): Promise<T> {
  const args = ['abilities', 'run', abilityName];
  if (Object.keys(input).length > 0) args.push('--input', JSON.stringify(input));
  args.push('--json');
  const result = await ctx.cli.run(args);
  const output = envelope<AbilityExecution<T>>(result.json);
  ctx.assert.equal(`${assertionName} exits successfully`, result.exitCode, 0);
  ctx.assert.equal(`${assertionName} envelope succeeds`, output.success, true);
  ctx.assert.equal(`${assertionName} ability succeeds`, output.data?.success, true);
  if (!output.data) throw new Error(`${abilityName} returned no data envelope`);
  return output.data.data;
}

/**
 * Safety cap for the pagination loops below: a Dashboard reporting a wrong
 * `total` while returning non-empty pages must fail loudly, not hang the run.
 */
const MAX_LIST_PAGES = 100;

function assertPageWithinCap(page: number, abilityName: string): void {
  if (page >= MAX_LIST_PAGES) {
    throw new Error(`${abilityName} pagination did not terminate within ${MAX_LIST_PAGES} pages`);
  }
}

async function cliListAll<T>(
  ctx: Parameters<ScenarioDefinition['run']>[0],
  abilityName: string
): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page += 1) {
    const response = await runAbility<PaginatedResponse<T>>(
      ctx,
      abilityName,
      { page, per_page: 100 },
      `${abilityName} page ${page}`
    );
    items.push(...response.items);
    if (items.length >= response.total || response.items.length === 0) return items;
    assertPageWithinCap(page, abilityName);
  }
}

async function verifierListAll<T>(
  ctx: Parameters<ScenarioDefinition['run']>[0],
  abilityName: string
): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page += 1) {
    const response = (await ctx.verifier.execute(abilityName, {
      page,
      per_page: 100,
    })) as PaginatedResponse<T>;
    items.push(...response.items);
    if (items.length >= response.total || response.items.length === 0) return items;
    assertPageWithinCap(page, abilityName);
  }
}

async function connectedSitePrecondition(
  ctx: ScenarioPreconditionContext
): Promise<ScenarioPreconditionResult> {
  const site = (await ctx.verifier.listSites()).find(candidate => candidate.status === 'connected');
  if (!site) {
    return { status: 'skipped', reason: 'No connected site was available for the scenario.' };
  }
  return { state: { site } };
}

function selectedSite(state: Record<string, unknown>): VerifiedSite {
  const site = state.site as VerifiedSite | undefined;
  if (!site) throw new Error('Connected-site precondition did not provide a site');
  return site;
}

function themeSignature(theme: Theme): string {
  return [theme.slug, theme.version, theme.active, theme.update_version ?? ''].join(':');
}

function updateSignature(update: Update): string {
  return [
    update.site_id,
    update.site_url,
    update.site_name,
    update.type,
    update.slug,
    update.name,
    update.current_version,
    update.new_version,
  ].join(':');
}

function tagSignature(tag: Tag): string {
  return [
    tag.id,
    tag.name,
    tag.sites_count,
    sorted((tag.sites_ids ?? []).map(String)).join(','),
  ].join(':');
}

async function verifierListUpdates(
  ctx: Parameters<ScenarioDefinition['run']>[0],
  siteId: number
): Promise<UpdatesSnapshot> {
  const updates: Update[] = [];
  const errors: unknown[] = [];
  for (let page = 1; ; page += 1) {
    const response = (await ctx.verifier.execute('mainwp/list-updates-v1', {
      site_ids_or_domains: [siteId],
      page,
      per_page: 200,
    })) as UpdatesResponse;
    updates.push(...response.updates);
    errors.push(...(response.errors ?? []));
    if (updates.length >= response.total || response.updates.length === 0) {
      return { updates, errors };
    }
    assertPageWithinCap(page, 'mainwp/list-updates-v1');
  }
}

async function cliListUpdates(
  ctx: Parameters<ScenarioDefinition['run']>[0],
  siteId: number
): Promise<UpdatesSnapshot> {
  const updates: Update[] = [];
  const errors: unknown[] = [];
  for (let page = 1; ; page += 1) {
    const response = await runAbility<UpdatesResponse>(
      ctx,
      'mainwp/list-updates-v1',
      { site_ids_or_domains: [siteId], page, per_page: 200 },
      `mainwp/list-updates-v1 page ${page}`
    );
    updates.push(...response.updates);
    errors.push(...(response.errors ?? []));
    if (updates.length >= response.total || response.updates.length === 0) {
      return { updates, errors };
    }
    assertPageWithinCap(page, 'mainwp/list-updates-v1');
  }
}

export const startupDoctor: ScenarioDefinition = {
  id: 'startup-doctor',
  purpose: 'Prove the CLI starts, reaches the Dashboard, and emits a successful JSON envelope.',
  kind: 'read',
  targets: ['fixture', 'live'],
  async run(ctx) {
    const result = await ctx.cli.run(['doctor', '--json']);
    const output = envelope(result.json);
    ctx.assert.equal('doctor exits successfully', result.exitCode, 0);
    ctx.assert.equal('doctor envelope succeeds', output.success, true);
  },
};

// Discovery only lists catalog entries whose name is a namespaced, versioned
// identifier (ABILITY_NAME_PATTERN in src/core/abilities-executor.ts); other
// entries — such as WordPress-core abilities without a -vN suffix — are
// skipped with a warning. The independent expectation applies the same rule.
const LISTABLE_ABILITY_NAME = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*-v[1-9]\d*$/;

export const abilitiesList: ScenarioDefinition = {
  id: 'abilities-list',
  purpose: 'Cross-check the CLI ability catalog count and full-name set against a direct read.',
  kind: 'read',
  targets: ['fixture', 'live'],
  async run(ctx) {
    const direct = await ctx.verifier.fetchCatalog();
    const listable = direct.filter(
      ability => typeof ability.name === 'string' && LISTABLE_ABILITY_NAME.test(ability.name)
    );
    const result = await ctx.cli.run(['abilities', 'list', '--json']);
    const output = envelope<{
      abilities: Array<{ name: string }>;
      total: number;
    }>(result.json);
    ctx.assert.equal('abilities list exits successfully', result.exitCode, 0);
    ctx.assert.equal('abilities list envelope succeeds', output.success, true);
    ctx.assert.equal('ability count matches direct catalog', output.data?.total, listable.length);
    ctx.assert.deepEqual(
      'full ability name set matches direct catalog',
      sorted((output.data?.abilities ?? []).map(ability => ability.name)),
      sorted(listable.map(ability => ability.name))
    );
  },
};

export const abilitiesInfo: ScenarioDefinition = {
  id: 'abilities-info',
  purpose: 'Cross-check CLI ability details against the independent catalog entry.',
  kind: 'read',
  targets: ['fixture', 'live'],
  async run(ctx) {
    const direct = (await ctx.verifier.fetchCatalog()).find(
      ability => ability.name === 'mainwp/list-sites-v1'
    );
    if (!direct) throw new Error('Independent catalog did not contain mainwp/list-sites-v1');
    const result = await ctx.cli.run([
      'abilities',
      'info',
      'mainwp/list-sites-v1',
      '--json',
    ]);
    const output = envelope<{
      name: string;
      label?: string;
      description?: string;
      category?: string;
      annotations?: Record<string, unknown>;
      inputSchema?: Record<string, unknown>;
      outputSchema?: Record<string, unknown>;
    }>(result.json);
    ctx.assert.equal('abilities info exits successfully', result.exitCode, 0);
    ctx.assert.equal('abilities info envelope succeeds', output.success, true);
    ctx.assert.equal('ability name matches catalog', output.data?.name, direct.name);
    ctx.assert.equal('ability label matches catalog', output.data?.label, direct.label);
    ctx.assert.equal('ability description matches catalog', output.data?.description, direct.description);
    ctx.assert.equal('ability category matches catalog', output.data?.category, direct.category);
    ctx.assert.deepEqual(
      'ability annotations match catalog',
      output.data?.annotations ?? {},
      direct.meta?.annotations ?? {}
    );
    ctx.assert.deepEqual('ability input schema matches catalog', output.data?.inputSchema, direct.input_schema);
    ctx.assert.deepEqual('ability output schema matches catalog', output.data?.outputSchema, direct.output_schema);
  },
};

export const listSitesCrossCheck: ScenarioDefinition = {
  id: 'list-sites-cross-check',
  purpose: 'Cross-check CLI site discovery against independent reads before and after it.',
  kind: 'read',
  targets: ['fixture', 'live'],
  async run(ctx) {
    const before = await ctx.verifier.listSites();
    const actual = await cliListAll<VerifiedSite>(ctx, 'mainwp/list-sites-v1');
    const after = await ctx.verifier.listSites();
    const actualIds = actual.map(site => site.id).sort((a, b) => a - b);
    const actualUrls = sorted(actual.map(site => site.url));
    ctx.assert.equal('site count matches first direct read', actual.length, before.length);
    ctx.assert.deepEqual(
      'site id set matches first direct read',
      actualIds,
      before.map(site => site.id).sort((a, b) => a - b)
    );
    ctx.assert.deepEqual('site URL set matches first direct read', actualUrls, sorted(before.map(site => site.url)));
    ctx.assert.equal('site count matches second direct read', actual.length, after.length);
    ctx.assert.deepEqual(
      'site id set matches second direct read',
      actualIds,
      after.map(site => site.id).sort((a, b) => a - b)
    );
    ctx.assert.deepEqual('site URL set matches second direct read', actualUrls, sorted(after.map(site => site.url)));
  },
};

export const countSitesConsistency: ScenarioDefinition = {
  id: 'count-sites-consistency',
  purpose: 'Verify the CLI count-sites result equals an independent direct count.',
  kind: 'read',
  targets: ['fixture', 'live'],
  async run(ctx) {
    const direct = await ctx.verifier.countSites();
    const actual = await runAbility<{ total: number }>(ctx, 'mainwp/count-sites-v1');
    ctx.assert.equal('CLI and independent site counts match', actual.total, direct);
  },
};

export const getSite: ScenarioDefinition = {
  id: 'get-site',
  purpose: 'Verify a discovered site detail response against an independent read.',
  kind: 'read',
  targets: ['fixture', 'live'],
  async run(ctx) {
    const sites = await ctx.verifier.listSites();
    const site = sites[0];
    if (!site) throw new Error('No sites were available');
    const direct = await ctx.verifier.getSite(site.id);
    const actual = await runAbility<VerifiedSite>(ctx, 'mainwp/get-site-v1', {
      site_id_or_domain: site.id,
    });
    ctx.assert.equal('site id matches', actual.id, direct.id);
    ctx.assert.equal('site URL matches', actual.url, direct.url);
    ctx.assert.equal('site name matches', actual.name, direct.name);
  },
};

export const sitePlugins: ScenarioDefinition = {
  id: 'site-plugins',
  purpose: 'Verify a site plugin inventory and a known slug against an independent read.',
  kind: 'read',
  targets: ['fixture', 'live'],
  async run(ctx) {
    let selected: { site: VerifiedSite; plugins: VerifiedPluginResponse } | undefined;
    for (const site of await ctx.verifier.listSites()) {
      const plugins = await ctx.verifier.getSitePlugins(site.id);
      if (plugins.plugins.length > 0) {
        selected = { site, plugins };
        break;
      }
    }
    if (!selected) throw new Error('No site with plugins was available for the scenario');
    const actual = await runAbility<VerifiedPluginResponse>(ctx, 'mainwp/get-site-plugins-v1', {
      site_id_or_domain: selected.site.id,
    });
    ctx.assert.deepEqual(
      'plugin inventory matches',
      sorted(actual.plugins.map(plugin => `${plugin.slug}:${plugin.active}`)),
      sorted(selected.plugins.plugins.map(plugin => `${plugin.slug}:${plugin.active}`))
    );
    const knownPlugin = selected.plugins.plugins[0];
    if (!knownPlugin) throw new Error('Selected plugin inventory was unexpectedly empty');
    const knownSlug = knownPlugin.slug;
    ctx.assert.includes('known plugin slug is present', actual.plugins.map(plugin => plugin.slug), knownSlug);
    if (ctx.config.target === 'fixture') {
      ctx.assert.includes('fixture includes Hello Dolly', actual.plugins.map(plugin => plugin.slug), 'hello.php');
    }
  },
};

export const siteThemes: ScenarioDefinition = {
  id: 'site-themes',
  purpose: 'Cross-check a connected site theme inventory against an independent direct read.',
  kind: 'read',
  targets: ['live'],
  preconditions: connectedSitePrecondition,
  async run(ctx) {
    const site = selectedSite(ctx.state);
    const direct = (await ctx.verifier.execute('mainwp/get-site-themes-v1', {
      site_id_or_domain: site.id,
    })) as ThemeResponse;
    const actual = await runAbility<ThemeResponse>(ctx, 'mainwp/get-site-themes-v1', {
      site_id_or_domain: site.id,
    });
    ctx.assert.equal('theme site id matches', actual.site_id, direct.site_id);
    ctx.assert.equal('theme site URL matches', actual.site_url, direct.site_url);
    ctx.assert.equal('active theme matches', actual.active_theme, direct.active_theme);
    ctx.assert.equal('theme total matches', actual.total, direct.total);
    ctx.assert.deepEqual(
      'theme inventory matches',
      sorted(actual.themes.map(themeSignature)),
      sorted(direct.themes.map(themeSignature))
    );
  },
};

export const listUpdatesCrossCheck: ScenarioDefinition = {
  id: 'list-updates-cross-check',
  purpose: 'Cross-check updates against independent direct reads that bracket the CLI snapshot.',
  kind: 'read',
  targets: ['live'],
  preconditions: connectedSitePrecondition,
  async run(ctx) {
    const site = selectedSite(ctx.state);
    const before = await verifierListUpdates(ctx, site.id);
    const actual = await cliListUpdates(ctx, site.id);
    const after = await verifierListUpdates(ctx, site.id);
    const beforeSignatures = sorted(before.updates.map(updateSignature));
    const actualSignatures = sorted(actual.updates.map(updateSignature));
    const afterSignatures = sorted(after.updates.map(updateSignature));
    const directUnion = new Set([...beforeSignatures, ...afterSignatures]);
    const directIntersection = beforeSignatures.filter(signature => afterSignatures.includes(signature));
    const actualSet = new Set(actualSignatures);
    const oracleUnchanged = JSON.stringify(beforeSignatures) === JSON.stringify(afterSignatures);
    ctx.assert.equal('bracketing direct update reads have no site errors', before.errors.length + after.errors.length, 0);
    ctx.assert.equal('CLI update read has no site errors', actual.errors.length, 0);
    ctx.assert.equal(
      'CLI updates are covered by the bracketing direct reads',
      actualSignatures.every(signature => directUnion.has(signature)),
      true
    );
    ctx.assert.equal(
      'updates stable across direct reads are present through CLI',
      directIntersection.every(signature => actualSet.has(signature)),
      true
    );
    ctx.assert.equal(
      'CLI updates match an unchanged direct snapshot',
      oracleUnchanged ? JSON.stringify(actualSignatures) : 'changed',
      oracleUnchanged ? JSON.stringify(beforeSignatures) : 'changed'
    );
  },
};

export const listTagsCrossCheck: ScenarioDefinition = {
  id: 'list-tags-cross-check',
  purpose: 'Cross-check the complete CLI tag list against an independent direct list-tags read.',
  kind: 'read',
  targets: ['live'],
  async run(ctx) {
    const direct = await verifierListAll<Tag>(ctx, 'mainwp/list-tags-v1');
    const actual = await cliListAll<Tag>(ctx, 'mainwp/list-tags-v1');
    ctx.assert.equal('tag count matches the direct list', actual.length, direct.length);
    ctx.assert.deepEqual(
      'tag inventory matches the direct list',
      sorted(actual.map(tagSignature)),
      sorted(direct.map(tagSignature))
    );
  },
};

export const readScenarios: ScenarioDefinition[] = [
  startupDoctor,
  abilitiesList,
  abilitiesInfo,
  listSitesCrossCheck,
  countSitesConsistency,
  getSite,
  sitePlugins,
  siteThemes,
  listUpdatesCrossCheck,
  listTagsCrossCheck,
];
