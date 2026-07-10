/**
 * Interactive prompting utilities for mainwpcontrol
 *
 * Handles user confirmation for destructive actions.
 * Auto-declines in non-interactive mode unless explicit flags are used.
 */

import * as readline from 'node:readline';
import { colors, color } from './colors.js';

/**
 * Check if we're in an interactive terminal
 */
export function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/**
 * Ask a single question via readline, returning the raw answer.
 * Handles interface creation and cleanup.
 */
function ask(promptText: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
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
  if (!isInteractive()) {
    return defaultAnswer;
  }

  const hint = defaultAnswer ? '[Y/n]' : '[y/N]';
  const prompt = color('? ', colors.yellow) + question + ' ' + color(hint, colors.dim) + ' ';

  const answer = await ask(prompt);
  const normalized = answer.trim().toLowerCase();

  if (normalized === '') return defaultAnswer;
  return normalized === 'y' || normalized === 'yes';
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

  const defaultHint = defaultValue ? color(` (${defaultValue})`, colors.dim) : '';
  const prompt = color('? ', colors.yellow) + question + defaultHint + ' ';

  const answer = await ask(prompt);
  return answer.trim() || defaultValue || '';
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
          // 130 = 128 + SIGINT(2), the standard Unix convention for Ctrl-C.
          // Intentionally outside the documented 0-5 exit code contract —
          // see README's Exit Codes table for the carve-out.
          process.exit(130);
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

