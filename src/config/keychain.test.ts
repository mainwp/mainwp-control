/**
 * Tests for keychain error handling
 *
 * Keytar is native code and can reject with non-Error values (null,
 * undefined, strings). These tests pin the warn-and-continue behavior:
 * a bad rejection value must never crash delete() or set().
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock keytar so loadKeytar() picks up controllable functions
vi.mock('keytar', () => ({
  setPassword: vi.fn(),
  getPassword: vi.fn(),
  deletePassword: vi.fn(),
}));

import * as keytar from 'keytar';
import { Keychain, canonicalDashboardIdentity } from './keychain.js';
import { AuthError } from '../utils/errors.js';

describe('Keychain error normalization', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete process.env['MAINWPCONTROL_NO_KEYTAR'];
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['null', null, 'null'],
    ['undefined', undefined, 'undefined'],
    ['a string', 'keychain locked', 'keychain locked'],
  ])('delete() reports failure without crashing when keytar rejects with %s', async (_label, rejection, expected) => {
    vi.mocked(keytar.deletePassword).mockRejectedValue(rejection);

    await expect(new Keychain().delete('default')).resolves.toEqual({
      deleted: false,
      error: expected,
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('delete() reports the message when keytar rejects with an Error', async () => {
    vi.mocked(keytar.deletePassword).mockRejectedValue(new Error('access denied'));

    await expect(new Keychain().delete('default')).resolves.toEqual({
      deleted: false,
      error: 'access denied',
    });
  });

  it('delete() marks a missing credential as notFound, not a failure', async () => {
    vi.mocked(keytar.deletePassword).mockResolvedValue(false);

    await expect(new Keychain().delete('default')).resolves.toEqual({
      deleted: false,
      notFound: true,
      error: 'No matching keychain credential was found',
    });
  });

  it('getStored() ignores MAINWP_APP_PASSWORD while get() falls back to it', async () => {
    vi.mocked(keytar.getPassword).mockResolvedValue(null);
    vi.stubEnv('MAINWP_APP_PASSWORD', 'env-secret');

    const keychain = new Keychain();
    await expect(keychain.getStored('default')).resolves.toEqual({ status: 'not-found' });
    await expect(keychain.get('default')).resolves.toBe('env-secret');

    vi.unstubAllEnvs();
  });

  it('getStored() reports a read error distinctly from not-found', async () => {
    vi.mocked(keytar.getPassword).mockRejectedValue(new Error('keychain locked'));

    await expect(new Keychain().getStored('default')).resolves.toEqual({
      status: 'error',
      error: 'keychain locked',
    });
  });

  it('getStored() returns the persisted credential when present', async () => {
    vi.mocked(keytar.getPassword).mockResolvedValue('stored-secret');

    await expect(new Keychain().getStored('default')).resolves.toEqual({
      status: 'found',
      password: 'stored-secret',
    });
  });

  it('delete() redacts paths and bounds keytar errors', async () => {
    vi.mocked(keytar.deletePassword).mockRejectedValue(
      new Error(`/Users/tester/.config/mainwpcontrol ${'x'.repeat(1000)}`),
    );

    const result = await new Keychain().delete('default');

    expect(result.deleted).toBe(false);
    expect(result.error).not.toContain('/Users/tester');
    expect(result.error?.length).toBeLessThanOrEqual(500);
  });

  it('delete() reports failure when keytar is unavailable', async () => {
    vi.resetModules();
    process.env['MAINWPCONTROL_NO_KEYTAR'] = '1';

    const { Keychain: FreshKeychain } = await import('./keychain.js');

    await expect(new FreshKeychain().delete('default')).resolves.toEqual({
      deleted: false,
      error: 'Keychain (keytar) is not available',
    });
  });

  it('set() redacts paths and bounds keytar errors', async () => {
    vi.mocked(keytar.setPassword).mockRejectedValue(
      new Error(`/Users/tester/.config/mainwpcontrol ${'x'.repeat(1000)}`),
    );

    const result = await new Keychain().set('default', 'secret');

    expect(result.stored).toBe(false);
    expect(result.error).not.toContain('/Users/tester');
    expect(result.error?.length).toBeLessThanOrEqual(500);
  });

  it('set() returns a failure result when keytar rejects with a non-Error', async () => {
    vi.mocked(keytar.setPassword).mockRejectedValue(null);

    const result = await new Keychain().set('default', 'secret');

    expect(result).toEqual({ stored: false, location: 'none', error: 'null' });
  });
});

describe('Keychain identity binding', () => {
  beforeEach(() => {
    delete process.env['MAINWPCONTROL_NO_KEYTAR'];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('canonicalDashboardIdentity', () => {
    it('strips a trailing slash', () => {
      expect(canonicalDashboardIdentity('https://dash.example.com/wp/')).toBe(
        'https://dash.example.com/wp'
      );
    });

    it('preserves a non-default port', () => {
      expect(canonicalDashboardIdentity('https://dash.example.com:8443')).toBe(
        'https://dash.example.com:8443'
      );
    });

    it('strips multiple trailing slashes', () => {
      expect(canonicalDashboardIdentity('https://dash.example.com/wp///')).toBe(
        'https://dash.example.com/wp'
      );
    });

    it('leaves a bare host unchanged', () => {
      expect(canonicalDashboardIdentity('https://dash.example.com')).toBe(
        'https://dash.example.com'
      );
    });
  });

  it('set() with a dashboardUrl stores a v1 JSON envelope', async () => {
    vi.mocked(keytar.setPassword).mockResolvedValue(undefined);

    await new Keychain().set('default', 'pw', 'https://dash.example.com');

    const [, , payload] = vi.mocked(keytar.setPassword).mock.calls[0]!;
    expect(JSON.parse(payload)).toEqual({
      v: 1,
      password: 'pw',
      identity: 'https://dash.example.com',
    });
  });

  it('set() without a dashboardUrl stores the raw string verbatim (rollback path)', async () => {
    vi.mocked(keytar.setPassword).mockResolvedValue(undefined);

    await new Keychain().set('default', 'pw');

    const [, , payload] = vi.mocked(keytar.setPassword).mock.calls[0]!;
    expect(payload).toBe('pw');
  });

  it('get() with a matching expectedDashboardUrl returns the inner password', async () => {
    vi.mocked(keytar.getPassword).mockResolvedValue(
      JSON.stringify({ v: 1, password: 'pw', identity: 'https://dash.example.com' })
    );

    await expect(
      new Keychain().get('default', 'https://dash.example.com')
    ).resolves.toBe('pw');
  });

  it('get() throws AuthError mentioning both identities when the expected URL changed', async () => {
    vi.mocked(keytar.getPassword).mockResolvedValue(
      JSON.stringify({ v: 1, password: 'pw', identity: 'https://old.example.com' })
    );

    const keychain = new Keychain();
    await expect(
      keychain.get('default', 'https://new.example.com')
    ).rejects.toBeInstanceOf(AuthError);
    await expect(
      keychain.get('default', 'https://new.example.com')
    ).rejects.toMatchObject({
      message: expect.stringContaining('https://old.example.com'),
    });
    await expect(
      keychain.get('default', 'https://new.example.com')
    ).rejects.toMatchObject({
      message: expect.stringContaining('https://new.example.com'),
    });
  });

  it('getOrThrow() throws AuthError mentioning both identities when the expected URL changed', async () => {
    vi.mocked(keytar.getPassword).mockResolvedValue(
      JSON.stringify({ v: 1, password: 'pw', identity: 'https://old.example.com' })
    );

    const keychain = new Keychain();
    await expect(
      keychain.getOrThrow('default', 'https://new.example.com')
    ).rejects.toBeInstanceOf(AuthError);
    await expect(
      keychain.getOrThrow('default', 'https://new.example.com')
    ).rejects.toMatchObject({
      message: expect.stringContaining('https://old.example.com'),
    });
    await expect(
      keychain.getOrThrow('default', 'https://new.example.com')
    ).rejects.toMatchObject({
      message: expect.stringContaining('https://new.example.com'),
    });
  });

  it('get() refuses a legacy unbound entry for an authenticated request', async () => {
    vi.mocked(keytar.getPassword).mockResolvedValue('abcd efgh');
    vi.mocked(keytar.setPassword).mockResolvedValue(undefined);

    // An unbound password cannot be safely bound to whatever URL the profile
    // currently holds — the fix is a one-time re-login, never auto-binding.
    await expect(
      new Keychain().get('default', 'https://dash.example.com')
    ).rejects.toBeInstanceOf(AuthError);
    await expect(
      new Keychain().get('default', 'https://dash.example.com')
    ).rejects.toMatchObject({
      hint: expect.stringContaining('login'),
    });
    expect(vi.mocked(keytar.setPassword)).not.toHaveBeenCalled();
  });

  it('get() without an expectedDashboardUrl still reads a legacy entry (display paths)', async () => {
    vi.mocked(keytar.getPassword).mockResolvedValue('abcd efgh');
    vi.mocked(keytar.setPassword).mockResolvedValue(undefined);

    await expect(new Keychain().get('default')).resolves.toBe('abcd efgh');
    expect(vi.mocked(keytar.setPassword)).not.toHaveBeenCalled();
  });

  describe('env-var credential identity binding', () => {
    beforeEach(() => {
      vi.mocked(keytar.getPassword).mockResolvedValue(null);
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('releases the env password when MAINWP_DASHBOARD_URL matches the profile', async () => {
      vi.stubEnv('MAINWP_APP_PASSWORD', 'env-secret');
      vi.stubEnv('MAINWP_DASHBOARD_URL', 'https://dash.example.com');

      await expect(
        new Keychain().get('default', 'https://dash.example.com')
      ).resolves.toBe('env-secret');
    });

    it('matches on canonical identity, not raw string', async () => {
      vi.stubEnv('MAINWP_APP_PASSWORD', 'env-secret');
      vi.stubEnv('MAINWP_DASHBOARD_URL', 'https://dash.example.com/');

      await expect(
        new Keychain().get('default', 'https://dash.example.com')
      ).resolves.toBe('env-secret');
    });

    it('refuses when MAINWP_DASHBOARD_URL is absent', async () => {
      // A tampered profiles.json could otherwise redirect the env credential
      // to an attacker host without the operator ever naming a destination.
      vi.stubEnv('MAINWP_APP_PASSWORD', 'env-secret');

      await expect(
        new Keychain().get('default', 'https://dash.example.com')
      ).rejects.toBeInstanceOf(AuthError);
    });

    it('refuses when MAINWP_DASHBOARD_URL points somewhere else', async () => {
      vi.stubEnv('MAINWP_APP_PASSWORD', 'env-secret');
      vi.stubEnv('MAINWP_DASHBOARD_URL', 'https://attacker.example.com');

      const keychain = new Keychain();
      await expect(
        keychain.get('default', 'https://dash.example.com')
      ).rejects.toBeInstanceOf(AuthError);
      await expect(
        keychain.get('default', 'https://dash.example.com')
      ).rejects.toMatchObject({
        message: expect.stringContaining('https://attacker.example.com'),
      });
    });

    it('refuses when MAINWP_DASHBOARD_URL is not a parseable URL', async () => {
      vi.stubEnv('MAINWP_APP_PASSWORD', 'env-secret');
      vi.stubEnv('MAINWP_DASHBOARD_URL', 'not-a-url');

      await expect(
        new Keychain().get('default', 'https://dash.example.com')
      ).rejects.toBeInstanceOf(AuthError);
    });

    it('still reads the env password for display paths with no expected URL', async () => {
      // Display paths (config show, doctor) pass no expected URL and send
      // nothing to a Dashboard, so the binding does not apply.
      vi.stubEnv('MAINWP_APP_PASSWORD', 'env-secret');

      await expect(new Keychain().get('default')).resolves.toBe('env-secret');
    });
  });

  it('get() treats a "{"-prefixed non-envelope payload as a legacy raw password', async () => {
    vi.mocked(keytar.getPassword).mockResolvedValue('{not valid json');

    // Legacy semantics apply: readable without a URL, refused with one.
    await expect(new Keychain().get('default')).resolves.toBe('{not valid json');
    await expect(
      new Keychain().get('default', 'https://dash.example.com')
    ).rejects.toBeInstanceOf(AuthError);
  });
});
