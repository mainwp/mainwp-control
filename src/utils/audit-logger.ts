/**
 * Audit Logger for mainwpcontrol
 *
 * Logs all destructive actions with preview, user decision, and execution result.
 *
 * Log location: ~/.config/mainwpcontrol/audit.log
 * Format: Newline-delimited JSON (NDJSON)
 * Rotation: When file exceeds 10MB, rotates to audit.log.1, audit.log.2, etc.
 * Retention: Keeps last 5 rotated files
 *
 * Sensitive data (passwords, tokens, API keys) is automatically redacted.
 */

import { constants as fsConstants, promises as fs } from 'node:fs';
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

const MAX_SERIALIZED_INPUT_BYTES = 8 * 1024;

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
  /** Preview information (absent when the preview itself failed) */
  preview?: {
    summary: string;
    affectedCount: number;
  };
  /** User's decision */
  userDecision: 'approved' | 'declined';
  /**
   * Execution result when approved. On a declined entry this instead records
   * why the flow was aborted before the user could approve (e.g.
   * "Preview failed: ..." from the fail-closed preview gate).
   */
  execution?: {
    success: boolean;
    error?: string;
  };
  /** Input parameters (redacted of sensitive data) */
  input: Record<string, unknown>;
  /** Present when input was bounded before writing the entry. */
  inputTruncated?: {
    marker: 'TRUNCATED';
    originalBytes: number;
    limitBytes: number;
  };
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
   * SECURITY: Uses restricted permissions for audit logs.
   *
   * @param params - Action details to log
   */
  async logDestructiveAction(params: LogDestructiveActionInput): Promise<void> {
    const logPath = getAuditLogPath();

    // Create directory with restricted permissions (owner only)
    const dir = getConfigDir();
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700).catch(() => {});

    // Check if rotation is needed
    if (await this.shouldRotate(logPath)) {
      await this.rotateLogFile(logPath);
    }

    // Redact sensitive data from input
    const redactedInput = this.inputSanitizer.redactSensitive(params.input);
    const boundedInput = this.boundInput(redactedInput);

    // Build audit entry
    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      abilityName: params.abilityName,
      userDecision: params.userDecision,
      input: boundedInput.input,
    };
    if (boundedInput.truncated) {
      entry.inputTruncated = boundedInput.truncated;
    }

    // Add optional fields
    if (params.preview) {
      entry.preview = params.preview;
    }
    if (params.execution) {
      entry.execution = params.execution;
    }

    // Format as NDJSON line
    const line = JSON.stringify(entry) + '\n';

    // Open atomically in append mode and self-heal existing file permissions.
    const noFollow = process.platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
    const appendFlags = fsConstants.O_APPEND | fsConstants.O_CREAT |
      fsConstants.O_WRONLY | noFollow;
    const handle = await fs.open(logPath, appendFlags, 0o600);
    try {
      await handle.chmod(0o600).catch(() => {});
      await handle.writeFile(line, 'utf-8');
    } finally {
      await handle.close();
    }
  }

  private boundInput(input: Record<string, unknown>): {
    input: Record<string, unknown>;
    truncated?: AuditEntry['inputTruncated'];
  } {
    const serialized = JSON.stringify(input);
    const originalBytes = Buffer.byteLength(serialized, 'utf8');
    if (originalBytes <= MAX_SERIALIZED_INPUT_BYTES) {
      return { input };
    }

    const serializedBytes = Buffer.from(serialized, 'utf8');
    let prefixBytes = MAX_SERIALIZED_INPUT_BYTES;
    let bounded: Record<string, unknown>;
    do {
      bounded = {
        serializedPrefix: serializedBytes.subarray(0, prefixBytes).toString('utf8'),
      };
      if (Buffer.byteLength(JSON.stringify(bounded), 'utf8') <= MAX_SERIALIZED_INPUT_BYTES) {
        break;
      }
      prefixBytes = Math.floor(prefixBytes * 0.75);
    } while (prefixBytes > 0);

    return {
      input: bounded!,
      truncated: {
        marker: 'TRUNCATED',
        originalBytes,
        limitBytes: MAX_SERIALIZED_INPUT_BYTES,
      },
    };
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
 * Fire-and-forget wrapper for logDestructiveAction.
 * Swallows errors to prevent audit logging failures from
 * interrupting the primary execution flow.
 */
export async function logDestructiveActionSafe(
  params: LogDestructiveActionInput
): Promise<void> {
  try {
    await getAuditLogger().logDestructiveAction(params);
  } catch (error) {
    console.error(
      `CRITICAL: [AuditLogger] Failed to log destructive action: ${error instanceof Error ? error.message : String(error)}. ` +
      `Audit log path: ${getAuditLogPath()}`
    );
  }
}
