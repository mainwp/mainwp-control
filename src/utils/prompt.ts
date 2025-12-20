/**
 * Interactive prompting utilities for mainwpctl
 *
 * Handles user confirmation for destructive actions.
 * Auto-declines in non-interactive mode unless explicit flags are used.
 */

import * as readline from 'node:readline';

/**
 * Check if we're in an interactive terminal
 */
export function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/**
 * Check if we should use colored output
 */
export function useColors(): boolean {
  return process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined;
}

/**
 * ANSI color codes
 */
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  dim: '\x1b[2m',
};

/**
 * Apply color if colors are enabled
 */
function color(text: string, ...codes: string[]): string {
  if (!useColors()) {
    return text;
  }
  return codes.join('') + text + colors.reset;
}

/**
 * Prompt for yes/no confirmation
 *
 * @param question - The question to ask
 * @param defaultAnswer - Default answer if user just presses Enter (default: false)
 * @returns true if user confirmed, false otherwise
 */
export async function promptForConfirmation(
  question: string,
  defaultAnswer = false
): Promise<boolean> {
  // Non-interactive mode: return default (false = safe)
  if (!isInteractive()) {
    return defaultAnswer;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const hint = defaultAnswer ? '[Y/n]' : '[y/N]';
  const prompt = color('? ', colors.yellow) + question + ' ' + color(hint, colors.dim) + ' ';

  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();

      const normalized = answer.trim().toLowerCase();

      if (normalized === '') {
        resolve(defaultAnswer);
        return;
      }

      resolve(normalized === 'y' || normalized === 'yes');
    });
  });
}

/**
 * Prompt for text input
 *
 * @param question - The question to ask
 * @param defaultValue - Default value if user just presses Enter
 * @returns The user's input (or default)
 */
export async function promptForInput(
  question: string,
  defaultValue?: string
): Promise<string> {
  if (!isInteractive()) {
    return defaultValue ?? '';
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const defaultHint = defaultValue ? color(` (${defaultValue})`, colors.dim) : '';
  const prompt = color('? ', colors.yellow) + question + defaultHint + ' ';

  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

/**
 * Prompt for password input (hidden)
 *
 * @param question - The question to ask
 * @returns The user's input
 */
export async function promptForPassword(question: string): Promise<string> {
  if (!isInteractive()) {
    return '';
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // Hide input
  const stdin = process.stdin;
  const originalRawMode = stdin.isRaw;

  return new Promise((resolve) => {
    const prompt = color('? ', colors.yellow) + question + ' ';
    process.stdout.write(prompt);

    let input = '';

    // Enable raw mode to capture individual keystrokes
    if (stdin.isTTY && stdin.setRawMode) {
      stdin.setRawMode(true);
    }

    const onData = (char: Buffer): void => {
      const c = char.toString('utf8');

      switch (c) {
        case '\n':
        case '\r':
        case '\u0004': // Ctrl-D
          // Restore raw mode and cleanup
          if (stdin.isTTY && stdin.setRawMode) {
            stdin.setRawMode(originalRawMode ?? false);
          }
          stdin.removeListener('data', onData);
          rl.close();
          process.stdout.write('\n');
          resolve(input);
          break;

        case '\u0003': // Ctrl-C
          // Restore raw mode and exit
          if (stdin.isTTY && stdin.setRawMode) {
            stdin.setRawMode(originalRawMode ?? false);
          }
          stdin.removeListener('data', onData);
          rl.close();
          process.stdout.write('\n');
          process.exit(1);
          break;

        case '\u007F': // Backspace
          if (input.length > 0) {
            input = input.slice(0, -1);
            // Clear character from display
            process.stdout.write('\b \b');
          }
          break;

        default:
          // Regular character - add to input, show asterisk
          input += c;
          process.stdout.write('*');
      }
    };

    stdin.on('data', onData);
  });
}

/**
 * Prompt for selection from a list
 *
 * @param question - The question to ask
 * @param options - Array of options to choose from
 * @returns The selected option (or undefined if cancelled)
 */
export async function promptForSelection(
  question: string,
  options: string[]
): Promise<string | undefined> {
  if (!isInteractive() || options.length === 0) {
    return undefined;
  }

  // Display options
  console.log(color('? ', colors.yellow) + question);
  options.forEach((opt, i) => {
    console.log(color(`  ${i + 1}) `, colors.dim) + opt);
  });

  const answer = await promptForInput('Enter number');
  const index = parseInt(answer, 10) - 1;

  if (isNaN(index) || index < 0 || index >= options.length) {
    return undefined;
  }

  return options[index];
}

/**
 * Display a warning and require explicit acknowledgment
 *
 * @param warning - The warning message
 * @returns true if user acknowledged, false otherwise
 */
export async function promptWithWarning(warning: string): Promise<boolean> {
  if (!isInteractive()) {
    return false;
  }

  console.log('');
  console.log(color('⚠️  WARNING', colors.yellow, colors.bold));
  console.log(warning);
  console.log('');

  return promptForConfirmation('Do you want to continue?', false);
}

/**
 * Display a destructive action confirmation
 *
 * Shows a prominent warning and requires typing "yes" to confirm.
 */
export async function promptDestructiveConfirmation(
  action: string,
  details?: string
): Promise<boolean> {
  if (!isInteractive()) {
    return false;
  }

  console.log('');
  console.log(color('🛑 DESTRUCTIVE ACTION', colors.red, colors.bold));
  console.log(action);

  if (details) {
    console.log('');
    console.log(color('Details:', colors.dim));
    console.log(details);
  }

  console.log('');
  console.log('Type "yes" to confirm, or anything else to cancel.');

  const answer = await promptForInput('Confirm');

  return answer.toLowerCase() === 'yes';
}
