import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:crypto', () => ({
  randomBytes: () => Buffer.from('fixed-temp-suffix'),
}));

import { atomicWriteFile } from './fs-utils.js';

describe('atomicWriteFile', () => {
  const createdDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(createdDirectories.splice(0).map((dir) => fs.rm(dir, {
      recursive: true,
      force: true,
    })));
  });

  it.skipIf(process.platform === 'win32')(
    'refuses to follow an existing symlink at the randomized temporary path',
    async () => {
      const dir = await fs.mkdtemp(join(tmpdir(), 'mainwpcontrol-fs-utils-'));
      createdDirectories.push(dir);
      const target = join(dir, 'target');
      const filePath = join(dir, 'settings.json');
      const suffix = Buffer.from('fixed-temp-suffix').toString('hex');
      const tmpPath = `${filePath}.${suffix}.tmp`;
      await fs.writeFile(target, 'unchanged', 'utf8');
      await fs.symlink(target, tmpPath);

      await expect(atomicWriteFile(filePath, 'replacement')).rejects.toMatchObject({ code: 'EEXIST' });
      await expect(fs.readFile(target, 'utf8')).resolves.toBe('unchanged');
    },
  );
});
