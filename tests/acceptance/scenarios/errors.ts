import { FIXTURE_SITE_ID } from '../fixtures.js';
import type { ScenarioDefinition, ScenarioPreconditionContext } from './types.js';

interface ErrorEnvelope {
  success: boolean;
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
}

function errorEnvelope(value: unknown): ErrorEnvelope {
  if (!value || typeof value !== 'object') throw new Error('CLI did not return a JSON envelope');
  return value as ErrorEnvelope;
}

function requestInput(request: { body: unknown }): Record<string, unknown> {
  if (!request.body || typeof request.body !== 'object') return {};
  const input = (request.body as Record<string, unknown>).input;
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
}

async function destructiveSitePrecondition(ctx: ScenarioPreconditionContext) {
  if (ctx.target === 'fixture') return { state: { siteId: FIXTURE_SITE_ID } };
  const sites = await ctx.verifier.listSites();
  if (sites.length === 0) {
    return { status: 'skipped' as const, reason: 'No site was available for the safety check.' };
  }
  const site = sites[0];
  if (!site) throw new Error('Site discovery returned an inconsistent empty result');
  return { state: { siteId: site.id } };
}

export const notFoundInput: ScenarioDefinition = {
  id: 'not-found-input',
  purpose: 'Require a structured CLI error for a nonexistent site identifier.',
  kind: 'read',
  targets: ['fixture', 'live'],
  async run(ctx) {
    const result = await ctx.cli.run([
      'abilities',
      'run',
      'mainwp/get-site-v1',
      '--input',
      JSON.stringify({ site_id_or_domain: 99_999_999 }),
      '--json',
    ]);
    const output = errorEnvelope(result.json);
    ctx.assert.equal('not-found envelope fails', output.success, false);
    if (ctx.config.target === 'live') {
      // A live Dashboard answers a missing site id with HTTP 403, which this
      // CLI classifies as an authorization failure rather than a lookup miss.
      ctx.assert.equal('not-found exits with auth error', result.exitCode, 2);
      ctx.assert.equal('not-found classification', output.error?.code, 'AUTH_ERROR');
    } else {
      ctx.assert.equal('not-found exits with API error', result.exitCode, 4);
      ctx.assert.equal('not-found classification', output.error?.code, 'NOT_FOUND');
    }
  },
};

export const invalidArgs: ScenarioDefinition = {
  id: 'invalid-args',
  purpose: 'Reject schema-invalid ability input with the stable input-error exit code.',
  kind: 'read',
  targets: ['fixture', 'live'],
  async run(ctx) {
    const result = await ctx.cli.run([
      'abilities',
      'run',
      'mainwp/count-sites-v1',
      '--input',
      JSON.stringify({ tag_ids: 'not-an-array' }),
      '--json',
    ]);
    const output = errorEnvelope(result.json);
    ctx.assert.equal('invalid args exit with input error', result.exitCode, 1);
    ctx.assert.equal('invalid args envelope fails', output.success, false);
    ctx.assert.equal('invalid args classification', output.error?.code, 'SCHEMA_VALIDATION_ERROR');
  },
};

export const unknownAbility: ScenarioDefinition = {
  id: 'unknown-ability',
  purpose: 'Reject an ability absent from discovery with the documented CLI contract.',
  kind: 'read',
  targets: ['fixture', 'live'],
  async run(ctx) {
    const result = await ctx.cli.run([
      'abilities',
      'run',
      'mainwp/does-not-exist-v1',
      '--json',
    ]);
    const output = errorEnvelope(result.json);
    ctx.assert.equal('unknown ability exits with input error', result.exitCode, 1);
    ctx.assert.equal('unknown ability envelope fails', output.success, false);
    ctx.assert.equal('unknown ability classification', output.error?.code, 'INPUT_ERROR');
    ctx.assert.equal(
      'unknown ability message documents absence',
      /ability not found/i.test(output.error?.message ?? ''),
      true
    );
  },
};

export const nonInteractiveDestructiveWithoutForce: ScenarioDefinition = {
  id: 'non-interactive-destructive-without-force',
  purpose: 'Refuse destructive confirmation in a non-TTY process unless --force is explicit.',
  kind: 'read',
  targets: ['fixture', 'live'],
  preconditions: destructiveSitePrecondition,
  async run(ctx) {
    const siteId = ctx.state.siteId;
    if (typeof siteId !== 'number') throw new Error('Safety precondition did not provide a site id');
    const result = await ctx.cli.run([
      'abilities',
      'run',
      'mainwp/delete-site-v1',
      '--input',
      JSON.stringify({ site_id_or_domain: siteId }),
      '--confirm',
      '--json',
    ]);
    const output = errorEnvelope(result.json);
    ctx.assert.equal('non-interactive destructive call exits with input error', result.exitCode, 1);
    ctx.assert.equal('non-interactive destructive envelope fails', output.success, false);
    ctx.assert.equal('non-interactive destructive classification', output.error?.code, 'INPUT_ERROR');
    ctx.assert.equal(
      'non-interactive destructive message requires force',
      /interactive|force/i.test(output.error?.message ?? ''),
      true
    );
    if (ctx.config.target === 'fixture') {
      if (!ctx.mockServer) throw new Error('Fixture scenario did not receive a MockServer');
      const confirmRequests = ctx.mockServer
        .getRecordedRequests()
        .filter(request => request.path.includes('mainwp/delete-site-v1/run'))
        .filter(request => requestInput(request).confirm === true);
      ctx.assert.equal('no confirm-true execution reached the fixture', confirmRequests.length, 0);
    }
  },
};

export const errorScenarios: ScenarioDefinition[] = [
  notFoundInput,
  invalidArgs,
  unknownAbility,
  nonInteractiveDestructiveWithoutForce,
];
