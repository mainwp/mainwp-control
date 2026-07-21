import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProfileStore, type Profile } from './profile-store.js';

const baseProfile: Profile = {
  name: 'test',
  dashboardUrl: 'https://dashboard.example.com',
  username: 'admin',
  createdAt: '2026-07-13T00:00:00.000Z',
};

describe('ProfileStore URL validation', () => {
  const originalXdgConfigHome = process.env['XDG_CONFIG_HOME'];
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(join(tmpdir(), 'mainwp-profile-store-'));
    process.env['XDG_CONFIG_HOME'] = tempRoot;
  });

  afterEach(async () => {
    if (originalXdgConfigHome === undefined) {
      delete process.env['XDG_CONFIG_HOME'];
    } else {
      process.env['XDG_CONFIG_HOME'] = originalXdgConfigHome;
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it.each([
    'https://embedded@dashboard.example.com',
    'https://embedded:secret@dashboard.example.com',
  ])('rejects dashboard URLs with embedded userinfo: %s', async (dashboardUrl) => {
    const store = new ProfileStore();

    await expect(store.save({ ...baseProfile, dashboardUrl })).rejects.toMatchObject({
      message: 'Embedded credentials in the dashboard URL are not supported',
      hint: expect.stringMatching(/--username.*password prompt/i),
    });
  });

  async function writeProfilesFile(skipSSLVerification: unknown): Promise<void> {
    const configDir = join(tempRoot, 'mainwpcontrol');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      join(configDir, 'profiles.json'),
      JSON.stringify({
        activeProfile: baseProfile.name,
        profiles: [{ ...baseProfile, skipSSLVerification }],
      })
    );
  }

  it.each([
    ['false', 'string "false"'],
    ['true', 'string "true"'],
  ])('coerces non-boolean skipSSLVerification (%s) to false and warns', async (rawValue) => {
    await writeProfilesFile(rawValue);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new ProfileStore();

    const profile = await store.get(baseProfile.name);

    expect(profile?.skipSSLVerification).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Ignoring invalid skipSSLVerification for profile "test"; expected a boolean.')
    );

    errorSpy.mockRestore();
  });

  it('preserves a valid boolean skipSSLVerification without warning', async () => {
    await writeProfilesFile(true);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new ProfileStore();

    const profile = await store.get(baseProfile.name);

    expect(profile?.skipSSLVerification).toBe(true);
    expect(errorSpy).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it('leaves skipSSLVerification absent when not set', async () => {
    const configDir = join(tempRoot, 'mainwpcontrol');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      join(configDir, 'profiles.json'),
      JSON.stringify({ activeProfile: baseProfile.name, profiles: [baseProfile] })
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new ProfileStore();

    const profile = await store.get(baseProfile.name);

    expect(profile?.skipSSLVerification).toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});
