import { afterEach, describe, expect, it } from 'vitest';
import { abilityToTool, resolveProviderSelection, validateProviderBaseUrl } from './provider.js';
import { ConfigError } from '../../utils/errors.js';

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

  it.each(['file:///tmp/provider', 'ftp://provider.example.com', 'not-a-url'])(
    'rejects an unsafe custom base URL before provider creation: %s',
    (baseUrl) => {
      expect(() => resolveProviderSelection({
        flagProvider: 'local',
        apiKey: 'test-key',
        baseUrl,
      })).toThrow(/base URL/i);
    },
  );

  it.each(['http://127.0.0.1:11434/v1', 'https://provider.example.com/v1'])(
    'accepts an HTTP(S) custom base URL: %s',
    (baseUrl) => {
      const result = resolveProviderSelection({
        flagProvider: 'local',
        apiKey: 'test-key',
        baseUrl,
      });
      expect(result.config.baseUrl).toBe(baseUrl);
    },
  );

  it('warns when a custom base URL overrides a hosted provider endpoint', () => {
    const result = resolveProviderSelection({
      flagProvider: 'openai',
      apiKey: 'sk-test-openai',
      baseUrl: 'https://proxy.example',
    });

    expect(result.warnings).toEqual([
      expect.stringMatching(/Custom base URL overrides.*proxy\.example/),
    ]);
  });
});

describe('validateProviderBaseUrl', () => {
  it('rejects cleartext HTTP for a hosted provider', () => {
    expect(() =>
      validateProviderBaseUrl('http://evil.example.com', { provider: 'openai' })
    ).toThrow(ConfigError);
  });

  it('accepts HTTPS for a hosted provider and warns about the host', () => {
    const warnings: string[] = [];

    const result = validateProviderBaseUrl('https://proxy.corp.example', {
      provider: 'openai',
      warnings,
    });

    expect(result).toBe('https://proxy.corp.example');
    expect(warnings).toEqual([
      expect.stringMatching(/proxy\.corp\.example/),
    ]);
    expect(warnings[0]).toMatch(/openai/);
  });

  it('accepts cleartext HTTP to localhost for the local provider without warning', () => {
    const warnings: string[] = [];

    const result = validateProviderBaseUrl('http://localhost:8080/v1', {
      provider: 'local',
      warnings,
    });

    expect(result).toBe('http://localhost:8080/v1');
    expect(warnings).toEqual([]);
  });

  it('accepts cleartext HTTP to private-network hosts for the local provider', () => {
    expect(
      validateProviderBaseUrl('http://192.168.1.50:8080', { provider: 'local' })
    ).toBe('http://192.168.1.50:8080');
    expect(
      validateProviderBaseUrl('http://172.20.0.5', { provider: 'local' })
    ).toBe('http://172.20.0.5');
  });

  it('rejects cleartext HTTP outside the 172.16-31 private range for the local provider', () => {
    expect(() =>
      validateProviderBaseUrl('http://172.32.0.1', { provider: 'local' })
    ).toThrow(ConfigError);
  });

  it('rejects cleartext HTTP to a public host for the local provider', () => {
    expect(() =>
      validateProviderBaseUrl('http://myserver.example.com', { provider: 'local' })
    ).toThrow(ConfigError);
  });

  it('accepts HTTPS with no provider context (back-compat)', () => {
    expect(validateProviderBaseUrl('https://anything.example')).toBe(
      'https://anything.example'
    );
  });
});

describe('abilityToTool', () => {
  const EMPTY_OBJECT_SCHEMA = { type: 'object', properties: {} };

  it('passes a valid object schema through unchanged', () => {
    const schema = {
      type: 'object',
      properties: { site_id: { type: 'integer' } },
      required: ['site_id'],
    };

    const tool = abilityToTool('mainwp/get-site-v1', 'Get a site', schema);

    expect(tool.parameters).toEqual(schema);
  });

  it('defaults to an empty object schema when input schema is undefined', () => {
    const tool = abilityToTool('core/no-input', 'No input', undefined);

    expect(tool.parameters).toEqual(EMPTY_OBJECT_SCHEMA);
  });

  it('normalizes a PHP empty-array schema to an empty object schema', () => {
    const tool = abilityToTool(
      'core/get-environment-info',
      'Env info',
      [] as unknown as Record<string, unknown>
    );

    expect(tool.parameters).toEqual(EMPTY_OBJECT_SCHEMA);
  });

  it('coerces a nullable top-level type array to plain object', () => {
    const schema = {
      type: ['object', 'null'],
      properties: { page: { type: 'integer' } },
    };

    const tool = abilityToTool('mainwp/list-sites-v1', 'List sites', schema);

    expect(tool.parameters['type']).toBe('object');
    expect(tool.parameters['properties']).toEqual(schema.properties);
    // Original schema object must not be mutated
    expect(schema.type).toEqual(['object', 'null']);
  });

  it('normalizes nested PHP empty-array properties to empty objects', () => {
    const schema = {
      type: ['object', 'null'],
      properties: [] as unknown as Record<string, unknown>,
      additionalProperties: false,
    };

    const tool = abilityToTool('mainwp/get-network-snapshot-v1', 'Snapshot', schema);

    expect(tool.parameters).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
  });

  it('keeps nested type arrays and legal empty-array defaults intact', () => {
    const schema = {
      type: 'object',
      properties: {
        tag_ids: {
          type: ['array', 'null'],
          items: { type: 'integer' },
          default: [],
        },
      },
    };

    const tool = abilityToTool('mainwp/count-sites-v1', 'Count sites', schema);

    expect(tool.parameters).toEqual(schema);
  });
});
