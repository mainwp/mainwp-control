/**
 * Filesystem utilities for secure config file operations
 *
 * Provides atomic write with restricted permissions for config files.
 */

import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';

/**
 * Write content to a file atomically with restricted permissions.
 *
 * Creates the parent directory (mode 0o700) if needed, writes to a
 * temporary file (mode 0o600), then renames. Cleans up the temp file
 * on rename failure.
 */
export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const dir = dirname(filePath);
  const tmpPath = `${filePath}.${randomBytes(12).toString('hex')}.tmp`;

  await fs.mkdir(dir, { recursive: true, mode: 0o700 });

  let temporaryFileCreated = false;
  try {
    await fs.writeFile(tmpPath, content, {
      encoding: 'utf-8',
      mode: 0o600,
      flag: 'wx',
    });
    temporaryFileCreated = true;
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    if (temporaryFileCreated) {
      await fs.unlink(tmpPath).catch(() => {});
    }
    throw error;
  }
}
