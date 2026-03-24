/**
 * Oclif hook: command_not_found
 *
 * Provides helpful suggestions when a user enters an unknown command:
 * 1. Ability names typed as commands → suggest `abilities run <name>`
 * 2. Typos in known commands → "Did you mean ...?"
 * 3. Everything else → generic error with help hint
 */

import { Hook } from '@oclif/core';

/** Simple Levenshtein distance (no external deps) */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array<number>(n + 1).fill(0),
  );
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1]![j - 1]!
          : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
    }
  }
  return dp[m]![n]!;
}

const hook: Hook<'command_not_found'> = async function ({ id, config }) {
  // Strip common prefix mistakes (e.g., "mainwp/list-updates-v1")
  const name = id.replace(/^mainwp\//, '');

  // Ability name pattern: suggest abilities run
  if (/-v\d+$/.test(name)) {
    const suggestion = `${config.bin} abilities run ${name}`;
    this.error(
      `"${id}" is not a command. It looks like an ability name.\n\nRun it with:\n  ${suggestion}`,
      { exit: 1 },
    );
  }

  // Find closest matching command using Levenshtein distance
  const commandIDs = [
    ...config.commandIDs,
    ...config.commands.flatMap((c) => c.aliases),
  ].filter(
    (cid) => !config.commands.find((cmd) => cmd.id === cid)?.hidden,
  );

  if (commandIDs.length > 0) {
    const matches = commandIDs
      .map((cmd) => ({ cmd, distance: levenshtein(id, cmd) }))
      .sort((a, b) => a.distance - b.distance);

    const best = matches[0];
    const threshold = Math.max(Math.ceil(id.length * 0.4), 3);
    if (best && best.distance <= threshold) {
      // Convert oclif internal separator (:) to display format (space)
      const displayCmd = best.cmd.replace(/:/g, ' ');
      this.error(
        `"${id.replace(/:/g, ' ')}" is not a ${config.bin} command. Did you mean "${displayCmd}"?\n\nRun ${config.bin} help for a list of available commands.`,
        { exit: 127 },
      );
    }
  }

  // Fallback: no close match found
  this.error(
    `command "${id.replace(/:/g, ' ')}" not found. Run ${config.bin} help for a list of available commands.`,
    { exit: 2 },
  );
};

export default hook;
