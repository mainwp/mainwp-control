/**
 * Tests for atomic write temp file cleanup (L1)
 *
 * Verifies that .tmp files are cleaned up when rename() fails
 * in both profile-store and settings save paths.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

// Mock fs.promises with all needed methods
vi.mock('node:fs', () => ({
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn(),
    unlink: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
  },
}));

import { promises as fs } from 'node:fs';
import { saveSettings, clearSettingsCache } from './settings.js';

describe('Atomic write temp file cleanup', () => {
  afterEach(() => {
    clearSettingsCache();
    vi.restoreAllMocks();
  });

  it('cleans up temp file when rename fails (saveSettings)', async () => {
    const renameError = new Error('EXDEV: cross-device link not permitted');
    vi.mocked(fs.rename).mockRejectedValue(renameError);
    vi.mocked(fs.unlink).mockResolvedValue(undefined);

    await expect(saveSettings({ debug: true })).rejects.toThrow('EXDEV');

    // Verify writeFile was called (temp file was created)
    expect(fs.writeFile).toHaveBeenCalledTimes(1);
    const tmpPath = vi.mocked(fs.writeFile).mock.calls[0][0] as string;
    expect(tmpPath).toMatch(/\.tmp$/);

    // Verify unlink was called to clean up the temp file
    expect(fs.unlink).toHaveBeenCalledWith(tmpPath);
  });

  it('does not throw if unlink also fails during cleanup', async () => {
    const renameError = new Error('EXDEV: cross-device link not permitted');
    vi.mocked(fs.rename).mockRejectedValue(renameError);
    vi.mocked(fs.unlink).mockRejectedValue(new Error('ENOENT'));

    // Should still throw the original rename error, not the unlink error
    await expect(saveSettings({ debug: true })).rejects.toThrow('EXDEV');
  });

  it('succeeds normally when rename works', async () => {
    vi.mocked(fs.rename).mockResolvedValue(undefined);

    await saveSettings({ debug: true });

    expect(fs.rename).toHaveBeenCalledTimes(1);
    // unlink should NOT have been called
    expect(fs.unlink).not.toHaveBeenCalled();
  });
});
