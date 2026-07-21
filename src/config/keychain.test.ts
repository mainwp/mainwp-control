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
import { Keychain } from './keychain.js';

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

  it('set() returns a failure result when keytar rejects with a non-Error', async () => {
    vi.mocked(keytar.setPassword).mockRejectedValue(null);

    const result = await new Keychain().set('default', 'secret');

    expect(result).toEqual({ stored: false, location: 'none', error: 'null' });
  });
});
