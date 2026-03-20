import { afterEach, describe, expect, it } from 'vitest';
import { resolveProviderSelection } from './provider.js';

describe('resolveProviderSelection', () => {
  afterEach(() => {
    delete process.env['OPENAI_API_KEY'];
    delete process.env['GOOGLE_API_KEY'];
    delete process.env['MAINWP_LLM_PROVIDER'];
    delete process.env['LOCAL_LLM_API_KEY'];
    delete process.env['LOCAL_LLM_URL'];
  });

  it('uses settings provider when flags and env preference are absent', () => {
    process.env['OPENAI_API_KEY'] = 'sk-test-openai';

    const result = resolveProviderSelection({
      settingsProvider: 'openai',
      timeout: 45000,
    });

    expect(result.name).toBe('openai');
    expect(result.source).toBe('settings');
    expect(result.configured).toBe(true);
    expect(result.config.apiKey).toBe('sk-test-openai');
    expect(result.config.timeout).toBe(45000);
  });

  it('prefers explicit env provider over settings provider', () => {
    process.env['OPENAI_API_KEY'] = 'sk-test-openai';
    process.env['GOOGLE_API_KEY'] = 'gm-test-gemini';

    const result = resolveProviderSelection({
      envProvider: 'gemini',
      settingsProvider: 'openai',
    });

    expect(result.name).toBe('gemini');
    expect(result.source).toBe('env');
    expect(result.config.apiKey).toBe('gm-test-gemini');
  });

  it('falls back from invalid settings provider with a warning', () => {
    process.env['OPENAI_API_KEY'] = 'sk-test-openai';

    const result = resolveProviderSelection({
      settingsProvider: 'bogus',
    });

    expect(result.name).toBe('openai');
    expect(result.source).toBe('auto');
    expect(result.warnings[0]).toMatch(/Ignoring unsupported LLM provider/);
  });
});
