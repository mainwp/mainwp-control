import { FIXTURE_SITE_ID, programFixtureServer } from '../fixtures.js';
import type { ScenarioDefinition } from './types.js';

interface CLIEnvelope<T = unknown> {
  success: boolean;
  data?: T;
  error?: { code?: string; message?: string };
}

interface SafetyOutput {
  mode?: string;
  ability?: string;
  success?: boolean;
  preview?: {
    affected?: unknown[];
    summary?: string;
  };
}

function envelope<T>(value: unknown): CLIEnvelope<T> {
  if (!value || typeof value !== 'object') throw new Error('CLI did not return a JSON envelope');
  return value as CLIEnvelope<T>;
}

function requestInput(request: { body: unknown }): Record<string, unknown> {
  if (!request.body || typeof request.body !== 'object') return {};
  const input = (request.body as Record<string, unknown>).input;
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
}

function deleteRequests(ctx: Parameters<ScenarioDefinition['run']>[0]) {
  if (!ctx.mockServer) throw new Error('Fixture scenario did not receive a MockServer');
  return ctx.mockServer
    .getRecordedRequests()
    .filter(request => request.path.includes('mainwp/delete-site-v1/run'));
}

function deleteArgs(...flags: string[]): string[] {
  return [
    'abilities',
    'run',
    'mainwp/delete-site-v1',
    '--input',
    JSON.stringify({ site_id_or_domain: FIXTURE_SITE_ID }),
    ...flags,
    '--json',
  ];
}

export const dryRunPreview: ScenarioDefinition = {
  id: 'dry-run-preview',
  purpose: 'Prove a destructive dry run previews exactly once and never confirms.',
  kind: 'read',
  targets: ['fixture'],
  async run(ctx) {
    const result = await ctx.cli.run(deleteArgs('--dry-run'));
    const output = envelope<SafetyOutput>(result.json);
    const requests = deleteRequests(ctx);
    const dryRuns = requests.filter(request => requestInput(request).dry_run === true);
    const confirms = requests.filter(request => requestInput(request).confirm === true);
    ctx.assert.equal('dry run exits successfully', result.exitCode, 0);
    ctx.assert.equal('dry run envelope succeeds', output.success, true);
    ctx.assert.equal('dry run reports preview mode', output.data?.mode, 'preview');
    ctx.assert.equal('dry run ability succeeds', output.data?.success, true);
    ctx.assert.truthy('dry run includes a preview summary', output.data?.preview?.summary);
    ctx.assert.equal('exactly one delete request reached the fixture in total', requests.length, 1);
    ctx.assert.equal('exactly one dry-run request reached the fixture', dryRuns.length, 1);
    ctx.assert.equal('no confirm request reached the fixture', confirms.length, 0);
    ctx.assert.equal('dry-run request uses POST', dryRuns[0]?.method, 'POST');
    ctx.assert.equal('dry-run request retains the site id', requestInput(dryRuns[0] ?? { body: undefined }).site_id_or_domain, FIXTURE_SITE_ID);
    ctx.assert.equal('dry-run request omits user_confirmed', requestInput(dryRuns[0] ?? { body: undefined }).user_confirmed, undefined);
  },
};

export const previewThenConfirm: ScenarioDefinition = {
  id: 'preview-then-confirm',
  purpose: 'Prove force skips only the prompt: preview first, then exactly one confirmation.',
  // 'write': the scenario completes a confirmed deletion. It only ever runs
  // against the fixture (the write guard passes fixture targets through),
  // but if a live target is ever added, the guard must apply.
  kind: 'write',
  targets: ['fixture'],
  async run(ctx) {
    const result = await ctx.cli.run(deleteArgs('--confirm', '--force'));
    const output = envelope<SafetyOutput>(result.json);
    const requests = deleteRequests(ctx);
    const dryRuns = requests.filter(request => requestInput(request).dry_run === true);
    const confirms = requests.filter(request => requestInput(request).confirm === true);
    ctx.assert.equal('confirmed destructive flow exits successfully', result.exitCode, 0);
    ctx.assert.equal('confirmed destructive envelope succeeds', output.success, true);
    ctx.assert.equal('confirmed destructive flow reports execute mode', output.data?.mode, 'execute');
    ctx.assert.equal('confirmed destructive ability succeeds', output.data?.success, true);
    ctx.assert.truthy('confirmed destructive flow includes preview', output.data?.preview);
    ctx.assert.equal('exactly two delete requests reached the fixture', requests.length, 2);
    ctx.assert.equal('exactly one preview request reached the fixture', dryRuns.length, 1);
    ctx.assert.equal('exactly one confirm request reached the fixture', confirms.length, 1);
    ctx.assert.equal('preview request is first', requestInput(requests[0] ?? { body: undefined }).dry_run, true);
    ctx.assert.equal('confirm request is second', requestInput(requests[1] ?? { body: undefined }).confirm, true);
    ctx.assert.equal('confirm request records user confirmation', requestInput(confirms[0] ?? { body: undefined }).user_confirmed, true);
    ctx.assert.equal('confirm request retains the site id', requestInput(confirms[0] ?? { body: undefined }).site_id_or_domain, FIXTURE_SITE_ID);
  },
};

export const previewFailureFailsClosed: ScenarioDefinition = {
  id: 'preview-failure-fails-closed',
  purpose: 'Prove a failed destructive preview returns PREVIEW_FAILED and never confirms.',
  // 'write': the invocation requests a confirmed deletion; only the fixture's
  // programmed preview failure keeps it from executing.
  kind: 'write',
  targets: ['fixture'],
  async run(ctx) {
    if (!ctx.mockServer) throw new Error('Fixture scenario did not receive a MockServer');
    await programFixtureServer(ctx.mockServer, { previewFailure: true });
    const result = await ctx.cli.run(deleteArgs('--confirm', '--force'));
    const output = envelope(result.json);
    const requests = deleteRequests(ctx);
    const dryRuns = requests.filter(request => requestInput(request).dry_run === true);
    const confirms = requests.filter(request => requestInput(request).confirm === true);
    ctx.assert.equal('preview failure exits with API error', result.exitCode, 4);
    ctx.assert.equal('preview failure envelope fails', output.success, false);
    ctx.assert.equal('preview failure classification', output.error?.code, 'PREVIEW_FAILED');
    ctx.assert.equal('preview failure message identifies preview', /preview/i.test(output.error?.message ?? ''), true);
    ctx.assert.equal('exactly one delete request reached the fixture in total', requests.length, 1);
    ctx.assert.equal('exactly one failed preview reached the fixture', dryRuns.length, 1);
    ctx.assert.equal('failed preview sends no confirm request', confirms.length, 0);
  },
};

export const safetyScenarios: ScenarioDefinition[] = [
  dryRunPreview,
  previewThenConfirm,
  previewFailureFailsClosed,
];
