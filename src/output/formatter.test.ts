/**
 * Tests for formatter output sanitization
 */

import { describe, it, expect } from 'vitest';
import {
  formatWarning,
  formatDivider,
  formatSection,
  formatStatusIcon,
  getStatusColor,
} from './formatter.js';
import { colors } from '../utils/colors.js';

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
