import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLogger } from './audit-logger.js';

describe('AuditLogger permissions', () => {
  const originalXdgConfigHome = process.env['XDG_CONFIG_HOME'];
  let tempRoot: string | undefined;

  afterEach(async () => {
    if (originalXdgConfigHome === undefined) {
      delete process.env['XDG_CONFIG_HOME'];
    } else {
      process.env['XDG_CONFIG_HOME'] = originalXdgConfigHome;
    }

    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
      tempRoot = undefined;
    }
  });

  it('self-heals loose config directory and audit log permissions', async () => {
    tempRoot = await fs.mkdtemp(join(tmpdir(), 'mainwp-audit-'));
    process.env['XDG_CONFIG_HOME'] = tempRoot;

    const configDir = join(tempRoot, 'mainwpcontrol');
    const logPath = join(configDir, 'audit.log');
    await fs.mkdir(configDir, { mode: 0o755 });
    await fs.chmod(configDir, 0o755);
    await fs.writeFile(logPath, '', { mode: 0o644 });
    await fs.chmod(logPath, 0o644);

    await new AuditLogger().logDestructiveAction({
      abilityName: 'mainwp/delete-site-v1',
      userDecision: 'approved',
      input: { site_id: 123 },
    });

    expect((await fs.stat(configDir)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(logPath)).mode & 0o777).toBe(0o600);
  });
});
