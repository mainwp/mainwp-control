import type { ConfigDir } from '../../../src/__tests__/process/fixtures/config-dir.js';
import type { AcceptanceCredentials } from './env.js';
import {
  CommandRunner,
  type CommandResult,
} from './commands.js';

export interface CLIEnvelope<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
    hint?: string;
  };
  meta?: {
    command: string;
    timestamp: string;
    version: string;
  };
}

export interface CLIInvocationResult<T = unknown> extends CommandResult {
  json?: CLIEnvelope<T>;
}

export interface CLIInvocationOptions {
  env?: Record<string, string>;
  /**
   * Acceptance scenarios normally inspect non-zero exits directly. Set this
   * to false when a command failure should throw CommandError immediately.
   */
  allowFailure?: boolean;
}

export interface CLIInvokerOptions {
  binaryPath: string;
  cwd: string;
  runner: CommandRunner;
  configDir: ConfigDir;
  credentials: AcceptanceCredentials;
  env?: Record<string, string>;
  onStderr?: (stderr: string) => void;
}

/**
 * Process-level MainWP Control invoker used by deterministic acceptance tests.
 * Each call is one CommandRunner spawn and therefore one recorded invocation.
 */
export class CLIInvoker {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly runner: CommandRunner;
  readonly configDir: ConfigDir;
  readonly credentials: AcceptanceCredentials;
  private readonly extraEnv: Record<string, string>;
  private readonly onStderr: ((stderr: string) => void) | undefined;

  constructor(options: CLIInvokerOptions) {
    this.binaryPath = options.binaryPath;
    this.cwd = options.cwd;
    this.runner = options.runner;
    this.configDir = options.configDir;
    this.credentials = options.credentials;
    this.extraEnv = { ...options.env };
    this.onStderr = options.onStderr;
  }

  async run<T = unknown>(
    args: string[],
    options: CLIInvocationOptions = {}
  ): Promise<CLIInvocationResult<T>> {
    if (args.length === 0) {
      throw new Error('Acceptance CLI invocations must include an explicit subcommand');
    }
    this.assertNoCredentialInArgv(args);

    const result = await this.runner.run(
      [this.binaryPath, ...args],
      this.cwd,
      {
        env: this.buildEnv(options.env),
        // Error-contract scenarios need the result instead of an exception.
        allowFailure: options.allowFailure ?? true,
        timeoutMs: 15_000,
      }
    );
    if (result.stderr) this.onStderr?.(result.stderr);

    let json: CLIEnvelope<T> | undefined;
    try {
      json = JSON.parse(result.stdout) as CLIEnvelope<T>;
    } catch {
      // Human-output calls and malformed-output assertions inspect stdout.
    }

    return json === undefined ? result : { ...result, json };
  }

  private buildEnv(invocationEnv: Record<string, string> | undefined): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env['PATH'] ?? '',
      NODE_ENV: 'test',
      NODE_NO_WARNINGS: '1',
      ...this.extraEnv,
      ...invocationEnv,
      // These values are invariant per scenario and cannot be overridden by a
      // launch or invocation-specific environment.
      XDG_CONFIG_HOME: this.configDir.xdgHome,
      HOME: this.configDir.xdgHome,
      MAINWPCONTROL_NO_KEYTAR: '1',
      MAINWP_APP_PASSWORD: this.credentials.appPassword,
      // The env credential is identity-bound: it is released only when this
      // names the same Dashboard the profile points at.
      MAINWP_DASHBOARD_URL: this.credentials.dashboardUrl,
    };

    if (new URL(this.credentials.dashboardUrl).protocol === 'http:') {
      env['MAINWP_ALLOW_HTTP'] = '1';
    } else {
      delete env['MAINWP_ALLOW_HTTP'];
    }

    return env;
  }

  private assertNoCredentialInArgv(args: string[]): void {
    const rawPassword = this.credentials.appPassword;
    const compactPassword = rawPassword.replace(/\s/g, '');
    const secrets = [...new Set([rawPassword, compactPassword])].filter(Boolean);

    if (args.some(arg => secrets.some(secret => arg.includes(secret)))) {
      throw new Error('Acceptance CLI argv must not contain credentials');
    }
  }
}
