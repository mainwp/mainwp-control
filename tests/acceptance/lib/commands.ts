import { spawn } from 'node:child_process';

export interface CommandRecord {
  argv: string[];
  cwd: string;
  exitCode: number;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
}

export interface CommandResult extends CommandRecord {
  stdout: string;
  stderr: string;
}

export class CommandError extends Error {
  constructor(readonly result: CommandResult) {
    super(
      `Command failed with exit code ${result.exitCode}: ${result.argv.join(' ')}\n${result.stderrTail}`
    );
  }
}

function tail(value: string, maxLength = 12_000): string {
  return value.length <= maxLength ? value : value.slice(-maxLength);
}

export class CommandRunner {
  readonly records: CommandRecord[] = [];
  onRecord?: (record: CommandRecord) => void;

  record(record: CommandRecord): void {
    this.records.push(record);
    this.onRecord?.(record);
  }

  async run(
    argv: string[],
    cwd: string,
    options: { env?: NodeJS.ProcessEnv; allowFailure?: boolean; timeoutMs?: number } = {}
  ): Promise<CommandResult> {
    const started = performance.now();
    const command = argv[0];
    if (!command) {
      const result: CommandResult = {
        argv,
        cwd,
        exitCode: 1,
        durationMs: Math.round(performance.now() - started),
        stdout: '',
        stderr: 'Command argv must contain an executable.',
        stdoutTail: '',
        stderrTail: 'Command argv must contain an executable.',
      };
      this.record({
        argv: result.argv,
        cwd: result.cwd,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        stdoutTail: result.stdoutTail,
        stderrTail: result.stderrTail,
      });
      if (!options.allowFailure) throw new CommandError(result);
      return result;
    }
    const child = spawn(command, argv.slice(1), {
      cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));

    let spawnError: Error | undefined;
    let timedOut = false;
    const exitCode = await new Promise<number>(resolve => {
      let forceKill: NodeJS.Timeout | undefined;
      const timeout = options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            forceKill = setTimeout(() => child.kill('SIGKILL'), 1_000);
          }, options.timeoutMs);
      child.once('error', error => {
        spawnError = error;
        if (timeout) clearTimeout(timeout);
        if (forceKill) clearTimeout(forceKill);
        resolve(1);
      });
      child.once('close', code => {
        if (timeout) clearTimeout(timeout);
        if (forceKill) clearTimeout(forceKill);
        resolve(timedOut ? 124 : (code ?? 1));
      });
    });
    const stdoutText = Buffer.concat(stdout).toString('utf8');
    const capturedStderr = Buffer.concat(stderr).toString('utf8');
    const stderrText = timedOut
      ? [capturedStderr, `Command timed out after ${options.timeoutMs}ms.`].filter(Boolean).join('\n')
      : spawnError
      ? [capturedStderr, spawnError.message].filter(Boolean).join('\n')
      : capturedStderr;
    const result: CommandResult = {
      argv,
      cwd,
      exitCode,
      durationMs: Math.round(performance.now() - started),
      stdout: stdoutText,
      stderr: stderrText,
      stdoutTail: tail(stdoutText),
      stderrTail: tail(stderrText),
    };
    const record: CommandRecord = {
      argv: result.argv,
      cwd: result.cwd,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      stdoutTail: result.stdoutTail,
      stderrTail: result.stderrTail,
    };
    this.record(record);

    if (exitCode !== 0 && !options.allowFailure) throw new CommandError(result);
    return result;
  }
}
