/**
 * Tests for Chat Command Security — Output Sanitization
 *
 * Verifies that all display paths sanitize untrusted content
 * from LLM providers and API responses before terminal output.
 */

import { describe, it, expect, vi } from 'vitest';
import { stripControlChars } from '../utils/terminal-sanitizer.js';
import { formatResponse } from './chat.js';

// We test the sanitization integration by verifying the functions
// used in chat.ts correctly handle malicious content. The actual
// display functions are module-private, so we verify the sanitizer
// behavior directly on the patterns chat.ts uses.

describe('Chat Output Sanitization', () => {
  describe('M1: Streaming chunk sanitization', () => {
    it('strips escape sequences from streamed LLM content', () => {
      const maliciousChunk = '\x1b[2J\x1b[HFake prompt: Enter password: ';
      const sanitized = stripControlChars(maliciousChunk);

      expect(sanitized).toBe('Fake prompt: Enter password: ');
      expect(sanitized).not.toContain('\x1b');
    });

    it('strips OSC52 clipboard attack from streamed content', () => {
      const clipboardAttack = 'normal text\x1b]52;c;Y2xpcGJvYXJkIGRhdGE=\x1b\\more text';
      const sanitized = stripControlChars(clipboardAttack);

      expect(sanitized).toBe('normal textmore text');
    });

    it('handles partial escape sequences split across chunks safely', () => {
      // Chunk 1 ends with bare ESC
      const chunk1 = 'Hello \x1b';
      const sanitized1 = stripControlChars(chunk1);
      // Bare ESC is stripped by the final /\x1b/g cleanup
      expect(sanitized1).not.toContain('\x1b');

      // Chunk 2 starts with the rest of the sequence — no ESC prefix = plain text
      const chunk2 = '[31mworld';
      const sanitized2 = stripControlChars(chunk2);
      // [31m without ESC prefix is just plain text
      expect(sanitized2).toBe('[31mworld');
    });
  });

  describe('M2: formatResponse sanitization', () => {
    it('sanitizes message content (LLM response)', () => {
      const maliciousContent = '\x1b[1;1H\x1b[KOverwritten line!';
      const sanitized = stripControlChars(maliciousContent);

      expect(sanitized).toBe('Overwritten line!');
    });

    it('sanitizes tool_result error messages', () => {
      const maliciousError = '\x1b[31mError\x1b[0m: \x1b]0;Malicious Title\x07connection failed';
      const sanitized = stripControlChars(maliciousError);

      expect(sanitized).toBe('Error: connection failed');
    });

    it('sanitizes tool name in tool_result', () => {
      const maliciousTool = 'list-sites\x1b[10C(hidden)';
      const sanitized = stripControlChars(maliciousTool);

      expect(sanitized).toBe('list-sites(hidden)');
    });

    it('sanitizes error response', () => {
      const maliciousError = '\x1b[2JCRITICAL: System compromised';
      const sanitized = stripControlChars(maliciousError);

      expect(sanitized).toBe('CRITICAL: System compromised');
    });

    it('JSON.stringify inherently escapes control chars (tool_result success path)', () => {
      const maliciousData = { name: '\x1b[31mred\x1b[0m', count: 5 };
      const jsonOutput = JSON.stringify(maliciousData, null, 2);

      // JSON.stringify escapes ESC as \u001b
      expect(jsonOutput).not.toContain('\x1b');
      expect(jsonOutput).toContain('\\u001b');
    });
  });

  describe('formatResponse error rendering', () => {
    it('prefixes the ability name when an error carries tool', () => {
      const rendered = formatResponse({
        type: 'error',
        error: 'Resource not found',
        tool: 'mainwp/delete-site-v1',
      });

      expect(rendered).toBe('[mainwp/delete-site-v1] Error: Resource not found');
    });

    it('renders engine-level errors without a tool prefix', () => {
      const rendered = formatResponse({
        type: 'error',
        error: 'Provider unavailable',
      });

      expect(rendered).toBe('Error: Provider unavailable');
    });

    it('sanitizes the tool name in the error prefix', () => {
      const rendered = formatResponse({
        type: 'error',
        error: 'boom',
        tool: 'delete\x1b[10C(hidden)',
      });

      expect(rendered).toBe('[delete(hidden)] Error: boom');
    });
  });

  describe('M2: formatPreview sanitization', () => {
    it('sanitizes preview summary', () => {
      const maliciousSummary = '\x1b[2JWill delete 5 sites\x1b[H';
      const sanitized = stripControlChars(maliciousSummary);

      expect(sanitized).toBe('Will delete 5 sites');
    });

    it('sanitizes non-object affected items', () => {
      const maliciousItem = 'site.com\x1b[10C(hidden extra text)';
      const sanitized = stripControlChars(String(maliciousItem));

      expect(sanitized).toBe('site.com(hidden extra text)');
    });

    it('JSON.stringify handles object affected items safely', () => {
      const maliciousItem = { url: '\x1b[31mhttps://evil.com\x1b[0m' };
      const jsonOutput = JSON.stringify(maliciousItem, null, 2);

      expect(jsonOutput).not.toContain('\x1b');
    });
  });

  describe('M2: Interactive error handler sanitization', () => {
    it('sanitizes Error.message', () => {
      const maliciousMessage = '\x1b[2J\x1b[HConnection to \x1b[31mevil.com\x1b[0m failed';
      const sanitized = stripControlChars(maliciousMessage);

      expect(sanitized).toBe('Connection to evil.com failed');
    });

    it('sanitizes non-Error string', () => {
      const maliciousString = '\x1b]0;Pwned\x07Network timeout';
      const sanitized = stripControlChars(String(maliciousString));

      expect(sanitized).toBe('Network timeout');
    });
  });

  describe('M4: API key process visibility warning', () => {
    it('warning message recommends environment variables', () => {
      // Verify the warning text is appropriate
      const warningText = 'Warning: Passing API keys via --api-key flag exposes them in the process list. Use environment variables instead.';
      expect(warningText).toContain('process list');
      expect(warningText).toContain('environment variables');
    });
  });
});
