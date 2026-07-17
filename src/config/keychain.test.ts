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

  it('delete() reports when keytar did not remove a credential', async () => {
    vi.mocked(keytar.deletePassword).mockResolvedValue(false);

    await expect(new Keychain().delete('default')).resolves.toEqual({
      deleted: false,
      error: 'No matching keychain credential was found',
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
