/**
 * Tests for Terminal Output Sanitizer
 *
 * Security tests verifying escape sequence stripping to prevent:
 * - Terminal escape sequence injection
 * - Fake prompt attacks
 * - Screen manipulation/overwriting
 * - OSC command execution
 */

import { describe, it, expect } from 'vitest';
import {
  stripControlChars,
  sanitizeForTerminal,
  safeString,
  containsEscapeSequences,
} from './terminal-sanitizer.js';

describe('stripControlChars', () => {
  describe('ANSI CSI sequences', () => {
    it('strips color codes', () => {
      const colored = '\x1b[31mred text\x1b[0m';
      expect(stripControlChars(colored)).toBe('red text');
    });

    it('strips bold/underline formatting', () => {
      const formatted = '\x1b[1mbold\x1b[0m \x1b[4munderline\x1b[0m';
      expect(stripControlChars(formatted)).toBe('bold underline');
    });

    it('strips cursor movement sequences', () => {
      const cursorMove = '\x1b[10;20Hmoved text\x1b[A\x1b[B\x1b[C\x1b[D';
      expect(stripControlChars(cursorMove)).toBe('moved text');
    });

    it('strips screen clearing sequences', () => {
      const clearScreen = '\x1b[2Jcleared\x1b[K';
      expect(stripControlChars(clearScreen)).toBe('cleared');
    });

    it('strips scrolling sequences', () => {
      const scroll = '\x1b[5Sscrolled\x1b[5T';
      expect(stripControlChars(scroll)).toBe('scrolled');
    });
  });

  describe('OSC sequences', () => {
    it('strips window title commands', () => {
      const title = '\x1b]0;Malicious Title\x07normal text';
      expect(stripControlChars(title)).toBe('normal text');
    });

    it('strips OSC with ST terminator', () => {
      const osc = '\x1b]52;c;Y2xpcGJvYXJkIGRhdGE=\x1b\\normal text';
      expect(stripControlChars(osc)).toBe('normal text');
    });

    it('strips hyperlink OSC sequences', () => {
      const hyperlink = '\x1b]8;;https://evil.com\x07click here\x1b]8;;\x07';
      expect(stripControlChars(hyperlink)).toBe('click here');
    });
  });

  describe('C0 control characters', () => {
    it('strips bell character', () => {
      const bell = 'alert\x07sound';
      expect(stripControlChars(bell)).toBe('alertsound');
    });

    it('strips backspace', () => {
      const backspace = 'pass\x08\x08\x08\x08word';
      expect(stripControlChars(backspace)).toBe('password');
    });

    it('strips form feed', () => {
      const formFeed = 'page\x0cbreak';
      expect(stripControlChars(formFeed)).toBe('pagebreak');
    });

    it('preserves tab, newline, carriage return', () => {
      const whitespace = 'line1\nline2\r\ntab\there';
      expect(stripControlChars(whitespace)).toBe('line1\nline2\r\ntab\there');
    });

    it('strips null bytes', () => {
      const nullByte = 'null\x00byte';
      expect(stripControlChars(nullByte)).toBe('nullbyte');
    });
  });

  describe('C1 control characters', () => {
    it('strips C1 control range (0x80-0x9F)', () => {
      const c1 = 'before\x80\x90\x9Fafter';
      expect(stripControlChars(c1)).toBe('beforeafter');
    });
  });

  describe('DCS, APC, PM, SOS sequences', () => {
    it('strips Device Control String', () => {
      const dcs = '\x1bPdevice control\x1b\\normal';
      expect(stripControlChars(dcs)).toBe('normal');
    });

    it('strips Application Program Command', () => {
      const apc = '\x1b_app command\x1b\\normal';
      expect(stripControlChars(apc)).toBe('normal');
    });

    it('strips Privacy Message', () => {
      const pm = '\x1b^private\x1b\\normal';
      expect(stripControlChars(pm)).toBe('normal');
    });

    it('strips Start of String', () => {
      const sos = '\x1bXstring\x1b\\normal';
      expect(stripControlChars(sos)).toBe('normal');
    });
  });

  describe('fake prompt attacks', () => {
    it('strips screen clear + fake prompt injection', () => {
      const attack = '\x1b[2J\x1b[HFAKE PROMPT: Enter password: ';
      expect(stripControlChars(attack)).toBe('FAKE PROMPT: Enter password: ');
    });

    it('strips cursor positioning for output overwrite', () => {
      const attack = '\x1b[1;1H\x1b[KMalicious content overwriting line 1';
      expect(stripControlChars(attack)).toBe('Malicious content overwriting line 1');
    });
  });

  describe('edge cases', () => {
    it('handles empty string', () => {
      expect(stripControlChars('')).toBe('');
    });

    it('handles non-string input', () => {
      expect(stripControlChars(null as unknown as string)).toBe('');
      expect(stripControlChars(undefined as unknown as string)).toBe('');
      expect(stripControlChars(123 as unknown as string)).toBe('');
    });

    it('handles string with no control characters', () => {
      const clean = 'Normal text with no escapes!';
      expect(stripControlChars(clean)).toBe(clean);
    });

    it('handles bare ESC character', () => {
      // ESC followed by 'a' matches single-character escape pattern, so both get stripped
      const bare = 'before\x1bafter';
      expect(stripControlChars(bare)).toBe('beforefter');
    });

    it('handles nested escape sequences', () => {
      const nested = '\x1b[31m\x1b[1mred bold\x1b[0m\x1b[0m';
      expect(stripControlChars(nested)).toBe('red bold');
    });

    it('preserves unicode characters', () => {
      const unicode = '日本語 emoji 🎉 symbols ★☆♠';
      expect(stripControlChars(unicode)).toBe(unicode);
    });
  });
});

describe('sanitizeForTerminal', () => {
  it('sanitizes strings', () => {
    expect(sanitizeForTerminal('\x1b[31mred\x1b[0m')).toBe('red');
  });

  it('passes through numbers', () => {
    expect(sanitizeForTerminal(42)).toBe(42);
    expect(sanitizeForTerminal(3.14)).toBe(3.14);
  });

  it('passes through booleans', () => {
    expect(sanitizeForTerminal(true)).toBe(true);
    expect(sanitizeForTerminal(false)).toBe(false);
  });

  it('passes through null and undefined', () => {
    expect(sanitizeForTerminal(null)).toBe(null);
    expect(sanitizeForTerminal(undefined)).toBe(undefined);
  });

  it('recursively sanitizes arrays', () => {
    const input = ['normal', '\x1b[31mred\x1b[0m', 123];
    expect(sanitizeForTerminal(input)).toEqual(['normal', 'red', 123]);
  });

  it('recursively sanitizes objects', () => {
    const input = {
      name: '\x1b[1mbold\x1b[0m',
      count: 5,
      nested: {
        value: '\x1b[32mgreen\x1b[0m',
      },
    };
    expect(sanitizeForTerminal(input)).toEqual({
      name: 'bold',
      count: 5,
      nested: {
        value: 'green',
      },
    });
  });

  it('sanitizes object keys', () => {
    const input = {
      '\x1b[31mredKey\x1b[0m': 'value',
    };
    expect(sanitizeForTerminal(input)).toEqual({
      'redKey': 'value',
    });
  });

  it('handles deeply nested structures', () => {
    const input = {
      level1: {
        level2: {
          level3: {
            value: '\x1b[36mcyan\x1b[0m',
          },
        },
      },
    };
    expect(sanitizeForTerminal(input)).toEqual({
      level1: {
        level2: {
          level3: {
            value: 'cyan',
          },
        },
      },
    });
  });
});

describe('safeString', () => {
  it('converts null to string', () => {
    expect(safeString(null)).toBe('null');
  });

  it('converts undefined to string', () => {
    expect(safeString(undefined)).toBe('undefined');
  });

  it('sanitizes strings', () => {
    expect(safeString('\x1b[31mred\x1b[0m')).toBe('red');
  });

  it('converts numbers to string', () => {
    expect(safeString(42)).toBe('42');
  });

  it('converts booleans to string', () => {
    expect(safeString(true)).toBe('true');
  });

  it('JSON stringifies objects with sanitization', () => {
    const input = { name: '\x1b[1mbold\x1b[0m' };
    expect(safeString(input)).toBe('{"name":"bold"}');
  });

  it('JSON stringifies arrays with sanitization', () => {
    const input = ['\x1b[31mred\x1b[0m', 'green'];
    expect(safeString(input)).toBe('["red","green"]');
  });
});

describe('containsEscapeSequences', () => {
  it('detects ANSI CSI sequences', () => {
    expect(containsEscapeSequences('\x1b[31mred\x1b[0m')).toBe(true);
  });

  it('detects OSC sequences', () => {
    expect(containsEscapeSequences('\x1b]0;title\x07')).toBe(true);
  });

  it('detects bare ESC character', () => {
    expect(containsEscapeSequences('before\x1bafter')).toBe(true);
  });

  it('detects C1 control characters', () => {
    expect(containsEscapeSequences('text\x90more')).toBe(true);
  });

  it('returns false for clean strings', () => {
    expect(containsEscapeSequences('normal text')).toBe(false);
  });

  it('returns false for non-strings', () => {
    expect(containsEscapeSequences(null as unknown as string)).toBe(false);
    expect(containsEscapeSequences(123 as unknown as string)).toBe(false);
  });
});

describe('Security Golden Tests', () => {
  /**
   * GOLDEN TEST: API response injection prevention
   *
   * Simulates a malicious API response attempting to inject escape sequences
   */
  it('prevents API response injection attack', () => {
    const maliciousApiResponse = {
      site_name: '\x1b[2J\x1b[HWARNING: Your system is compromised!',
      url: 'https://evil.com\x1b]8;;https://malware.com\x07',
      status: '\x1b[31mCRITICAL\x1b[0m',
    };

    const sanitized = sanitizeForTerminal(maliciousApiResponse);

    expect(sanitized).toEqual({
      site_name: 'WARNING: Your system is compromised!',
      url: 'https://evil.com',
      status: 'CRITICAL',
    });

    // Verify no escape sequences remain
    expect(containsEscapeSequences(JSON.stringify(sanitized))).toBe(false);
  });

  /**
   * GOLDEN TEST: Error message injection prevention
   */
  it('prevents error message injection attack', () => {
    const maliciousError = '\x1b[1;1H\x1b[2KAuthentication successful!\x1b[10;1H';
    const sanitized = stripControlChars(maliciousError);

    expect(sanitized).toBe('Authentication successful!');
    expect(containsEscapeSequences(sanitized)).toBe(false);
  });

  /**
   * GOLDEN TEST: Table data injection prevention
   */
  it('prevents table data injection attack', () => {
    const maliciousTableData = [
      ['Site 1', 'https://site1.local', '\x1b[32mHealthy\x1b[0m'],
      ['Site 2\x1b[10C(hidden)', 'https://site2.local', 'Unknown'],
    ];

    const sanitized = sanitizeForTerminal(maliciousTableData);

    expect(sanitized).toEqual([
      ['Site 1', 'https://site1.local', 'Healthy'],
      ['Site 2(hidden)', 'https://site2.local', 'Unknown'],
    ]);
  });
});
