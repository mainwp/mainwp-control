import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { CommandRunner } from './commands.js';

interface PackedDependency {
  name: string;
  version: string;
  filename: string;
  shasum: string;
  integrity: string;
}

interface RegistryVersion {
  packed: PackedDependency;
  packageJson: Record<string, unknown>;
}

export interface LocalRegistry {
  url: string;
  close(): Promise<void>;
}

function json(response: http.ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(encoded),
  });
  response.end(encoded);
}

export async function startLocalDependencyRegistry(
  repoRoot: string,
  tempRoot: string,
  runner: CommandRunner
): Promise<LocalRegistry> {
  const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8')) as {
    packages: Record<string, { dev?: boolean }>;
  };
  const packagePaths = Object.entries(lock.packages)
    .filter(([packagePath, metadata]) => packagePath.startsWith('node_modules/') && !metadata.dev)
    .map(([packagePath]) => path.join(repoRoot, packagePath))
    .filter(packagePath => fs.existsSync(path.join(packagePath, 'package.json')));
  const tarballDir = path.join(tempRoot, 'dependency-tarballs');
  fs.mkdirSync(tarballDir, { recursive: true });
  const packedResult = await runner.run(
    [
      'npm',
      'pack',
      '--ignore-scripts',
      '--json',
      '--pack-destination',
      tarballDir,
      ...packagePaths,
    ],
    repoRoot
  );
  const packed = JSON.parse(packedResult.stdout) as PackedDependency[];
  const packageMetadata = new Map<string, Record<string, unknown>>();
  for (const packagePath of packagePaths) {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(packagePath, 'package.json'), 'utf8')
    ) as Record<string, unknown>;
    const name = packageJson['name'];
    const version = packageJson['version'];
    if (typeof name === 'string' && typeof version === 'string') {
      packageMetadata.set(`${name}@${version}`, packageJson);
    }
  }
  const byName = new Map<string, Map<string, RegistryVersion>>();
  for (const dependency of packed) {
    const packageJson = packageMetadata.get(`${dependency.name}@${dependency.version}`);
    if (!packageJson) {
      throw new Error(`Packed dependency metadata was not found for ${dependency.name}@${dependency.version}`);
    }
    const versions = byName.get(dependency.name) ?? new Map<string, RegistryVersion>();
    versions.set(dependency.version, { packed: dependency, packageJson });
    byName.set(dependency.name, versions);
  }

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname.startsWith('/tarballs/')) {
      const filename = path.basename(decodeURIComponent(url.pathname.slice('/tarballs/'.length)));
      const filePath = path.join(tarballDir, filename);
      if (!fs.existsSync(filePath)) return json(response, 404, { error: 'tarball not found' });
      const stat = fs.statSync(filePath);
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': stat.size,
      });
      fs.createReadStream(filePath).pipe(response);
      return;
    }

    const name = decodeURIComponent(url.pathname.slice(1));
    const versions = byName.get(name);
    if (!versions) return json(response, 404, { error: `package ${name} not found` });
    const address = server.address();
    if (!address || typeof address === 'string') {
      return json(response, 500, { error: 'registry is not bound' });
    }
    const registryVersions = Object.fromEntries(
      [...versions.entries()].map(([version, { packed: dependency, packageJson }]) => {
        const tarballUrl = `http://127.0.0.1:${address.port}/tarballs/${encodeURIComponent(
          dependency.filename
        )}`;
        return [version, {
          ...packageJson,
          dist: {
            tarball: tarballUrl,
            shasum: dependency.shasum,
            integrity:
              dependency.integrity ||
              `sha512-${crypto
                .createHash('sha512')
                .update(fs.readFileSync(path.join(tarballDir, dependency.filename)))
                .digest('base64')}`,
          },
        }];
      })
    );
    const latest = [...versions.keys()]
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
      .at(-1);
    if (!latest) return json(response, 500, { error: `package ${name} has no versions` });
    json(response, 200, {
      _id: name,
      name,
      'dist-tags': { latest },
      versions: registryVersions,
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local registry failed to bind');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
      }),
  };
}
