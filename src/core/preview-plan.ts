import { sanitizeSingleLine } from '../utils/terminal-sanitizer.js';

const MAX_FIELD_LENGTH = 80;
const MAX_LINES = 50;
const MAX_CHECKS_SHOWN = 6;
const VERSION_CAVEAT =
  'Versions are the ones pending now. If a newer version syncs before you confirm, the newer one is applied.';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown): string {
  if (typeof value !== 'string') return '';
  const safe = sanitizeSingleLine(value).replace(/[\u2028\u2029]/g, ' ').trim();
  return safe.length > MAX_FIELD_LENGTH ? `${safe.slice(0, MAX_FIELD_LENGTH - 1)}…` : safe;
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

const SKIP_REASONS: Record<string, string> = {
  ignored_site: 'ignored on this site',
  ignored_global: 'ignored globally',
  ignored_site_flag: 'site ignores all updates of that type',
  backup_missing: 'no recent backup',
  backup_pending_offsite: 'latest backup not in offsite storage yet',
};

function itemChange(value: unknown): string | undefined {
  const item = record(value);
  if (!item) return undefined;
  const name = text(item['name']) || text(item['slug']);
  const from = item['from'] ?? item['old_version'];
  const to = item['to'] ?? item['new_version'];
  if (!name || typeof from !== 'string' || typeof to !== 'string') return undefined;
  const label = item['type'] === 'translation' ? `${name} translation` : name;
  return `${label}${text(from) ? ` ${text(from)}` : ''} → ${text(to)}`;
}

function entityLine(value: unknown): string | undefined {
  const entity = record(value);
  if (!entity) return undefined;
  const client = record(entity['client']);
  const label = text(client?.['name']) || text(entity['name']) || text(entity['url']) || text(entity['slug']);
  if (!label) return undefined;
  const counts: string[] = [];
  for (const [key, description] of [
    ['associated_sites_count', 'associated sites'],
    ['sites_count', 'sites'],
    ['clients_count', 'clients'],
  ] as const) {
    const value = entity[key];
    if (count(value)) counts.push(`${value} ${description}`);
  }
  return counts.length ? `${label} (${counts.join(', ')})` : label;
}

/** Summarize masked Dashboard would_affect data; legacy previews keep their existing summary. */
export function previewPlanSummary(data: Record<string, unknown>, affected: unknown[]): string | undefined {
  const wouldAffect = data['would_affect'];
  if (!Array.isArray(wouldAffect) && !record(wouldAffect)) return undefined;
  if (affected.length === 0) return undefined;

  const lines: string[] = [];
  let lineCount = 0;
  const append = (line: string) => {
    lineCount++;
    if (lines.length < MAX_LINES) lines.push(line);
  };
  let updatePlan = false;
  for (const value of affected) {
    const site = record(value);
    if (!site || !Array.isArray(site['items'])) {
      const line = entityLine(value);
      if (!line) return undefined;
      append(line);
      continue;
    }
    updatePlan = true;
    const label = text(site['site_name']) || text(site['name']) || text(site['site_url']);
    if (!label) return undefined;
    append(label);
    for (const item of site['items']) {
      const change = itemChange(item);
      if (!change) return undefined;
      append(`  ${change}`);
    }
    if (Array.isArray(site['skipped'])) {
      for (const value of site['skipped']) {
        const item = record(value);
        const change = itemChange(value);
        const reason = text(item?.['reason']);
        if (!change || !reason) return undefined;
        append(`  Held back: ${change} (${Object.hasOwn(SKIP_REASONS, reason) ? SKIP_REASONS[reason] : reason})`);
      }
    }
    const gate = record(site['backup_gate']);
    const verdict = text(gate?.['verdict']) || text(site['backup_verdict']);
    const backupLabel = text(site['backup_label']);
    if (verdict || backupLabel) {
      append(`  Backup: ${verdict}${backupLabel ? ` (${backupLabel})` : ''}${gate?.['overridden'] === true ? ' (overridden)' : ''}`);
    }
    if (Array.isArray(site['checks'])) {
      const checks = site['checks'];
      const shown: string[] = [];
      for (const value of checks.slice(0, MAX_CHECKS_SHOWN)) {
        const check = record(value);
        const key = text(check?.['key']);
        if (!key) return undefined;
        const reason = text(check?.['reason']);
        shown.push(`${key}: ${text(check?.['status'])}${reason ? ` (${reason})` : ''}`);
      }
      const hidden = checks.length - shown.length;
      append(`  Checks: ${shown.join(', ') || 'none'}${hidden > 0 ? ` and ${hidden} more` : ''}`);
    }
    const skipReason = text(site['skip_reason']);
    if (skipReason) append(`  Left out: ${skipReason}`);
  }
  const ending: string[] = [];
  const summary = record(record(wouldAffect)?.['summary']);
  if (summary?.['truncated'] === true) {
    const total = summary['site_count'];
    const shown = affected.filter(value => {
      const items = record(value)?.['items'];
      return Array.isArray(items) && items.length > 0;
    }).length;
    ending.push(count(total)
      ? `Partial site list: showing ${shown} of ${total} sites with updates (${Math.max(0, total - shown)} left out).`
      : 'Partial site list: the Dashboard omitted sites.');
  }
  if (updatePlan) ending.push(VERSION_CAVEAT);
  if (lineCount + ending.length <= MAX_LINES) return [...lines, ...ending].join('\n');
  const visibleLines = MAX_LINES - ending.length - 1;
  return [...lines.slice(0, visibleLines), ...ending, `+${lineCount - visibleLines} more lines left out`].join('\n');
}
