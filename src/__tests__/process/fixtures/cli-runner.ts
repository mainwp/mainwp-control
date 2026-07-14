/**
 * CLI Runner for Process Tests
 *
 * Spawns `node bin/run.js` as a child process with isolated config.
 * Uses execFile (not exec) to avoid shell injection.
 */

import { execFile, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const BIN_PATH = resolve(PROJECT_ROOT, 'bin', 'run.js');

export interface CLIRunnerOptions {
  /** XDG_CONFIG_HOME path (temp dir) */
  xdgConfigHome: string;
  /** Extra environment variables */
  env?: Record<string, string>;
  /** Timeout in ms (default: 15000) */
  timeout?: number;
  /** Data to pipe to stdin */
  stdin?: string;
  /** Wait for this stdout text before piping stdin */
  stdinWaitFor?: string;
  /** Emulate TTY flags while retaining pipe-based stdin/stdout */
  emulateTTY?: boolean;
}

export interface CLIResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Parsed JSON from stdout (undefined if not valid JSON) */
  json?: unknown;
  /** Duration in ms */
  duration: number;
}

/**
 * Run the CLI with the given arguments and return the result.
 */
export async function runCLI(
  args: string[],
  options: CLIRunnerOptions,
): Promise<CLIResult> {
  const timeout = options.timeout ?? 15_000;
  const start = Date.now();

  const env: Record<string, string> = {
    // Minimal PATH for node
    PATH: process.env['PATH'] ?? '',
    // Isolated config
    XDG_CONFIG_HOME: options.xdgConfigHome,
    // Prevent reads from real home
    HOME: options.xdgConfigHome,
    // Suppress Node.js warnings in output
    NODE_NO_WARNINGS: '1',
    // Test environment
    NODE_ENV: 'test',
    // Process tests use a local mock HTTP server; opt in explicitly so
    // runtime defaults can remain HTTPS-first.
    MAINWP_ALLOW_HTTP: '1',
    // Skip native keytar — process tests run with isolated HOME where
    // macOS Keychain access is slow/unavailable.
    MAINWPCONTROL_NO_KEYTAR: '1',
    // Spread any extra env
    ...options.env,
  };

  // If stdin is provided, we need to use spawn to pipe data
  if (options.stdin !== undefined) {
    return runWithStdin(
      args,
      env,
      timeout,
      options.stdin,
      start,
      options.stdinWaitFor,
      options.emulateTTY ?? false,
    );
  }

  return new Promise<CLIResult>((resolve) => {
    const child = execFile(
      process.execPath,
      [BIN_PATH, ...args],
      { env, timeout, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const duration = Date.now() - start;
        const exitCode = error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
          ? 1
          : (error as { status?: number } | null)?.status ?? child.exitCode ?? (error ? 1 : 0);

        let json: unknown;
        try {
          json = JSON.parse(stdout);
        } catch {
          // not JSON
        }

        resolve({ stdout, stderr, exitCode, json, duration });
      },
    );
  });
}

function runWithStdin(
  args: string[],
  env: Record<string, string>,
  timeout: number,
  stdinData: string,
  start: number,
  stdinWaitFor: string | undefined,
  emulateTTY: boolean,
): Promise<CLIResult> {
  return new Promise<CLIResult>((resolve) => {
    const childArgs = emulateTTY
      ? [
          '--input-type=module',
          '--eval',
          [
            "Object.defineProperty(process.stdin, 'isTTY', { value: true });",
            "Object.defineProperty(process.stdout, 'isTTY', { value: true });",
            "Object.defineProperty(process.stdout, 'getWindowSize', { value: () => [80, 24] });",
            `process.argv = [process.execPath, ${JSON.stringify(BIN_PATH)}, ...process.argv.slice(1)];`,
            `await import(${JSON.stringify(pathToFileURL(BIN_PATH).href)});`,
          ].join('\n'),
          ...args,
        ]
      : [BIN_PATH, ...args];

    const child = spawn(process.execPath, childArgs, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdinSent = false;

    const sendStdin = (): void => {
      if (stdinSent) return;
      stdinSent = true;
      child.stdin.end(stdinData);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      if (
        stdinWaitFor !== undefined &&
        Buffer.concat(stdoutChunks).toString('utf-8').includes(stdinWaitFor)
      ) {
        sendStdin();
      }
    });
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('close', (code) => {
      const duration = Date.now() - start;
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      const exitCode = code ?? 1;

      let json: unknown;
      try {
        json = JSON.parse(stdout);
      } catch {
        // not JSON
      }

      resolve({ stdout, stderr, exitCode, json, duration });
    });

    child.on('error', (err) => {
      const duration = Date.now() - start;
      resolve({
        stdout: '',
        stderr: err.message,
        exitCode: 1,
        duration,
      });
    });

    if (stdinWaitFor === undefined) {
      sendStdin();
    }
  });
}
