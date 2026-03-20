/**
 * Tests for formatter output sanitization
 */

import { describe, it, expect } from 'vitest';
import { formatWarning } from './formatter.js';

describe('M5: formatWarning sanitization', () => {
  it('strips escape sequences from warning messages', () => {
    const malicious = '\x1b[2J\x1b[HFake warning with screen clear';
    const result = formatWarning(malicious);

    expect(result).not.toContain('\x1b');
    expect(result).toContain('Fake warning with screen clear');
    expect(result).toContain('Warning:');
  });

  it('strips OSC sequences from batch job error messages', () => {
    const malicious = '\x1b]0;Pwned\x07Site update failed';
    const result = formatWarning(malicious);

    expect(result).not.toContain('\x1b');
    expect(result).toContain('Site update failed');
  });

  it('passes through clean messages unchanged', () => {
    const clean = 'Normal warning message';
    const result = formatWarning(clean);

    expect(result).toContain(clean);
  });
});
