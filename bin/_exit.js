// Shared entrypoint setup: SIGPIPE handling and clean exit for native addons.

// SIGPIPE: exit cleanly when piped to `head`, `grep -q`, etc.
process.on('SIGPIPE', () => process.exit(0));

// Force exit to prevent native addon handles (e.g. keytar) from keeping
// the process alive. Drain stdout/stderr first to avoid truncating piped output.
const drain = (s) => new Promise((resolve) => s.write('', resolve));
export async function drainAndExit() {
  await Promise.all([drain(process.stdout), drain(process.stderr)]);
  process.exit(process.exitCode ?? 0);
}
