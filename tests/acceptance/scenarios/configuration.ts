import type { ScenarioDefinition } from './types.js';

export const packedIntegrity: ScenarioDefinition = {
  id: 'packed-integrity',
  purpose: 'Surface tarball content, installed-bin, and installed-version assertions.',
  kind: 'read',
  targets: ['fixture', 'live'],
  preconditions: ctx =>
    ctx.mode === 'packed'
      ? {}
      : { status: 'skipped', reason: 'packed-integrity applies only to --mode packed.' },
  async run(ctx) {
    if (!ctx.packedPackage) throw new Error('Packed package metadata was unavailable');
    for (const [name, value] of Object.entries(ctx.packedPackage.checks)) {
      ctx.assert.equal(name, value, true);
    }
    ctx.assert.equal(
      'installed binary version output matches package version',
      ctx.packedPackage.versionOutput.includes(ctx.config.packageVersion),
      true
    );
    ctx.assert.truthy('tarball sha256 recorded', /^[a-f0-9]{64}$/.test(ctx.packedPackage.sha256));
    ctx.assert.truthy('npm integrity recorded', ctx.packedPackage.integrity.startsWith('sha512-'));
  },
};

export const configurationScenarios: ScenarioDefinition[] = [packedIntegrity];
