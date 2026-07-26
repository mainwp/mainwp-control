/**
 * Tests for URL-credential masking in the profile commands.
 *
 * Profiles saved before userinfo rejection was added may still carry
 * `user:pass@` in the stored dashboard URL, and the load path deliberately
 * accepts them. Every display path must mask it — these pin `profile use`
 * (JSON envelope) and `profile list` (JSON envelope + human table).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config/profile-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config/profile-store.js')>()),
  getProfileStore: vi.fn(),
}));

import { getProfileStore } from '../../config/profile-store.js';
import ProfileUse from './use.js';
import ProfileList from './list.js';

const CREDENTIALED_URL = 'https://legacy:s3cr3t@dashboard.example.com';

const mockConfig = {
  root: '/mock/root',
  bin: 'mainwpcontrol',
  name: 'mainwpcontrol',
  version: '1.0.0',
  pjson: { name: 'mainwpcontrol', version: '1.0.0' },
  dataDir: '/mock/data',
  cacheDir: '/mock/cache',
  configDir: '/mock/config',
  findCommand: vi.fn(),
  runCommand: vi.fn(),
  runHook: vi.fn(),
};

/**
 * Drive a command's real output() path with a captured logger, skipping the
 * full oclif lifecycle (same approach as jobs/watch.test.ts).
 */
function emit<T extends ProfileUse | ProfileList>(
  command: T,
  json: boolean,
  data: unknown,
  humanFormatter?: () => string
): string {
  const log = vi.fn();
  command.log = log;
  (command as unknown as { jsonOutput: boolean }).jsonOutput = json;
  (
    command as unknown as { output(d: unknown, h?: () => string): void }
  ).output(data, humanFormatter);

  return log.mock.calls.map((call) => String(call[0])).join('\n');
}

describe('profile use masks embedded URL credentials', () => {
  beforeEach(() => {
    vi.mocked(getProfileStore).mockReturnValue({
      get: vi.fn().mockResolvedValue({
        name: 'legacy',
        dashboardUrl: CREDENTIALED_URL,
        username: 'admin',
      }),
      setActive: vi.fn().mockResolvedValue(undefined),
    } as never);
  });

  it('masks the url in the --json envelope', async () => {
    const command = new ProfileUse([], mockConfig as never);
    vi.spyOn(command, 'parse' as never).mockResolvedValue({
      args: { name: 'legacy' },
      flags: {},
    } as never);
    vi.spyOn(
      command as unknown as { initCommon(f: unknown): Promise<void> },
      'initCommon'
    ).mockResolvedValue(undefined);

    const log = vi.fn();
    command.log = log;
    (command as unknown as { jsonOutput: boolean }).jsonOutput = true;

    await command.run();

    const output = log.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).not.toContain('s3cr3t');
    expect(output).toContain('***:***@dashboard.example.com');
  });
});

describe('profile list masks embedded URL credentials', () => {
  it('masks the url in both the JSON envelope and the human table', async () => {
    const profiles = [
      { name: 'legacy', dashboardUrl: CREDENTIALED_URL, username: 'admin' },
    ];
    vi.mocked(getProfileStore).mockReturnValue({
      list: vi.fn().mockResolvedValue(profiles),
      getActiveName: vi.fn().mockResolvedValue('legacy'),
    } as never);

    for (const json of [true, false]) {
      const command = new ProfileList([], mockConfig as never);
      vi.spyOn(command, 'parse' as never).mockResolvedValue({ flags: {} } as never);
      vi.spyOn(
        command as unknown as { initCommon(f: unknown): Promise<void> },
        'initCommon'
      ).mockResolvedValue(undefined);

      const log = vi.fn();
      command.log = log;
      (command as unknown as { jsonOutput: boolean }).jsonOutput = json;

      await command.run();

      const output = log.mock.calls.map((call) => String(call[0])).join('\n');
      expect(output, `json=${json}`).not.toContain('s3cr3t');
      expect(output, `json=${json}`).toContain('***:***@dashboard.example.com');
    }
  });
});

describe('emit helper sanity', () => {
  it('captures human output when json is off', () => {
    const command = new ProfileList([], mockConfig as never);
    expect(emit(command, false, { a: 1 }, () => 'human line')).toBe('human line');
  });
});
