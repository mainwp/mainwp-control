/**
 * Audit Logger for mainwpctl
 *
 * Logs all destructive actions with preview, user decision, and execution result.
 *
 * Log location: ~/.config/mainwpctl/audit.log
 * Format: Newline-delimited JSON (NDJSON)
 * Rotation: When file exceeds 10MB, rotates to audit.log.1, audit.log.2, etc.
 * Retention: Keeps last 5 rotated files
 *
 * Sensitive data (passwords, tokens, API keys) is automatically redacted.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { getConfigDir } from '../config/settings.js';
import { getInputSanitizer } from '../validation/input-sanitizer.js';

/**
 * Maximum log file size before rotation (10MB)
 */
const MAX_LOG_SIZE = 10 * 1024 * 1024;

/**
 * Maximum number of rotated log files to keep
 */
const MAX_ROTATIONS = 5;

/**
 * Audit log filename
 */
const AUDIT_LOG_FILENAME = 'audit.log';

/**
 * Audit entry structure
 */
export interface AuditEntry {
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Name of the ability executed */
  abilityName: string;
  /** Preview information (optional - not available in CLI executeDestructive path) */
  preview?: {
    summary: string;
    affectedCount: number;
  };
  /** User's decision */
  userDecision: 'approved' | 'declined';
  /** Execution result (only present when approved) */
  execution?: {
    success: boolean;
    error?: string;
  };
  /** Input parameters (redacted of sensitive data) */
  input: Record<string, unknown>;
}

/**
 * Input for logging a destructive action
 */
export interface LogDestructiveActionInput {
  abilityName: string;
  preview?: {
    summary: string;
    affectedCount: number;
  };
  userDecision: 'approved' | 'declined';
  execution?: {
    success: boolean;
    error?: string;
  };
  input: Record<string, unknown>;
}

/**
 * Get the audit log file path
 */
export function getAuditLogPath(): string {
  return join(getConfigDir(), AUDIT_LOG_FILENAME);
}

/**
 * Audit Logger class
 */
export class AuditLogger {
  private readonly inputSanitizer = getInputSanitizer();

  /**
   * Log a destructive action
   *
   * @param params - Action details to log
   */
  async logDestructiveAction(params: LogDestructiveActionInput): Promise<void> {
    const logPath = getAuditLogPath();

    // Ensure directory exists
    const dir = getConfigDir();
    await fs.mkdir(dir, { recursive: true });

    // Check if rotation is needed
    if (await this.shouldRotate(logPath)) {
      await this.rotateLogFile(logPath);
    }

    // Redact sensitive data from input
    const redactedInput = this.inputSanitizer.redactSensitive(params.input);

    // Build audit entry
    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      abilityName: params.abilityName,
      userDecision: params.userDecision,
      input: redactedInput,
    };

    // Add optional fields
    if (params.preview) {
      entry.preview = params.preview;
    }
    if (params.execution) {
      entry.execution = params.execution;
    }

    // Format as NDJSON line
    const line = JSON.stringify(entry) + '\n';

    // Append to log file
    await fs.appendFile(logPath, line, 'utf-8');
  }

  /**
   * Check if the log file should be rotated
   */
  private async shouldRotate(logPath: string): Promise<boolean> {
    try {
      const stats = await fs.stat(logPath);
      return stats.size > MAX_LOG_SIZE;
    } catch {
      // File doesn't exist yet
      return false;
    }
  }

  /**
   * Rotate log files
   *
   * Rotation sequence: audit.log → audit.log.1 → audit.log.2 → ... → audit.log.5
   * Oldest rotation (audit.log.5) is deleted
   */
  private async rotateLogFile(logPath: string): Promise<void> {
    // Delete oldest rotation
    const oldestPath = `${logPath}.${MAX_ROTATIONS}`;
    try {
      await fs.unlink(oldestPath);
    } catch {
      // Ignore if doesn't exist
    }

    // Rotate existing files (5 → delete, 4 → 5, 3 → 4, 2 → 3, 1 → 2)
    for (let i = MAX_ROTATIONS - 1; i >= 1; i--) {
      const from = `${logPath}.${i}`;
      const to = `${logPath}.${i + 1}`;
      try {
        await fs.rename(from, to);
      } catch {
        // Ignore if doesn't exist
      }
    }

    // Rotate current log (audit.log → audit.log.1)
    try {
      await fs.rename(logPath, `${logPath}.1`);
    } catch {
      // Ignore if doesn't exist
    }
  }
}

/**
 * Singleton instance
 */
let instance: AuditLogger | null = null;

/**
 * Get the audit logger singleton
 */
export function getAuditLogger(): AuditLogger {
  if (!instance) {
    instance = new AuditLogger();
  }
  return instance;
}

/**
 * Create a new audit logger (for testing)
 */
export function createAuditLogger(): AuditLogger {
  return new AuditLogger();
}
