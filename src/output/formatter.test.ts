/**
 * Tests for formatter output sanitization
 */

import { describe, it, expect } from 'vitest';
import {
  formatError,
  formatWarning,
  formatKeyValue,
  formatTable,
  formatList,
  formatPreview,
  formatDivider,
  formatSection,
  formatStatusIcon,
  getStatusColor,
  formatHeading,
  formatSuccess,
  formatInfo,
} from './formatter.js';
import { colors } from '../utils/colors.js';
import { InputError } from '../utils/errors.js';

describe('formatError credential redaction', () => {
  it.each([
    ['Bearer token', 'Request failed with Bearer abc123secret', 'abc123secret', 'Bearer [REDACTED]'],
    ['credential URL', 'Request failed at https://user:pass@host/x', 'user:pass', '[URL_WITH_CREDENTIALS]'],
  ])('redacts %s credentials from Error messages', (_label, message, secret, marker) => {
    const output = formatError(new Error(message));

    expect(output).not.toContain(secret);
    expect(output).toContain(marker);
  });

  it('redacts credentials from error details and hints', () => {
    const output = formatError(
      new InputError(
        'Request failed with Bearer message-secret',
        { endpoint: 'https://detail-user:detail-pass@host/x' },
        'Retry with Bearer hint-secret'
      )
    );

    expect(output).not.toContain('message-secret');
    expect(output).not.toContain('detail-user:detail-pass');
    expect(output).not.toContain('hint-secret');
  });
});

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

  it('collapses warning messages to one terminal row', () => {
    expect(formatWarning('first\r\nsecond\tvalue')).toContain(
      'first second value'
    );
  });
});

describe('single-row formatter sanitization', () => {
  it('collapses keys, table cells, list items, and preview actions', () => {
    expect(formatKeyValue('multi\nline', 'value')).toContain('multi line:');
    expect(formatTable(['head\ner'], [['cell\r\nvalue']])).toContain('head er');
    expect(formatTable(['head\ner'], [['cell\r\nvalue']])).toContain('cell value');
    expect(formatList(['list\nitem'])).toContain('list item');
    expect(formatPreview('delete\nsite', [])).toContain('delete site');
  });

  it('collapses a lone carriage return in a key-value value', () => {
    // stripControlChars preserves \r by design, so a value carrying one would
    // return the cursor to column 0 and overwrite the row already printed.
    const result = formatKeyValue('Category', 'EvilCategory\rOVERWRITTEN');

    expect(result).not.toContain('\r');
    expect(result).toContain('EvilCategory OVERWRITTEN');
  });
});

describe('heading/success/info sanitization (F2/F5/F7)', () => {
  it('strips escape sequences and collapses newlines in headings', () => {
    // Untrusted ability category/label reaches formatHeading on the human path.
    const malicious = '\x1b[2JCategory\r\nInjected line\x1b]0;title\x07';
    const result = formatHeading(malicious);

    expect(result).not.toContain('\x1b');
    expect(result).not.toContain('\r');
    expect(result).not.toContain('\n');
    expect(result).toContain('Category Injected line');
  });

  it('strips escape sequences from success messages', () => {
    const result = formatSuccess('\x1b[2JDone\r\nfaked');
    expect(result).not.toContain('\x1b');
    expect(result).toContain('Done faked');
  });

  it('strips escape sequences from info messages', () => {
    const result = formatInfo('\x1b]0;pwn\x07Heads up\nsecond');
    expect(result).not.toContain('\x1b');
    expect(result).toContain('Heads up second');
  });
});

describe('formatDivider', () => {
  it('renders a 40-character divider by default, matching doctor/config-show reports', () => {
    expect(formatDivider()).toBe('  ' + '─'.repeat(40));
  });

  it('honors a custom width', () => {
    expect(formatDivider(10)).toBe('  ' + '─'.repeat(10));
  });
});

describe('formatSection', () => {
  it('joins a title and pre-formatted rows into a single block', () => {
    const result = formatSection('Settings', ['    Timeout:  1000ms', '    Debug:    Disabled']);

    expect(result).toContain('Settings');
    expect(result).toContain('    Timeout:  1000ms');
    expect(result).toContain('    Debug:    Disabled');
  });

  it('renders a title with no rows', () => {
    const result = formatSection('Empty Section', []);

    expect(result).toContain('Empty Section');
  });
});

describe('formatStatusIcon / getStatusColor', () => {
  it('maps pass/warn/fail to distinct icons', () => {
    expect(formatStatusIcon('pass')).toContain('✓');
    expect(formatStatusIcon('warn')).toContain('⚠');
    expect(formatStatusIcon('fail')).toContain('✗');
  });

  it('maps pass/warn/fail to their color codes', () => {
    expect(getStatusColor('pass')).toBe(colors.green);
    expect(getStatusColor('warn')).toBe(colors.yellow);
    expect(getStatusColor('fail')).toBe(colors.red);
  });
});
