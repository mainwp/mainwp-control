/**
 * Tests for settings file handling
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { loadSettings, clearSettingsCache, resolveSettings } from './settings.js';

// Mock fs.promises
vi.mock('node:fs', () => ({
  promises: {
    readFile: vi.fn(),
  },
}));

import { promises as fs } from 'node:fs';

describe('loadSettings', () => {
  afterEach(() => {
    clearSettingsCache();
    vi.restoreAllMocks();
  });

  it('returns empty settings when file does not exist', async () => {
    const error = new Error('ENOENT') as NodeJS.ErrnoException;
    error.code = 'ENOENT';
    vi.mocked(fs.readFile).mockRejectedValue(error);

    const settings = await loadSettings();
    expect(settings).toEqual({});
  });

  it('warns to stderr on corrupted JSON and returns defaults', async () => {
    vi.mocked(fs.readFile).mockResolvedValue('{ invalid json !!!');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const settings = await loadSettings();

    expect(settings).toEqual({});
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to parse settings file')
    );
  });

  it('parses valid JSON settings', async () => {
    vi.mocked(fs.readFile).mockResolvedValue('{"debug": true}');

    const settings = await loadSettings();
    expect(settings).toEqual({ debug: true });
  });
});

describe('resolveSettings', () => {
  it('applies defaults when settings are empty', () => {
    const result = resolveSettings({});

    expect(result.settings.defaultJsonOutput).toBe(false);
    expect(result.settings.timeout).toBe(30000);
    expect(result.settings.debug).toBe(false);
    expect(result.settings.chatContextMessages).toBe(20);
    expect(result.settings.allowInsecureHttp).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it('normalizes valid supported settings', () => {
    const result = resolveSettings({
      defaultJsonOutput: true,
      timeout: 45000,
      debug: true,
      llmProvider: 'OpenAI',
      chatContextMessages: 50,
      skipSSLVerification: true,
      allowInsecureHttp: true,
    });

    expect(result.settings.defaultJsonOutput).toBe(true);
    expect(result.settings.timeout).toBe(45000);
    expect(result.settings.debug).toBe(true);
    expect(result.settings.llmProvider).toBe('openai');
    expect(result.settings.chatContextMessages).toBe(50);
    expect(result.settings.skipSSLVerification).toBe(true);
    expect(result.settings.allowInsecureHttp).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('falls back safely for invalid values and records warnings', () => {
    const result = resolveSettings({
      timeout: -1,
      debug: 'yes' as unknown as boolean,
      llmProvider: 'bogus',
      chatContextMessages: -5,
    });

    expect(result.settings.timeout).toBe(30000);
    expect(result.settings.debug).toBe(false);
    expect(result.settings.llmProvider).toBeUndefined();
    expect(result.settings.chatContextMessages).toBe(20);
    expect(result.warnings).toHaveLength(4);
  });
});
