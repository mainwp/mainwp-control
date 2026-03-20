import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MockServer } from './fixtures/mock-server.js';
import { runCLI } from './fixtures/cli-runner.js';
import { ConfigDir } from './fixtures/config-dir.js';

describe('config show command', () => {
  const server = new MockServer();
  let configDir: ConfigDir;

  beforeAll(async () => {
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(() => {
    server.reset();
    server.setAbilities();
  });

  afterEach(async () => {
    delete process.env['OPENAI_API_KEY'];
    delete process.env['MAINWP_LLM_PROVIDER'];
    if (configDir) {
      await configDir.cleanup();
    }
  });

  it('reports effective settings and provider resolution in JSON mode', async () => {
    configDir = await ConfigDir.create({
      profiles: [
        {
          name: 'test',
          dashboardUrl: server.baseUrl,
          username: 'admin',
        },
      ],
      activeProfile: 'test',
      settings: {
        timeout: 45000,
        debug: true,
        llmProvider: 'openai',
        chatContextMessages: 50,
        skipSSLVerification: true,
        allowInsecureHttp: true,
      },
    });

    const result = await runCLI(['config', 'show', '--json'], {
      xdgConfigHome: configDir.xdgHome,
      env: {
        MAINWP_APP_PASSWORD: 'test-pass',
        OPENAI_API_KEY: 'sk-test-openai',
      },
    });

    expect(result.exitCode).toBe(0);

    const envelope = result.json as {
      success: boolean;
      data: {
        profile: {
          skipSSLVerification: boolean;
          skipSSLVerificationSource: string;
          allowInsecureHttp: boolean;
        };
        llmProvider: {
          name: string;
          source: string;
          configured: boolean;
        };
        effectiveSettings: {
          timeout: number;
          debug: boolean;
          llmProvider: string;
          chatContextMessages: number;
          skipSSLVerification: boolean;
          allowInsecureHttp: boolean;
        };
      };
    };

    expect(envelope.success).toBe(true);
    expect(envelope.data.profile.skipSSLVerification).toBe(true);
    expect(envelope.data.profile.skipSSLVerificationSource).toBe('settings');
    expect(envelope.data.profile.allowInsecureHttp).toBe(true);
    expect(envelope.data.llmProvider.name).toBe('openai');
    expect(envelope.data.llmProvider.source).toBe('settings');
    expect(envelope.data.llmProvider.configured).toBe(true);
    expect(envelope.data.effectiveSettings.timeout).toBe(45000);
    expect(envelope.data.effectiveSettings.debug).toBe(true);
    expect(envelope.data.effectiveSettings.chatContextMessages).toBe(50);
    expect(envelope.data.effectiveSettings.skipSSLVerification).toBe(true);
    expect(envelope.data.effectiveSettings.allowInsecureHttp).toBe(true);
  });
});
