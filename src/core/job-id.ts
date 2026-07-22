import { APIError } from '../utils/errors.js';

const MAX_JOB_ID_BYTES = 512;

function hasUnsafeCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069);
  });
}

export function validateJobId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    Buffer.byteLength(value, 'utf8') > MAX_JOB_ID_BYTES ||
    hasUnsafeCharacters(value)
  ) {
    throw new APIError('INVALID_RESPONSE', 'Job response contains an invalid job ID');
  }

  return value;
}
