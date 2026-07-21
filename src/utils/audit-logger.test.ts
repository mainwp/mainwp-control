/**
 * Tests for audit-logger
 */

import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** Platform-aware expected path for audit.log (matches production join()) */
const MOCK_LOG = join('/mock/config', 'audit.log');

// Mock dependencies before importing the module under test
const mockMkdir = vi.fn();
const mockChmod = vi.fn();
const mockStat = vi.fn();
const mockUnlink = vi.fn();
const mockRename = vi.fn();
const mockOpen = vi.fn();
const mockHandleChmod = vi.fn();
const mockHandleWriteFile = vi.fn();
const mockHandleClose = vi.fn();

vi.mock('node:fs', () => ({
  constants: {
    O_APPEND: 1,
    O_CREAT: 2,
    O_WRONLY: 4,
    O_NOFOLLOW: 8,
  },
  promises: {
    mkdir: (...args: unknown[]) => mockMkdir(...args),
    chmod: (...args: unknown[]) => mockChmod(...args),
    stat: (...args: unknown[]) => mockStat(...args),
    unlink: (...args: unknown[]) => mockUnlink(...args),
    rename: (...args: unknown[]) => mockRename(...args),
    open: (...args: unknown[]) => mockOpen(...args),
  },
}));

vi.mock('../config/settings.js', () => ({
  getConfigDir: vi.fn(() => '/mock/config'),
}));

const mockRedactSensitive = vi.fn((data: Record<string, unknown>) => data);
vi.mock('../validation/input-sanitizer.js', () => ({
  getInputSanitizer: vi.fn(() => ({
    redactSensitive: mockRedactSensitive,
  })),
}));

import {
  AuditLogger,
  getAuditLogger,
  getAuditLogPath,
  logDestructiveActionSafe,
  type LogDestructiveActionInput,
} from './audit-logger.js';

describe('AuditLogger', () => {
  let logger: AuditLogger;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ now: new Date('2026-03-18T12:00:00.000Z') });

    // Default: file exists, not needing rotation
    mockMkdir.mockResolvedValue(undefined);
    mockChmod.mockResolvedValue(undefined);
    mockStat.mockResolvedValue({ size: 100 });
    mockHandleChmod.mockResolvedValue(undefined);
    mockHandleWriteFile.mockResolvedValue(undefined);
    mockHandleClose.mockResolvedValue(undefined);
    mockOpen.mockResolvedValue({
      chmod: mockHandleChmod,
      writeFile: mockHandleWriteFile,
      close: mockHandleClose,
    });

    logger = new AuditLogger();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('getAuditLogPath', () => {
    it('returns path inside config directory', () => {
      expect(getAuditLogPath()).toBe(MOCK_LOG);
    });
  });

  describe('getAuditLogger', () => {
    it('returns a singleton instance', () => {
      const a = getAuditLogger();
      const b = getAuditLogger();
      expect(a).toBe(b);
      expect(a).toBeInstanceOf(AuditLogger);
    });
  });

  describe('logDestructiveAction', () => {
    const baseInput: LogDestructiveActionInput = {
      abilityName: 'mainwp/delete-site-v1',
      userDecision: 'approved',
      input: { site_id: 123 },
    };

    it('writes NDJSON line with correct structure', async () => {
      await logger.logDestructiveAction(baseInput);

      expect(mockHandleWriteFile).toHaveBeenCalledTimes(1);
      const [content] = mockHandleWriteFile.mock.calls[0]!;
      expect(mockOpen).toHaveBeenCalledWith(
        MOCK_LOG,
        process.platform === 'win32' ? 7 : 15,
        0o600,
      );

      const entry = JSON.parse(content.trim());
      expect(entry.timestamp).toBe('2026-03-18T12:00:00.000Z');
      expect(entry.abilityName).toBe('mainwp/delete-site-v1');
      expect(entry.userDecision).toBe('approved');
      expect(entry.input).toEqual({ site_id: 123 });
      // Content ends with newline (NDJSON format)
      expect(content.endsWith('\n')).toBe(true);
    });

    it('includes preview when provided', async () => {
      await logger.logDestructiveAction({
        ...baseInput,
        preview: { summary: 'Delete 1 site', affectedCount: 1 },
      });

      const entry = JSON.parse(mockHandleWriteFile.mock.calls[0]![0].trim());
      expect(entry.preview).toEqual({ summary: 'Delete 1 site', affectedCount: 1 });
    });

    it('includes execution when provided', async () => {
      await logger.logDestructiveAction({
        ...baseInput,
        execution: { success: true },
      });

      const entry = JSON.parse(mockHandleWriteFile.mock.calls[0]![0].trim());
      expect(entry.execution).toEqual({ success: true });
    });

    it('includes execution error when present', async () => {
      await logger.logDestructiveAction({
        ...baseInput,
        execution: { success: false, error: 'Site not found' },
      });

      const entry = JSON.parse(mockHandleWriteFile.mock.calls[0]![0].trim());
      expect(entry.execution).toEqual({ success: false, error: 'Site not found' });
    });

    it('omits preview and execution when not provided', async () => {
      await logger.logDestructiveAction(baseInput);

      const entry = JSON.parse(mockHandleWriteFile.mock.calls[0]![0].trim());
      expect(entry).not.toHaveProperty('preview');
      expect(entry).not.toHaveProperty('execution');
    });

    it('logs declined actions', async () => {
      await logger.logDestructiveAction({
        ...baseInput,
        userDecision: 'declined',
      });

      const entry = JSON.parse(mockHandleWriteFile.mock.calls[0]![0].trim());
      expect(entry.userDecision).toBe('declined');
    });

    it('redacts sensitive data from input', async () => {
      mockRedactSensitive.mockReturnValueOnce({ site_id: 123, password: '[REDACTED]' });

      await logger.logDestructiveAction({
        ...baseInput,
        input: { site_id: 123, password: 'secret' },
      });

      expect(mockRedactSensitive).toHaveBeenCalledWith({ site_id: 123, password: 'secret' });
      const entry = JSON.parse(mockHandleWriteFile.mock.calls[0]![0].trim());
      expect(entry.input.password).toBe('[REDACTED]');
    });

    it('bounds oversized redacted input and records an explicit truncation marker', async () => {
      mockRedactSensitive.mockReturnValueOnce({ payload: 'x'.repeat(20_000) });

      await logger.logDestructiveAction({
        ...baseInput,
        input: { payload: 'x'.repeat(20_000) },
      });

      const entry = JSON.parse(mockHandleWriteFile.mock.calls[0]![0].trim());
      expect(Buffer.byteLength(JSON.stringify(entry.input), 'utf8')).toBeLessThanOrEqual(8 * 1024);
      expect(entry.inputTruncated).toEqual({
        marker: 'TRUNCATED',
        originalBytes: 20_014,
        limitBytes: 8 * 1024,
      });
    });

    it('creates config directory with restricted permissions', async () => {
      await logger.logDestructiveAction(baseInput);

      expect(mockMkdir).toHaveBeenCalledWith('/mock/config', {
        recursive: true,
        mode: 0o700,
      });
      expect(mockChmod).toHaveBeenCalledWith('/mock/config', 0o700);
    });

    it('opens the log atomically in append mode and restricts permissions', async () => {
      await logger.logDestructiveAction(baseInput);

      expect(mockOpen).toHaveBeenCalledWith(
        MOCK_LOG,
        process.platform === 'win32' ? 7 : 15,
        0o600,
      );
      expect(mockHandleChmod).toHaveBeenCalledWith(0o600);
      expect(mockHandleClose).toHaveBeenCalled();
    });

    it('continues logging when directory permission self-healing fails', async () => {
      mockChmod.mockRejectedValueOnce(new Error('EPERM'));

      await expect(logger.logDestructiveAction(baseInput)).resolves.not.toThrow();

      expect(mockHandleWriteFile).toHaveBeenCalledTimes(1);
    });

    it('continues logging when file permission self-healing fails', async () => {
      mockHandleChmod.mockRejectedValueOnce(new Error('EPERM'));

      await expect(logger.logDestructiveAction(baseInput)).resolves.not.toThrow();

      expect(mockHandleWriteFile).toHaveBeenCalledTimes(1);
      expect(mockHandleClose).toHaveBeenCalled();
    });
  });

  describe('log rotation', () => {
    it('does not rotate when file is under 10MB', async () => {
      mockStat.mockResolvedValue({ size: 5 * 1024 * 1024 });

      await logger.logDestructiveAction({
        abilityName: 'test',
        userDecision: 'approved',
        input: {},
      });

      expect(mockRename).not.toHaveBeenCalled();
      expect(mockUnlink).not.toHaveBeenCalled();
    });

    it('rotates when file exceeds 10MB', async () => {
      mockStat.mockResolvedValue({ size: 11 * 1024 * 1024 });
      mockUnlink.mockResolvedValue(undefined);
      mockRename.mockResolvedValue(undefined);

      await logger.logDestructiveAction({
        abilityName: 'test',
        userDecision: 'approved',
        input: {},
      });

      // Deletes oldest (audit.log.5)
      expect(mockUnlink).toHaveBeenCalledWith(`${MOCK_LOG}.5`);
      // Renames 4→5, 3→4, 2→3, 1→2
      expect(mockRename).toHaveBeenCalledWith(`${MOCK_LOG}.4`, `${MOCK_LOG}.5`);
      expect(mockRename).toHaveBeenCalledWith(`${MOCK_LOG}.3`, `${MOCK_LOG}.4`);
      expect(mockRename).toHaveBeenCalledWith(`${MOCK_LOG}.2`, `${MOCK_LOG}.3`);
      expect(mockRename).toHaveBeenCalledWith(`${MOCK_LOG}.1`, `${MOCK_LOG}.2`);
      // Renames current → .1
      expect(mockRename).toHaveBeenCalledWith(MOCK_LOG, `${MOCK_LOG}.1`);
    });

    it('does not rotate when file does not exist', async () => {
      mockStat.mockRejectedValue(new Error('ENOENT'));

      await logger.logDestructiveAction({
        abilityName: 'test',
        userDecision: 'approved',
        input: {},
      });

      expect(mockRename).not.toHaveBeenCalled();
    });

    it('handles missing intermediate rotation files gracefully (unchanged)', async () => {
      mockStat.mockResolvedValue({ size: 11 * 1024 * 1024 });
      mockUnlink.mockRejectedValue(new Error('ENOENT'));
      mockRename.mockRejectedValue(new Error('ENOENT'));

      // Should not throw despite all renames/unlinks failing
      await expect(
        logger.logDestructiveAction({
          abilityName: 'test',
          userDecision: 'approved',
          input: {},
        })
      ).resolves.not.toThrow();
    });
  });

  describe('logDestructiveActionSafe (F4)', () => {
    it('outputs CRITICAL message with path on failure and does not throw', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Force logDestructiveAction to throw
      mockMkdir.mockRejectedValueOnce(new Error('disk full'));

      await expect(
        logDestructiveActionSafe({
          abilityName: 'test-fail',
          userDecision: 'approved',
          input: {},
        })
      ).resolves.not.toThrow();

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringMatching(/CRITICAL:.*disk full.*audit\.log/)
      );

      errorSpy.mockRestore();
    });
  });
});
