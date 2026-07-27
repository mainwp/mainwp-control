import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Artifacts } from './artifacts.js';
import type { CommandRunner } from './commands.js';
import { startLocalDependencyRegistry } from './local-registry.js';

interface NpmPackResult {
  filename: string;
  shasum: string;
  integrity: string;
}

function parseNpmPackOutput(stdout: string): NpmPackResult[] {
  const trimmed = stdout.trim();
  const jsonStart = trimmed.lastIndexOf('\n[');
  return JSON.parse(jsonStart === -1 ? trimmed : trimmed.slice(jsonStart + 1)) as NpmPackResult[];
}

export interface PackChecks {
  requiredFilesPresent: boolean;
  forbiddenFilesAbsent: boolean;
  installedBinPresent: boolean;
  installedVersionMatches: boolean;
  versionCommandMatches: boolean;
}

export interface PackedPackage {
  tempRoot: string;
  consumerDir: string;
  tarballPath: string;
  filename: string;
  sha256: string;
  npmShasum: string;
  integrity: string;
  binPath: string;
  version: string;
  versionOutput: string;
  checks: PackChecks;
  cleanup(): void;
}

function hasForbiddenEntry(entry: string): boolean {
  return entry.startsWith('package/src/') ||
    entry.startsWith('package/tests/') ||
    entry.startsWith('package/.mwpdev/') ||
    entry === 'package/src' ||
    entry === 'package/tests' ||
    entry === 'package/.mwpdev' ||
    /^package\/\.env(?:\.|$)/.test(entry) ||
    /(?:^|\/)[^/]*\.test\.[^/]+$/.test(entry);
}

export async function packAndInstall(
  repoRoot: string,
  runner: CommandRunner,
  artifacts: Artifacts,
  keepConsumer: boolean,
): Promise<PackedPackage> {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mainwp-control-acceptance-'));
  try {
    const packCache = path.join(tempRoot, 'pack-npm-cache');
    fs.mkdirSync(packCache);
    const packResult = await runner.run(
      ['npm', 'pack', '--json', '--pack-destination', tempRoot],
      repoRoot,
      { env: { ...process.env, npm_config_cache: packCache } },
    );
    const parsed = parseNpmPackOutput(packResult.stdout);
    if (parsed.length !== 1 || !parsed[0]) {
      throw new Error(`npm pack produced ${parsed.length} package records`);
    }
    const packed = parsed[0];
    const tarballPath = path.join(tempRoot, packed.filename);
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(tarballPath)).digest('hex');
    const listingResult = await runner.run(['tar', '-tzf', tarballPath], repoRoot);
    const entries = listingResult.stdout.split(/\r?\n/).filter(Boolean);
    const entrySet = new Set(entries);
    const requiredFilesPresent =
      entrySet.has('package/bin/run.js') &&
      entrySet.has('package/oclif.manifest.json') &&
      entries.some(entry => entry.startsWith('package/dist/')) &&
      entries.some(entry => entry.startsWith('package/scripts/completions/'));
    const forbiddenFilesAbsent = entries.every(entry => !hasForbiddenEntry(entry));
    if (!requiredFilesPresent || !forbiddenFilesAbsent) {
      throw new Error(
        `Packed tarball content assertions failed: ${JSON.stringify({
          requiredFilesPresent,
          forbiddenFilesAbsent,
        })}`,
      );
    }

    const consumerDir = path.join(tempRoot, 'consumer');
    fs.mkdirSync(consumerDir);
    const npmCache = path.join(tempRoot, 'npm-cache');
    fs.mkdirSync(npmCache);
    await runner.run(['npm', 'init', '-y'], consumerDir, {
      env: { ...process.env, npm_config_cache: npmCache },
    });

    // The stub registry serves only the versions pinned in the repo lock, and
    // npm overrides do not propagate to dependents, so a bare consumer resolves
    // ranges the lock has overridden away (filelist -> minimatch@^5) and the
    // install 404s. Mirror the root overrides into the consumer manifest so its
    // resolution stays inside what the stub can serve.
    const repoManifest = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
    ) as { overrides?: Record<string, unknown> };
    if (repoManifest.overrides) {
      const consumerManifestPath = path.join(consumerDir, 'package.json');
      const consumerManifest = JSON.parse(
        fs.readFileSync(consumerManifestPath, 'utf8'),
      ) as Record<string, unknown>;
      consumerManifest['overrides'] = repoManifest.overrides;
      fs.writeFileSync(consumerManifestPath, `${JSON.stringify(consumerManifest, null, 2)}\n`);
    }

    const registry = await startLocalDependencyRegistry(repoRoot, tempRoot, runner);
    try {
      await runner.run(
        [
          'npm',
          'install',
          tarballPath,
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          '--registry',
          registry.url,
        ],
        consumerDir,
        { env: { ...process.env, npm_config_cache: npmCache } },
      );
    } finally {
      await registry.close();
    }

    const packageDir = path.join(consumerDir, 'node_modules', '@mainwp', 'control');
    const binLink = path.join(consumerDir, 'node_modules', '.bin', 'mainwpcontrol');
    const installedBinPresent = fs.existsSync(binLink);
    const binPath = binLink;
    const installedPackage = JSON.parse(
      fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'),
    ) as { version: string };
    const repoPackage = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
    ) as { version: string };
    const versionResult = await runner.run([binPath, '--version'], consumerDir);
    const versionOutput = versionResult.stdout.trim();
    const checks: PackChecks = {
      requiredFilesPresent,
      forbiddenFilesAbsent,
      installedBinPresent,
      installedVersionMatches: installedPackage.version === repoPackage.version,
      versionCommandMatches: versionOutput.includes(repoPackage.version),
    };
    if (Object.values(checks).some(check => !check)) {
      throw new Error(`Installed package assertions failed: ${JSON.stringify(checks)}`);
    }
    artifacts.setTarball({
      filename: packed.filename,
      sha256,
      integrity: packed.integrity,
    });

    return {
      tempRoot,
      consumerDir,
      tarballPath,
      filename: packed.filename,
      sha256,
      npmShasum: packed.shasum,
      integrity: packed.integrity,
      binPath,
      version: installedPackage.version,
      versionOutput,
      checks,
      cleanup: () => {
        if (!keepConsumer) fs.rmSync(tempRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
}
