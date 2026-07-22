import type { VerifiedSite } from '../lib/verify.js';
import type { ScenarioDefinition } from './types.js';

interface CLIEnvelope<T = unknown> {
  success: boolean;
  data?: T;
  error?: { code?: string; message?: string };
}

interface AbilityExecution {
  success?: boolean;
}

interface SelectedPlugin {
  site: VerifiedSite;
  slug: string;
  active: boolean;
}

function envelope<T>(value: unknown): CLIEnvelope<T> {
  if (!value || typeof value !== 'object') throw new Error('CLI did not return a JSON envelope');
  return value as CLIEnvelope<T>;
}

async function waitForSyncAdvance(
  ctx: Parameters<ScenarioDefinition['run']>[0],
  siteId: number,
  before: string | null | undefined
): Promise<string | null | undefined> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const current = await ctx.verifier.getSite(siteId);
    if (current.last_sync && current.last_sync !== before) return current.last_sync;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return (await ctx.verifier.getSite(siteId)).last_sync;
}

async function findTogglePlugin(
  ctx: Parameters<NonNullable<ScenarioDefinition['preconditions']>>[0]
): Promise<SelectedPlugin | null> {
  const preferred = process.env.MAINWP_CONTROL_ACCEPTANCE_TOGGLE_PLUGIN;
  const safeSlugs = [preferred, 'hello.php', 'hello-dolly/hello.php'].filter(
    (value): value is string => Boolean(value)
  );
  const inventories = await Promise.all(
    (await ctx.verifier.listSites()).map(async site => ({
      site,
      plugins: (await ctx.verifier.getSitePlugins(site.id)).plugins,
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

async function setPluginActive(
  ctx: Parameters<ScenarioDefinition['run']>[0],
  siteId: number,
  slug: string,
  active: boolean,
  recordAssertions = true
): Promise<void> {
  const abilityName = active
    ? 'mainwp/activate-site-plugins-v1'
    : 'mainwp/deactivate-site-plugins-v1';
  const result = await ctx.cli.run([
    'abilities',
    'run',
    abilityName,
    '--input',
    JSON.stringify({ site_id_or_domain: siteId, plugins: [slug] }),
    '--confirm',
    '--force',
    '--json',
  ]);
  const output = envelope<AbilityExecution>(result.json);
  if (recordAssertions) {
    ctx.assert.equal(`${abilityName} exits successfully`, result.exitCode, 0);
    ctx.assert.equal(`${abilityName} envelope succeeds`, output.success, true);
    ctx.assert.equal(`${abilityName} ability succeeds`, output.data?.success, true);
  }
  if (result.exitCode !== 0 || !output.success) {
    throw new Error(`${abilityName} failed: ${output.error?.message ?? result.stderr}`);
  }
}

export const syncSite: ScenarioDefinition = {
  id: 'sync-site',
  purpose: 'Sync one discovered site and independently verify its last-sync timestamp advances.',
  kind: 'write',
  targets: ['live'],
  async run(ctx) {
    const sites = await ctx.verifier.listSites();
    const site = sites[0];
    if (!site) throw new Error('No site was available to sync');
    const before = await ctx.verifier.getSite(site.id);
    const result = await ctx.cli.run([
      'abilities',
      'run',
      'mainwp/sync-sites-v1',
      '--input',
      JSON.stringify({ site_ids_or_domains: [site.id] }),
      '--json',
    ]);
    const output = envelope<AbilityExecution>(result.json);
    ctx.assert.equal('sync-site exits successfully', result.exitCode, 0);
    ctx.assert.equal('sync-site envelope succeeds', output.success, true);
    ctx.assert.equal('sync-site ability succeeds', output.data?.success, true);
    const after = await waitForSyncAdvance(ctx, site.id, before.last_sync);
    ctx.assert.truthy('last_sync advanced', after && after !== before.last_sync);
  },
};

export const pluginToggleRoundtrip: ScenarioDefinition = {
  id: 'plugin-toggle-roundtrip',
  purpose: 'Deactivate and reactivate an allowed plugin with independent state verification.',
  kind: 'write',
  targets: ['live'],
  preconditions: async ctx => {
    const catalog = await ctx.verifier.fetchCatalog();
    const requiredAbilities = [
      'mainwp/deactivate-site-plugins-v1',
      'mainwp/activate-site-plugins-v1',
    ];
    const missingAbilities = requiredAbilities.filter(
      name => !catalog.some(ability => ability.name === name)
    );
    if (missingAbilities.length > 0) {
      return {
        status: 'unverified',
        reason: `Required plugin roundtrip abilities are unavailable: ${missingAbilities.join(', ')}`,
      };
    }
    const plugin = await findTogglePlugin(ctx);
    if (!plugin?.active) {
      return { status: 'skipped', reason: 'No active allowed toggle plugin was discovered.' };
    }
    return { state: { plugin } };
  },
  async run(ctx) {
    const plugin = ctx.state.plugin as SelectedPlugin | undefined;
    if (!plugin) throw new Error('Plugin precondition did not provide a plugin');

    await setPluginActive(ctx, plugin.site.id, plugin.slug, false);
    const inactive = await ctx.verifier.getSitePlugins(plugin.site.id);
    ctx.assert.equal(
      'plugin is independently inactive',
      inactive.plugins.find(candidate => candidate.slug === plugin.slug)?.active,
      false
    );

    await setPluginActive(ctx, plugin.site.id, plugin.slug, true);
    const restored = await ctx.verifier.getSitePlugins(plugin.site.id);
    ctx.assert.equal(
      'plugin is independently active again',
      restored.plugins.find(candidate => candidate.slug === plugin.slug)?.active,
      true
    );
  },
  async cleanup(ctx) {
    const plugin = ctx.state.plugin as SelectedPlugin | undefined;
    if (!plugin) return;
    const current = await ctx.verifier.getSitePlugins(plugin.site.id);
    if (current.plugins.find(candidate => candidate.slug === plugin.slug)?.active === false) {
      await setPluginActive(ctx, plugin.site.id, plugin.slug, true, false);
    }
  },
};

export const writeScenarios: ScenarioDefinition[] = [syncSite, pluginToggleRoundtrip];
