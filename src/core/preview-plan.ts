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

function entityLabel(entity: Record<string, unknown>): string {
  return text(entity['site_name']) || text(record(entity['client'])?.['name']) ||
    text(entity['name']) || text(entity['site_url']) || text(entity['url']) || text(entity['slug']);
}

function diagnostic(value: unknown): string {
  const entry = record(value);
  if (!entry) return text(value);
  const label = entityLabel(entry) || (count(entry['site_id']) ? `Site ${entry['site_id']}` : '');
  return [label, text(entry['code']), text(entry['message'])].filter(Boolean).join(': ');
}

function diagnostics(data: Record<string, unknown>): string[] {
  const lines: string[] = [];
  if (data['can_proceed'] === false) lines.push('Confirm would be refused.');
  for (const [key, label] of [['errors', 'Error'], ['refusals', 'Refusal'], ['warnings', 'Warning']] as const) {
    const entries = data[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      lines.push(`${label}: ${diagnostic(entry) || 'Unrecognized detail; review the full response.'}`);
    }
  }
  return lines;
}

function boundedSummary(lines: string[], ending: string[] = []): string {
  if (lines.length + ending.length <= MAX_LINES) return [...lines, ...ending].join('\n');
  const visibleLines = MAX_LINES - ending.length - 1;
  return [...lines.slice(0, visibleLines), ...ending, `+${lines.length - visibleLines} more lines left out`].join('\n');
}

export function unrecognizedPreviewSummary(data: Record<string, unknown>): string {
  return boundedSummary(diagnostics(data), [
    'Preview returned data in an unrecognized format — review the raw response below before approving.',
  ]);
}

export function previewSummaryWithDiagnostics(data: Record<string, unknown>, summary: string): string {
  return boundedSummary([...diagnostics(data), summary]);
}

function words(value: unknown): string {
  const safe = text(value);
  switch (safe) {
    case 'pending_offsite': return 'latest backup not offsite yet';
    case 'not_applicable': return 'not applicable';
    case 'not_run': return 'not run';
    default: return safe || 'unknown';
  }
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
  if (!name || typeof from !== 'string' || (to !== undefined && typeof to !== 'string')) return undefined;
  const label = item['type'] === 'translation' ? `${name} translation` : name;
  return `${label}${text(from) ? ` ${text(from)}` : ''} → ${text(to) || 'unknown version'}`;
}

function entityLine(value: unknown): string | undefined {
  const entity = record(value);
  if (!entity) return undefined;
  const label = entityLabel(entity);
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
  const lines = diagnostics(data);
  const append = (line: string) => lines.push(line);
  const plan = record(wouldAffect);
  if (plan && Object.hasOwn(plan, 'sites') && !Array.isArray(plan['sites'])) return undefined;
  const summary = record(plan?.['summary']);
  let updatePlan = Array.isArray(plan?.['sites']);
  let coreSites = 0;
  let rollupCoreSites: number | undefined;
  if (summary?.['truncated'] === true && Array.isArray(plan?.['by_item'])) {
    rollupCoreSites = 0;
    for (const value of plan['by_item']) {
      const item = record(value);
      const label = item && (text(item['name']) || text(item['slug']));
      if (!item || !label || !count(item['site_count']) || !Array.isArray(item['to'])) return undefined;
      const versions = item['to'].map(text).filter(Boolean);
      const shownVersions = versions.slice(0, MAX_CHECKS_SHOWN);
      const hidden = versions.length - shownVersions.length;
      const flags = record(item['flags']);
      append(`Across sites: ${label} → ${shownVersions.join(', ') || 'unknown version'}${hidden ? ` and ${hidden} more versions` : ''} on ${item['site_count']} sites${flags?.['major'] === true ? ' (major version change)' : ''}`);
      if (flags?.['core'] === true) rollupCoreSites += item['site_count'];
    }
  }
  if (affected.length === 0) append('No affected items reported.');
  for (const value of affected) {
    const site = record(value);
    if (site && Object.hasOwn(site, 'items') && !Array.isArray(site['items'])) return undefined;
    if (!site || !Array.isArray(site['items'])) {
      const line = entityLine(value);
      if (!line) return undefined;
      append(line);
      if (site && Object.hasOwn(site, 'holds')) {
        if (!Array.isArray(site['holds'])) return undefined;
        for (const value of site['holds']) {
          const hold = record(value);
          const label = hold && (text(hold['name']) || text(hold['slug']));
          if (!hold || !label || typeof hold['held'] !== 'boolean') return undefined;
          const remaining = text(hold['still_held_by']);
          append(`  Hold: ${label} (${hold['held'] ? 'held' : 'not held'}${remaining ? `; still held by ${remaining}` : ''})`);
        }
      }
      continue;
    }
    updatePlan = true;
    const label = entityLabel(site);
    if (!label) return undefined;
    const skipReason = text(site['skip_reason']);
    if (skipReason) {
      append(`Left out: ${label} (${skipReason})`);
      continue;
    }
    append(label);
    let hasCore = false;
    for (const item of site['items']) {
      const change = itemChange(item);
      if (!change) return undefined;
      const flags = record(record(item)?.['flags']);
      append(`  ${change}${flags?.['major'] === true ? ' (major version change)' : ''}`);
      if (flags?.['core'] === true) hasCore = true;
    }
    if (hasCore) coreSites++;
    if (site['skipped'] !== undefined && !Array.isArray(site['skipped'])) return undefined;
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
      append(`  Backup: ${words(verdict)}${backupLabel ? ` (${backupLabel})` : ''}${gate?.['overridden'] === true ? ' (overridden)' : ''}`);
    }
    if (site['checks'] !== undefined && !Array.isArray(site['checks'])) return undefined;
    if (Array.isArray(site['checks'])) {
      const checks = site['checks'];
      const shown: string[] = [];
      for (const [index, value] of checks.entries()) {
        const check = record(value);
        const key = text(check?.['key']);
        if (!key) return undefined;
        const reason = text(check?.['reason']);
        if (index < MAX_CHECKS_SHOWN) shown.push(`${key}: ${words(check?.['status'])}${reason ? ` (${reason})` : ''}`);
      }
      const hidden = checks.length - shown.length;
      append(`  Checks: ${shown.join(', ') || 'none'}${hidden > 0 ? ` and ${hidden} more` : ''}`);
    }
  }
  const ending: string[] = [];
  if (Array.isArray(summary?.['requested_not_found'])) {
    for (const item of summary['requested_not_found']) append(`Requested but not found: ${text(item) || 'unknown item'}`);
  }
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
  coreSites = rollupCoreSites ?? coreSites;
  if (coreSites > 0 || summary?.['has_core'] === true) {
    ending.push(coreSites > 0
      ? `Core update on ${coreSites} ${coreSites === 1 ? 'site' : 'sites'}`
      : 'Core update included; site count unknown.');
  }
  if (updatePlan) ending.push(VERSION_CAVEAT);
  return boundedSummary(lines, ending);
}
