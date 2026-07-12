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
  ])('delete() warns instead of crashing when keytar rejects with %s', async (_label, rejection, expected) => {
    vi.mocked(keytar.deletePassword).mockRejectedValue(rejection);

    await expect(new Keychain().delete('default')).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Failed to remove credentials from keychain: ${expected}`)
    );
  });

  it('delete() warns with the message when keytar rejects with an Error', async () => {
    vi.mocked(keytar.deletePassword).mockRejectedValue(new Error('access denied'));

    await new Keychain().delete('default');

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to remove credentials from keychain: access denied')
    );
  });

  it('set() returns a failure result when keytar rejects with a non-Error', async () => {
    vi.mocked(keytar.setPassword).mockRejectedValue(null);

    const result = await new Keychain().set('default', 'secret');

    expect(result).toEqual({ stored: false, location: 'none', error: 'null' });
  });
});
