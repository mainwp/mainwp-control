import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promptForPassword } from './prompt.js';

type FakeTtyStdin = PassThrough & {
  isTTY: boolean;
  isRaw: boolean;
  setRawMode: ReturnType<typeof vi.fn>;
};

// A terminal in raw mode delivers Enter as its own chunk; writing it on a later
// tick keeps the stream from coalescing it with the typed characters.
async function typeLine(stream: PassThrough, text: string): Promise<void> {
  stream.write(text);
  await new Promise((resolve) => setImmediate(resolve));
  stream.write('\r');
}

function createFakeTtyStdin(): FakeTtyStdin {
  const stream = new PassThrough() as FakeTtyStdin;
  stream.isTTY = true;
  stream.isRaw = false;
  stream.setRawMode = vi.fn((mode: boolean) => {
    stream.isRaw = mode;
    return stream;
  });
  return stream;
}

describe('promptForPassword', () => {
  let stdin: FakeTtyStdin;

  beforeEach(() => {
    stdin = createFakeTtyStdin();
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(stdin as unknown as typeof process.stdin);
    vi.spyOn(process, 'stdout', 'get').mockReturnValue({
      isTTY: true,
      write: vi.fn(() => true),
    } as unknown as typeof process.stdout);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads the password when an earlier prompt left stdin paused', { timeout: 2000 }, async () => {
    // readline's close() pauses stdin, which is the state login leaves it in
    // after asking for the URL and username.
    stdin.pause();

    const answer = promptForPassword('Application password');
    await typeLine(stdin, 'secret');

    await expect(answer).resolves.toBe('secret');
  });

  it('pauses stdin and restores the terminal mode once the password is entered', { timeout: 2000 }, async () => {
    const answer = promptForPassword('Application password');
    await typeLine(stdin, 'secret');
    await answer;

    expect(stdin.setRawMode).toHaveBeenNthCalledWith(1, true);
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
    expect(stdin.isPaused()).toBe(true);
  });
});
