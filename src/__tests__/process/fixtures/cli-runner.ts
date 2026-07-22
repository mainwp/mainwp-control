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

function buildEnv(options: CLIRunnerOptions): Record<string, string> {
  // On Windows, children must inherit the OS plumbing (SystemRoot, TEMP,
  // PATHEXT, APPDATA, ...): a hand-built minimal env sends node into
  // multi-second fallback paths on every boot (measured 20-40s per child
  // on CI runners vs ~800ms with a full env). Hermeticity comes from
  // stripping MAINWP* and overriding every variable the CLI reads, not
  // from starting empty. POSIX keeps the fully minimal env.
  const base: Record<string, string> = {};
  if (process.platform === 'win32') {
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !key.toUpperCase().startsWith('MAINWP')) {
        base[key] = value;
      }
    }
  }
  return {
    ...base,
    PATH: process.env['PATH'] ?? '',
    XDG_CONFIG_HOME: options.xdgConfigHome,
    HOME: options.xdgConfigHome,
    NODE_NO_WARNINGS: '1',
    NODE_ENV: 'test',
    MAINWP_ALLOW_HTTP: '1',
    MAINWPCONTROL_NO_KEYTAR: '1',
    ...options.env,
  };
}

/**
 * Run the CLI with the given arguments and return the result.
 */
/**
 * Default child timeout. Windows children run ~1-3s with the inherited env
 * (see buildEnv), but CI runner speed varies; the extra headroom there is
 * free when tests are healthy and prevents a slow runner from SIGKILLing a
 * working child mid-boot, which reports as empty output.
 */
const DEFAULT_TIMEOUT = process.platform === 'win32' ? 60_000 : 15_000;

export async function runCLI(
  args: string[],
  options: CLIRunnerOptions,
): Promise<CLIResult> {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const start = Date.now();

  const env = buildEnv(options);

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

/** Run the CLI, deliver a real process signal, and collect its final output. */
export function runCLIWithSignal(
  args: string[],
  options: CLIRunnerOptions,
  signal: NodeJS.Signals = 'SIGINT',
  signalAfter: number | Promise<void> = 750,
): Promise<CLIResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN_PATH, ...args], {
      env: buildEnv(options),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    // A numeric delay races slow CI runners: SIGINT can land before the CLI
    // has booted and installed its handler, killing it with no output. Pass a
    // readiness promise (e.g. MockServer.waitForRequest) to deliver the
    // signal only once the CLI is demonstrably up.
    let signalTimer: NodeJS.Timeout | undefined;
    if (typeof signalAfter === 'number') {
      signalTimer = setTimeout(() => child.kill(signal), signalAfter);
    } else {
      void signalAfter.then(() => child.kill(signal));
    }
    const timeoutTimer = setTimeout(() => child.kill('SIGKILL'), options.timeout ?? DEFAULT_TIMEOUT);

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    let spawned = false;
    child.on('spawn', () => {
      spawned = true;
    });
    child.on('error', (error) => {
      // 'error' also fires when a later kill() fails. In that case the child
      // is still running: leave the timers armed (the SIGKILL fallback must
      // stay live) and let 'close' remain the terminal resolution path. Only
      // a spawn failure, where 'close' is not guaranteed, resolves here.
      if (spawned) {
        return;
      }
      clearTimeout(signalTimer);
      clearTimeout(timeoutTimer);
      resolve({ stdout: '', stderr: String(error), exitCode: 1, json: undefined, duration: Date.now() - start });
    });
    child.on('close', (code, closeSignal) => {
      clearTimeout(signalTimer);
      clearTimeout(timeoutTimer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      const exitCode = code ?? (closeSignal === 'SIGINT' ? 130 : closeSignal === 'SIGTERM' ? 143 : 1);
      let json: unknown;
      try {
        json = JSON.parse(stdout);
      } catch {
        // not JSON
      }
      resolve({ stdout, stderr, exitCode, json, duration: Date.now() - start });
    });
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
