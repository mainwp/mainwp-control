/**
 * Golden Tests for SafetyController
 *
 * These tests verify the non-negotiable safety invariants from PLAN.md §2.1:
 * - dry_run and confirm are mutually exclusive
 * - Destructive abilities require preview first
 *
 * CRITICAL: These tests are normative. Any failure indicates a violation
 * of the safety contract.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  SafetyController,
  isKnownDestructiveName,
  type PreviewResult,
} from './safety-controller.js';
import { MutualExclusionError, ConfirmationRequiredError } from '../utils/errors.js';
import type { Ability } from './abilities-executor.js';
import { formatPreview } from '../output/formatter.js';
import { formatResponse } from '../commands/chat.js';
import AbilitiesRun from '../commands/abilities/run.js';
import { sanitizeForTerminal } from '../utils/terminal-sanitizer.js';

function humanPreview(preview: PreviewResult): string {
  return (AbilitiesRun.prototype as unknown as {
    formatPreviewOutput(preview: PreviewResult): string;
  }).formatPreviewOutput(preview);
}

/**
 * Create a test ability with specified annotations
 */
function createTestAbility(
  name: string,
  annotations: { readonly?: boolean; destructive?: boolean; idempotent?: boolean }
): Ability {
  return {
    name,
    label: name,
    description: `Test ability: ${name}`,
    category: 'test',
    meta: {
      annotations: {
        readonly: annotations.readonly ?? false,
        destructive: annotations.destructive ?? false,
        idempotent: annotations.idempotent ?? false,
      },
    },
  };
}

const NESTED_WRITE_ONLY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    credentials: {
      type: 'object',
      properties: {
        label: { type: 'string' },
        secret: { type: 'string', writeOnly: true },
      },
    },
    targets: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          token: { type: 'string', writeOnly: true },
        },
      },
    },
  },
};

function updatePreview() {
  const item = {
    type: 'plugin', slug: 'example/example.php', name: 'Example Plugin',
    from: '1.0', to: '1.1', requested: false, flags: { core: false, major: false },
  };
  return {
    dry_run: true,
    would_affect: {
      sites: [
        {
          site_id: 1, site_url: 'https://alpha.example',
          site_name: '\x1b[31mAlpha\x1b[0m\r\nStore\t\u202e',
          items: [item],
          skipped: [{ ...item, name: 'Held Plugin', reason: 'ignored_site' }],
          backup_gate: { applies: true, verdict: 'pass', overridden: false },
        },
        {
          site_id: 2, site_url: 'https://beta.example', site_name: '', items: [],
          skipped: [{ ...item, name: 'Another Plugin', reason: 'backup_pending_offsite' }],
          backup_gate: { applies: true, verdict: 'pending_offsite', overridden: false },
        },
      ],
      by_item: [{ type: 'plugin', slug: item.slug, name: item.name, to: ['1.1'], site_count: 1, flags: item.flags }],
      summary: {
        site_count: 1, item_count: 1, skipped_count: 2, all_sites: false, queued: false,
        truncated: false, has_core: false, has_major: false, has_unknown_version: false,
        backup_gate_blocked_sites: 1, backup_gate_overridden_sites: 0, requested_not_found: [],
      },
    },
    count: 1, warnings: [], errors: [],
  };
}

describe('Dashboard would_affect previews', () => {
  const controller = new SafetyController();
  const preview = (data: unknown, name = 'mainwp/run-updates-v1', outputSchema?: Record<string, unknown>) => {
    const ability = createTestAbility(name, { destructive: true });
    if (outputSchema) ability.output_schema = outputSchema;
    return controller.formatPreviewResult(ability, {}, { success: true, data });
  };

  it('summarizes two update sites, version changes, held items and backup gates safely', () => {
    const data = updatePreview();
    const result = preview(data);
    expect(result.affected).toEqual(data.would_affect.sites);
    expect(result.summary).toBe([
      'Alpha Store',
      '  Example Plugin 1.0 → 1.1',
      '  Held back: Held Plugin 1.0 → 1.1 (ignored on this site)',
      '  Backup: pass',
      'https://beta.example',
      '  Held back: Another Plugin 1.0 → 1.1 (latest backup not in offsite storage yet)',
      '  Backup: latest backup not offsite yet',
      'Versions are the ones pending now. If a newer version syncs before you confirm, the newer one is applied.',
    ].join('\n'));
    expect(result.summary).not.toMatch(/[\x1b\r\t\u202e]/);
    expect(formatPreview(result.summary.split('\n'), result.affected)).toContain('Alpha Store\n  Example Plugin');
    const chat = formatResponse({ type: 'preview', preview: result, requiresApproval: true });
    expect(chat).toContain(result.summary);
    expect(chat).not.toContain('\\u001b');
    expect(result.requiresApproval).toBe(true);
  });

  it('summarizes Safe Updates versions, backup verdicts, checks and site skip reasons', () => {
    const result = preview({ dry_run: true, would_affect: { sites: [{
      id: 3, name: 'Safe Store',
      items: [{ type: 'theme', slug: 'example', name: '', old_version: '2.0', new_version: '2.1' }],
      backup_verdict: 'missing', backup_label: 'Back up before updating', override_available: true,
      checks: Array.from({ length: 8 }, (_, i) => ({ key: `check-${i}`, name: 'Check', status: 'not_run', reason: 'site suspended' })),
      skip_reason: 'site suspended',
    }] } }, 'mainwp/run-safe-update-v1');
    expect(result.affected).toHaveLength(1);
    expect(result.summary).toContain('Left out: Safe Store (site suspended)');
    expect(result.summary).not.toMatch(/2\.0|Backup:|Checks:/);
  });

  it('summarizes a delete-site entity on one line', () => {
    const site = { id: 7, url: 'https://site.example', name: 'My Store' };
    const result = preview({ dry_run: true, would_affect: site, warnings: [] }, 'mainwp/delete-site-v1');
    expect(result.affected).toEqual([site]);
    expect(result.summary).toBe('My Store');
  });

  it('summarizes a delete-client entity with its associated site count', () => {
    const result = preview({ dry_run: true, would_affect: {
      client: { id: 8, name: 'Example Client', email: '', phone: '', suspended: 0, created: null },
      associated_sites_count: 4,
    }, count: 1, warnings: [] }, 'mainwp/delete-client-v1');
    expect(result.summary).toBe('Example Client (4 associated sites)');
    expect(result.affected).toHaveLength(1);
  });

  it('summarizes a delete-tag entity with site and client counts', () => {
    const result = preview({ dry_run: true, would_affect: {
      id: 9, name: 'Stores', sites_count: 3, clients_count: 2,
    }, warnings: [] }, 'mainwp/delete-tag-v1');
    expect(result.summary).toBe('Stores (3 sites, 2 clients)');
  });

  it('extracts array previews including activation entries and empty lists', () => {
    const items = [{ slug: 'example/example.php', name: 'Example Plugin', active: false, will_change: true }];
    const result = preview({ dry_run: true, would_affect: items, count: 1, warnings: [] }, 'mainwp/activate-site-plugins-v1');
    expect(result.affected).toEqual(items);
    expect(result.summary).toBe('Example Plugin');
    expect(preview({ would_affect: [] }).summary).toBe('No affected items reported.');
  });

  it('bounds plan fields and lines and reports client and server omissions', () => {
    const data = updatePreview();
    const site = data.would_affect.sites[0]!;
    site.site_name = 'x'.repeat(100);
    site.items = Array.from({ length: 60 }, () => site.items[0]!);
    data.would_affect.summary.truncated = true;
    data.would_affect.summary.site_count = 5;
    const result = preview(data);
    expect(result.summary.split('\n')).toHaveLength(50);
    expect(result.summary.split('\n')[1]).toBe(`${'x'.repeat(79)}…`);
    expect(result.summary).toContain('showing 1 of 5 sites with updates (4 left out)');
    expect(result.summary).toContain('Versions are the ones pending now.');
    expect(result.summary).toMatch(/\+20 more lines left out$/);
  });

  it('masks writeOnly fields before extracting and summarizing would_affect', () => {
    const data = updatePreview();
    const result = preview(data, 'mainwp/run-updates-v1', { properties: {
      would_affect: { properties: { sites: { items: { properties: {
        site_name: { writeOnly: true },
        items: { items: { properties: { name: { writeOnly: true } } } },
      } } } } },
    } });
    expect(result.summary).toContain('[REDACTED]');
    expect(result.summary).not.toContain('Example Plugin');
    expect(JSON.stringify(result.affected)).not.toContain('Example Plugin');
    expect(data.would_affect.sites[0]!.items[0]!.name).toBe('Example Plugin');
  });

  it('distinguishes recognized would_affect from unknown response shapes', () => {
    expect(preview({ would_affect: { id: 1, name: 'Known' } }).summary).toBe('Known');
    const data = { unexpected: { sites: [{ name: 'Unknown' }] } };
    const result = preview(data);
    expect(result.summary).toContain('unrecognized format');
    expect(result.summary).not.toContain('No items');
    expect(result.affected).toEqual([data]);
    expect(result.requiresApproval).toBe(true);
  });

  it('adds errors, warnings and missing requests while dumping the full masked update response', () => {
    const base = updatePreview();
    const data = { ...base,
      would_affect: { ...base.would_affect, summary: {
        ...base.would_affect.summary, requested_not_found: ['missing-plugin'],
      } },
      errors: [{ site_id: 3, site_url: 'https://offline.example', site_name: 'Offline Store',
        type: 'site', slug: '', code: 'mainwp_site_offline', message: '\x1b[31mSite is offline.\x1b[0m' }],
      warnings: ['The plan includes WordPress core updates.', {
        message: 'Review backup settings.', code: 'backup_warning', site_name: 'Beta Store',
      }],
      private_note: 'must-not-print',
    };
    const result = preview(data, 'mainwp/run-updates-v1', { properties: { private_note: { writeOnly: true } } });
    expect(result.summary).toContain('Error: Offline Store: mainwp_site_offline: Site is offline.');
    expect(result.summary.indexOf('Error:')).toBeLessThan(result.summary.indexOf('Alpha Store'));
    expect(result.summary).toContain('Warning: The plan includes WordPress core updates.');
    expect(result.summary).toContain('Warning: Beta Store: backup_warning: Review backup settings.');
    expect(result.summary).toContain('Requested but not found: missing-plugin');
    const dump = humanPreview(result);
    expect(dump).toContain(JSON.stringify(sanitizeForTerminal({ ...data, private_note: '[REDACTED]' }), null, 2));
    expect(dump).not.toContain('must-not-print');
    expect(dump).not.toContain('\\u001b');
    const chat = formatResponse({ type: 'preview', preview: result, requiresApproval: true });
    expect(chat).toContain(JSON.stringify(sanitizeForTerminal({ ...data, private_note: '[REDACTED]' }), null, 2));
    expect(chat).not.toContain('must-not-print');
    expect(Object.keys(result).sort()).toEqual(['abilityName', 'affected', 'input', 'requiresApproval', 'summary']);
    expect(JSON.parse(JSON.stringify(result))).not.toHaveProperty('rawResponse');
  });

  it('puts backup refusal evidence before the unrecognized entity fallback', () => {
    const data = { dry_run: true, would_affect: {
      site_id: 7, snapshot: { id: 12 }, restorable: false,
      restore_reason: { code: 'mainwp_backup_snapshot_unrestorable_missing', message: 'Snapshot is unavailable.' },
      restore_type: 'full', replaces_database: true, chain_ids: [12], site_has_woocommerce: false,
      safety_backup: { will_take: true, type: 'full' },
      preserve_orders: { requested: false, checked_at: 'confirm' },
    }, can_proceed: false,
    warnings: ['This restore replaces the database. Content changed since the snapshot will be lost.'],
    refusals: [{ code: 'mainwp_backup_site_disconnected', message: 'The site is disconnected.' }] };
    const result = preview(data, 'mainwp/restore-site-snapshot-v1');
    expect(result.summary).toMatch(/^Confirm would be refused\./);
    expect(result.summary).toContain('Refusal: mainwp_backup_site_disconnected: The site is disconnected.');
    expect(result.summary).toContain('unrecognized format');
    expect(humanPreview(result)).toContain(JSON.stringify(data, null, 2));
  });

  it('keeps top-level diagnostics on legacy affected previews too', () => {
    const result = preview({ affected: [], warnings: ['Review selection.'], errors: ['Site is offline.'] });
    expect(result.summary).toBe('Error: Site is offline.\nWarning: Review selection.\nNo items would be updated.');
  });

  it('includes delete-site warnings without describing an unknown action', () => {
    const warning = 'This action is irreversible. The site record will be permanently deleted from the MainWP Dashboard.';
    const result = preview({ dry_run: true,
      would_affect: { id: 7, url: 'https://site.example', name: 'My Store' }, warnings: [warning],
    }, 'mainwp/delete-site-v1');
    expect(result.summary).toContain(`Warning: ${warning.slice(0, 79)}…`);
    expect(result.summary).toContain('\nMy Store');
    expect(humanPreview(result)).toContain(warning);
  });

  it('lists unignore-site-updates holds and remaining blockers by site label', () => {
    const result = preview({ dry_run: true, would_affect: {
      site_id: 7, site_url: 'https://store.example', site_name: 'Store',
      holds: [
        { type: 'plugin', slug: 'example/example.php', name: 'Example Plugin', held: true,
          still_held_by: 'global', pending: { from: '1.0', to: '1.1' } },
        { type: 'theme', slug: 'example', name: 'Example Theme', held: false, still_held_by: null, pending: null },
      ],
    }, count: 1, warnings: [], errors: [] }, 'mainwp/unignore-site-updates-v1');
    expect(result.summary).toBe('Store\n  Hold: Example Plugin (held; still held by global)\n  Hold: Example Theme (not held)');
    expect(result.summary).not.toContain('would be updated');
  });

  it.each([
    { sites: [{ site_name: 'Store', items: [{ name: 'Plugin', from: 2, to: '3' }] }] },
    { sites: [{ site_name: 'Store', items: [], skipped: [{ name: 'Plugin', from: '2', to: '3' }] }] },
    { sites: [{ name: 'Store', items: [], checks: [{ status: 'pending', reason: '' }] }] },
    { id: 7 },
  ])('uses the raw-response fallback for malformed would_affect %j', (would_affect) => {
    const result = preview({ dry_run: true, would_affect });
    expect(result.summary).toBe('Preview returned data in an unrecognized format — review the raw response below before approving.');
    expect(result.summary).not.toMatch(/items? would be/);
  });

  it('shows truncated by-item rollups and core counts before a capped site plan', () => {
    const base = updatePreview();
    const result = preview({ ...base, would_affect: {
      ...base.would_affect,
      sites: [{ ...base.would_affect.sites[0], items: Array.from({ length: 60 }, () => base.would_affect.sites[0]!.items[0]!) }],
      by_item: [
        { type: 'core', slug: 'wordpress', name: 'WordPress core', to: ['6.9'], site_count: 5, flags: { core: true, major: true } },
        { type: 'plugin', slug: 'other', name: 'Omitted Plugin', to: ['3.0'], site_count: 4, flags: { core: false, major: false } },
      ], summary: { ...base.would_affect.summary, truncated: true, has_core: true, site_count: 5 },
    } });
    expect(result.summary).toContain('Across sites: WordPress core → 6.9 on 5 sites (major version change)');
    expect(result.summary).toContain('Across sites: Omitted Plugin → 3.0 on 4 sites');
    expect(result.summary).toContain('Core update on 5 sites');
    expect(result.summary.split('\n')).toHaveLength(50);
    expect(result.summary).toContain('more lines left out');
  });

  it('marks a major-version item and names core sites', () => {
    const result = preview({ dry_run: true, would_affect: { sites: [{
      site_id: 1, site_name: 'Core Store', site_url: 'https://core.example', skipped: [],
      items: [{ type: 'core', name: 'WordPress', slug: 'wordpress', from: '6.8', to: '6.9', requested: false,
        flags: { major: true, core: true } }],
    }] } });
    expect(result.summary).toContain('WordPress 6.8 → 6.9 (major version change)');
    expect(result.summary).toContain('Core update on 1 site');
  });

  it('shows running Safe Updates checks in words and unknown target versions', () => {
    const result = preview({ dry_run: true, would_affect: { sites: [{
      id: 3, name: 'Safe Store', skip_reason: '',
      items: [{ type: 'theme', slug: 'example', name: '', old_version: '2.0', new_version: '' },
        { type: 'plugin', slug: 'missing', name: '', old_version: '1' }],
      backup_verdict: 'not_applicable', backup_label: '', override_available: false,
      checks: Array.from({ length: 8 }, (_, i) => ({ key: `check-${i}`, name: 'Check', status: i ? 'not_run' : '', reason: '' })),
    }] } }, 'mainwp/run-safe-update-v1');
    expect(result.summary).toContain('example 2.0 → unknown version');
    expect(result.summary).toContain('missing 1 → unknown version');
    expect(result.summary).toContain('Backup: not applicable');
    expect(result.summary).toContain('check-0: unknown, check-1: not run');
    expect(result.summary).toContain('and 2 more');
  });

  it('dumps the complete chat response with more than ten sites and sibling diagnostics', () => {
    const data = { dry_run: true, would_affect: { sites: Array.from({ length: 12 }, (_, i) => ({
      site_id: i + 1, site_name: `Store ${i + 1}`, site_url: `https://store${i + 1}.example`, items: [], skipped: [],
    })) }, warnings: ['Review all sites.'], errors: [], receipt: 'end-of-response' };
    const result = preview(data);
    const chat = formatResponse({ type: 'preview', preview: result, requiresApproval: true });
    expect(chat).toContain(JSON.stringify(data, null, 2));
    expect(chat).toContain('"site_id": 12');
    expect(chat).toContain('"receipt": "end-of-response"');
    expect(chat).not.toContain('... and 2 more');
  });
});

describe('Golden Test: Mutual Exclusion (dry_run XOR confirm)', () => {
  let controller: SafetyController;

  beforeEach(() => {
    controller = new SafetyController();
  });

  /**
   * GOLDEN TEST #1: Mutual exclusion is enforced
   *
   * From PLAN.md §2.1:
   * > dry_run and confirm are mutually exclusive
   *
   * This MUST throw MutualExclusionError when both are true.
   */
  it('throws MutualExclusionError when both dry_run and confirm are true', () => {
    const ability = createTestAbility('delete-site-v1', { destructive: true });

    expect(() => {
      controller.validateExecutionFlags(ability, true, true);
    }).toThrow(MutualExclusionError);
  });

  it('throws MutualExclusionError for any ability when both flags are true', () => {
    // Even for read-only abilities, mutual exclusion must be enforced
    const readonlyAbility = createTestAbility('list-sites-v1', { readonly: true });
    const normalAbility = createTestAbility('update-site-v1', { destructive: false });

    expect(() => {
      controller.validateExecutionFlags(readonlyAbility, true, true);
    }).toThrow(MutualExclusionError);

    expect(() => {
      controller.validateExecutionFlags(normalAbility, true, true);
    }).toThrow(MutualExclusionError);
  });

  it('allows dry_run=true alone', () => {
    const ability = createTestAbility('delete-site-v1', { destructive: true });

    expect(() => {
      controller.validateExecutionFlags(ability, true, false);
    }).not.toThrow();
  });

  it('allows confirm=true alone', () => {
    const ability = createTestAbility('delete-site-v1', { destructive: true });

    expect(() => {
      controller.validateExecutionFlags(ability, false, true);
    }).not.toThrow();
  });

  it('allows neither flag for non-destructive abilities', () => {
    const ability = createTestAbility('list-sites-v1', { readonly: true });

    expect(() => {
      controller.validateExecutionFlags(ability, false, false);
    }).not.toThrow();
  });
});

describe('Golden Test: Destructive Preview Requirement', () => {
  let controller: SafetyController;

  beforeEach(() => {
    controller = new SafetyController();
  });

  /**
   * GOLDEN TEST #2: Destructive abilities require explicit flag
   *
   * From PLAN.md §2.1:
   * > If neither is provided, API returns mainwp_confirmation_required
   *
   * From CHAT_PROMPT.md:
   * > Never skip preview. Never inject confirm.
   */
  it('throws ConfirmationRequiredError for destructive ability without flags', () => {
    const ability = createTestAbility('delete-site-v1', { destructive: true });

    expect(() => {
      controller.validateExecutionFlags(ability, undefined, undefined);
    }).toThrow(ConfirmationRequiredError);

    try {
      controller.validateExecutionFlags(ability, undefined, undefined);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfirmationRequiredError);
      const confirmError = error as ConfirmationRequiredError;
      expect(confirmError.code).toBe('CONFIRMATION_REQUIRED');
    }
  });

  it('throws ConfirmationRequiredError when both flags are false for destructive ability', () => {
    const ability = createTestAbility('delete-site-v1', { destructive: true });

    expect(() => {
      controller.validateExecutionFlags(ability, false, false);
    }).toThrow(ConfirmationRequiredError);
  });

  it('allows dry_run=true for destructive abilities (preview mode)', () => {
    const ability = createTestAbility('delete-site-v1', { destructive: true });

    expect(() => {
      controller.validateExecutionFlags(ability, true, undefined);
    }).not.toThrow();
  });

  it('allows confirm=true for destructive abilities (execution mode)', () => {
    const ability = createTestAbility('delete-site-v1', { destructive: true });

    expect(() => {
      controller.validateExecutionFlags(ability, undefined, true);
    }).not.toThrow();
  });
});

describe('Golden Test: Safety Classification', () => {
  let controller: SafetyController;

  beforeEach(() => {
    controller = new SafetyController();
  });

  /**
   * GOLDEN TEST #3: Classification derives ONLY from annotations
   *
   * From PLAN.md §7:
   * > Safety classification derives ONLY from ability annotations.
   * > No heuristics are permitted.
   */
  it('classifies destructive abilities correctly', () => {
    const ability = createTestAbility('delete-site-v1', { destructive: true });
    const classification = controller.classify(ability);

    expect(classification.isDestructive).toBe(true);
    expect(classification.requiresSafetyFlow).toBe(true);
  });

  it('classifies readonly abilities correctly', () => {
    const ability = createTestAbility('list-sites-v1', { readonly: true });
    const classification = controller.classify(ability);

    expect(classification.isReadOnly).toBe(true);
    expect(classification.requiresSafetyFlow).toBe(false);
  });

  it('contradictory readonly+destructive requires safety flow (treated as destructive)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const ability = createTestAbility('special-v1', {
      readonly: true,
      destructive: true,
    });
    const classification = controller.classify(ability);

    // Contradictory annotations → warn and treat as destructive
    expect(classification.requiresSafetyFlow).toBe(true);
    expect(classification.isReadOnly).toBe(false);
    expect(classification.isDestructive).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('contradictory'));

    errorSpy.mockRestore();
  });

  it('idempotent+destructive still requires safety flow', () => {
    const ability = createTestAbility('delete-cache-v1', {
      destructive: true,
      idempotent: true,
    });
    const classification = controller.classify(ability);

    expect(classification.isDestructive).toBe(true);
    expect(classification.isIdempotent).toBe(true);
    expect(classification.requiresSafetyFlow).toBe(true);
  });

  it('handles abilities without annotations as destructive', () => {
    const ability: Ability = {
      name: 'legacy-ability-v1',
      label: 'Legacy Ability',
      description: 'An ability without annotations',
      category: 'legacy',
      // No meta.annotations
    };
    const classification = controller.classify(ability);

    expect(classification.isDestructive).toBe(true);
    expect(classification.isReadOnly).toBe(false);
    expect(classification.requiresSafetyFlow).toBe(true);
  });
});

describe('Golden Test: Execution Intent', () => {
  let controller: SafetyController;

  beforeEach(() => {
    controller = new SafetyController();
  });

  it('determines preview intent from dry_run flag', () => {
    const intent = controller.determineIntent(true, undefined);
    expect(intent.mode).toBe('preview');
  });

  it('determines execute intent from confirm flag', () => {
    const intent = controller.determineIntent(undefined, true);
    expect(intent.mode).toBe('execute');
  });

  it('determines auto intent when no flags provided', () => {
    const intent = controller.determineIntent(undefined, undefined);
    expect(intent.mode).toBe('auto');
  });

  it('dry_run takes precedence when both are false', () => {
    const intent = controller.determineIntent(false, false);
    expect(intent.mode).toBe('auto');
  });
});

describe('Golden Test: Direct Execution Decision', () => {
  let controller: SafetyController;

  beforeEach(() => {
    controller = new SafetyController();
  });

  it('executes readonly abilities directly', () => {
    const ability = createTestAbility('list-sites-v1', { readonly: true });
    expect(controller.shouldExecuteDirectly(ability, false, false)).toBe(true);
  });

  it('executes with confirm=true directly', () => {
    const ability = createTestAbility('delete-site-v1', { destructive: true });
    expect(controller.shouldExecuteDirectly(ability, false, true)).toBe(true);
  });

  it('does NOT execute destructive with dry_run=true directly', () => {
    const ability = createTestAbility('delete-site-v1', { destructive: true });
    expect(controller.shouldExecuteDirectly(ability, true, false)).toBe(false);
  });

  it('does NOT execute destructive without flags directly', () => {
    const ability = createTestAbility('delete-site-v1', { destructive: true });
    expect(controller.shouldExecuteDirectly(ability, false, false)).toBe(false);
  });
});

describe('Annotation Validation (F2)', () => {
  let controller: SafetyController;

  beforeEach(() => {
    controller = new SafetyController();
  });

  it('treats non-boolean annotation values as destructive', () => {
    const ability: Ability = {
      name: 'bad-annotations-v1',
      label: 'Bad',
      description: 'Ability with non-boolean annotations',
      category: 'test',
      meta: {
        annotations: {
          destructive: 'yes' as unknown as boolean,
          readonly: 1 as unknown as boolean,
          idempotent: null as unknown as boolean,
        },
      },
    };

    const classification = controller.classify(ability);

    expect(classification.isDestructive).toBe(true);
    expect(classification.isReadOnly).toBe(false);
    expect(classification.isIdempotent).toBe(false);
    expect(classification.requiresSafetyFlow).toBe(true);
  });

  it('warns on contradictory annotations and requires safety flow', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const ability = createTestAbility('contradictory-v1', {
      destructive: true,
      readonly: true,
    });

    const classification = controller.classify(ability);

    expect(classification.requiresSafetyFlow).toBe(true);
    expect(classification.isDestructive).toBe(true);
    expect(classification.isReadOnly).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('contradictory')
    );

    errorSpy.mockRestore();
  });

  it('missing/undefined annotation fields require the safety flow', () => {
    const ability: Ability = {
      name: 'no-annotations-v1',
      label: 'None',
      description: 'No annotations',
      category: 'test',
      // No meta at all
    };

    const classification = controller.classify(ability);

    expect(classification.isDestructive).toBe(true);
    expect(classification.isReadOnly).toBe(false);
    expect(classification.isIdempotent).toBe(false);
    expect(classification.requiresSafetyFlow).toBe(true);
  });
});

describe('M6: Known-destructive pattern defense-in-depth', () => {
  let controller: SafetyController;

  beforeEach(() => {
    controller = new SafetyController();
  });

  it('forces destructive classification for delete-* even when API says readonly', () => {
    const ability = createTestAbility('mainwp/delete-site-v1', {
      destructive: false,
      readonly: true,
    });

    const classification = controller.classify(ability);
    expect(classification.isDestructive).toBe(true);
    expect(classification.requiresSafetyFlow).toBe(true);
  });

  it('forces destructive classification for disconnect-* patterns', () => {
    const ability = createTestAbility('disconnect-site-v1', {
      destructive: false,
      readonly: true,
    });

    const classification = controller.classify(ability);
    expect(classification.isDestructive).toBe(true);
    expect(classification.requiresSafetyFlow).toBe(true);
  });

  it('forces destructive classification for suspend-* patterns', () => {
    const ability = createTestAbility('mainwp/suspend-site-v1', {
      destructive: false,
    });

    const classification = controller.classify(ability);
    expect(classification.isDestructive).toBe(true);
    expect(classification.requiresSafetyFlow).toBe(true);
  });

  it('forces destructive classification for run-updates-* patterns', () => {
    const ability = createTestAbility('run-updates-v1', {
      destructive: false,
    });

    const classification = controller.classify(ability);
    expect(classification.isDestructive).toBe(true);
    expect(classification.requiresSafetyFlow).toBe(true);
  });

  it.each(['update-site-plugins-v1', 'activate-site-theme-v1'])(
    'forces destructive classification for %s when annotations under-report it',
    (name) => {
      const ability = createTestAbility(name, {
        destructive: false,
        readonly: false,
      });

      const classification = controller.classify(ability);
      expect(classification.isDestructive).toBe(true);
      expect(classification.requiresSafetyFlow).toBe(true);
    }
  );

  // Names and annotations from mainwp/run-safe-update-v1 and its companions in the Dashboard's
  // includes/abilities/class-mainwp-abilities-safe-updates.php.
  it.each([
    'mainwp/run-safe-update-v1',
    'mainwp/continue-safe-update-run-v1',
    'mainwp/cancel-safe-update-run-v1',
    'mainwp/retest-safe-update-site-v1',
    'mainwp/resolve-safe-update-site-v1',
    'mainwp/rollback-safe-update-v1',
    'run-safe-update-v1',
    'continue-safe-update-run-v1',
    'cancel-safe-update-run-v1',
    'retest-safe-update-site-v1',
    'resolve-safe-update-site-v1',
  ])('forces destructive classification for Safe Updates ability %s', (name) => {
    const ability = createTestAbility(name, {
      destructive: false,
      readonly: true,
    });

    expect(isKnownDestructiveName(name)).toBe(true);
    const classification = controller.classify(ability);
    expect(classification.isDestructive).toBe(true);
    expect(classification.isReadOnly).toBe(false);
    expect(classification.requiresSafetyFlow).toBe(true);
  });

  it.each(['mainwp/list-safe-update-runs-v1', 'mainwp/get-safe-update-run-v1'])(
    'keeps Safe Updates read %s read-only',
    (name) => {
      const ability = createTestAbility(name, {
        destructive: false,
        readonly: true,
      });

      expect(isKnownDestructiveName(name)).toBe(false);
      const classification = controller.classify(ability);
      expect(classification.isDestructive).toBe(false);
      expect(classification.isReadOnly).toBe(true);
      expect(classification.requiresSafetyFlow).toBe(false);
    }
  );

  it.each(['list-updates-v1', 'cancel-batch-job-v1', 'continue-sync-v1', 'run-site-checks-v1'])(
    'does not widen the Safe Updates patterns to %s',
    (name) => {
      expect(isKnownDestructiveName(name)).toBe(false);
      expect(isKnownDestructiveName(`mainwp/${name}`)).toBe(false);
    }
  );

  it.each(['get-site-v1', 'sync-sites-v1'])(
    'keeps %s non-destructive',
    (name) => {
      const ability = createTestAbility(name, {
        destructive: false,
        readonly: false,
      });

      const classification = controller.classify(ability);
      expect(classification.isDestructive).toBe(false);
      expect(classification.requiresSafetyFlow).toBe(false);
    }
  );

  it('does not force destructive for non-matching ability names', () => {
    const ability = createTestAbility('list-sites-v1', {
      destructive: false,
      readonly: true,
    });

    const classification = controller.classify(ability);
    expect(classification.isDestructive).toBe(false);
    expect(classification.requiresSafetyFlow).toBe(false);
  });

  it('does not interfere when API already reports destructive correctly', () => {
    const ability = createTestAbility('delete-site-v1', {
      destructive: true,
    });

    const classification = controller.classify(ability);
    expect(classification.isDestructive).toBe(true);
    expect(classification.requiresSafetyFlow).toBe(true);
  });

  it('forces destructive classification for reset-* patterns', () => {
    const ability = createTestAbility('mainwp/reset-site-v1', {
      destructive: false,
      readonly: true,
    });

    const classification = controller.classify(ability);
    expect(classification.isDestructive).toBe(true);
    expect(classification.requiresSafetyFlow).toBe(true);
  });

  it('forces destructive classification for restore-* patterns', () => {
    const ability = createTestAbility('restore-backup-v1', {
      destructive: false,
    });

    const classification = controller.classify(ability);
    expect(classification.isDestructive).toBe(true);
    expect(classification.requiresSafetyFlow).toBe(true);
  });

  it('forces destructive classification for rollback-* patterns', () => {
    const ability = createTestAbility('mainwp/rollback-plugin-v1', {
      destructive: false,
    });

    const classification = controller.classify(ability);
    expect(classification.isDestructive).toBe(true);
    expect(classification.requiresSafetyFlow).toBe(true);
  });

  it('forces destructive classification for wipe-* patterns', () => {
    const ability = createTestAbility('wipe-site-v1', {
      destructive: false,
    });

    const classification = controller.classify(ability);
    expect(classification.isDestructive).toBe(true);
    expect(classification.requiresSafetyFlow).toBe(true);
  });

  it('forces destructive classification for purge-* patterns', () => {
    const ability = createTestAbility('mainwp/purge-cache-v1', {
      destructive: false,
      readonly: true,
    });

    const classification = controller.classify(ability);
    expect(classification.isDestructive).toBe(true);
    expect(classification.requiresSafetyFlow).toBe(true);
  });

  it('forces destructive classification for uninstall-* patterns', () => {
    const ability = createTestAbility('uninstall-plugin-v1', {
      destructive: false,
    });

    const classification = controller.classify(ability);
    expect(classification.isDestructive).toBe(true);
    expect(classification.requiresSafetyFlow).toBe(true);
  });

  it('does not force destructive for generic update-* patterns', () => {
    const ability = createTestAbility('update-dashboard-settings-v1', {
      destructive: false,
      readonly: true,
    });

    const classification = controller.classify(ability);
    expect(classification.isDestructive).toBe(false);
    expect(classification.requiresSafetyFlow).toBe(false);
  });
});

describe('formatPreviewResult: fail closed on absent preview evidence', () => {
  let controller: SafetyController;

  beforeEach(() => {
    controller = new SafetyController();
  });

  it('data undefined: honest "no data" warning, affected [], requiresApproval true', () => {
    const ability = createTestAbility('delete-site-v1', { destructive: true });
    const result = controller.formatPreviewResult(ability, {}, {
      success: true,
    });

    expect(result.affected).toEqual([]);
    expect(result.summary).toContain('Preview returned no data');
    expect(result.summary).not.toContain('No items would be affected');
    expect(result.requiresApproval).toBe(true);
  });

  it('data {}: same "no data" warning path as undefined data', () => {
    const ability = createTestAbility('delete-site-v1', { destructive: true });
    const result = controller.formatPreviewResult(ability, {}, {
      success: true,
      data: {},
    });

    expect(result.affected).toEqual([]);
    expect(result.summary).toContain('Preview returned no data');
    expect(result.summary).not.toContain('No items would be affected');
    expect(result.requiresApproval).toBe(true);
  });

  it('data in an unrecognized shape: "unrecognized format" warning, raw payload as affected', () => {
    const ability = createTestAbility('delete-site-v1', { destructive: true });
    const data = { foo: 'bar' };
    const result = controller.formatPreviewResult(ability, {}, {
      success: true,
      data,
    });

    expect(result.summary).toContain('unrecognized format');
    expect(result.affected).toEqual([data]);
    expect(result.requiresApproval).toBe(true);
  });

  it('data {affected: []}: recognized-but-empty summary "No items would be <verb>."', () => {
    const ability = createTestAbility('delete-site-v1', { destructive: true });
    const result = controller.formatPreviewResult(ability, {}, {
      success: true,
      data: { affected: [] },
    });

    expect(result.summary).toBe('No items would be deleted.');
    expect(result.affected).toEqual([]);
    expect(result.requiresApproval).toBe(true);
  });

  it('data {affected: [{id: 1}]}: counts 1 item, affected contains the item', () => {
    const ability = createTestAbility('delete-site-v1', { destructive: true });
    const item = { id: 1 };
    const result = controller.formatPreviewResult(ability, {}, {
      success: true,
      data: { affected: [item] },
    });

    expect(result.summary).toBe('1 item would be deleted.');
    expect(result.affected).toEqual([item]);
    expect(result.requiresApproval).toBe(true);
  });

  it('data {preview: {...}}: single-item preview still works', () => {
    const ability = createTestAbility('delete-site-v1', { destructive: true });
    const preview = { name: 'site-1' };
    const result = controller.formatPreviewResult(ability, {}, {
      success: true,
      data: { preview },
    });

    expect(result.summary).toBe('1 item would be deleted.');
    expect(result.affected).toEqual([preview]);
    expect(result.requiresApproval).toBe(true);
  });

  it('masks nested object and array writeOnly input values on the recognized path', () => {
    const ability = createTestAbility('delete-site-v1', { destructive: true });
    ability.input_schema = NESTED_WRITE_ONLY_SCHEMA;

    const result = controller.formatPreviewResult(ability, {
      credentials: { label: 'visible', secret: 'input-object-secret' },
      targets: [{ id: 7, token: 'input-array-secret' }],
    }, {
      success: true,
      data: { affected: [{ id: 7 }] },
    });

    expect(result.input).toEqual({
      credentials: { label: 'visible', secret: '[REDACTED]' },
      targets: [{ id: 7, token: '[REDACTED]' }],
    });
  });

  it('masks writeOnly values behind JSON-derived prototype-like own keys', () => {
    const ability = createTestAbility('delete-site-v1', { destructive: true });
    const dangerousProperties = JSON.parse(JSON.stringify({
      ['__proto__']: NESTED_WRITE_ONLY_SCHEMA,
      constructor: NESTED_WRITE_ONLY_SCHEMA,
      prototype: NESTED_WRITE_ONLY_SCHEMA,
    })) as Record<string, unknown>;
    ability.input_schema = {
      type: 'object',
      properties: dangerousProperties,
    };
    const input = JSON.parse(`{
      "__proto__":{"credentials":{"secret":"proto-secret"}},
      "constructor":{"targets":[{"token":"constructor-secret"}]},
      "prototype":{"credentials":{"secret":"prototype-secret"}}
    }`) as Record<string, unknown>;
    Object.setPrototypeOf(input, null);

    const result = controller.formatPreviewResult(ability, input, {
      success: true,
      data: { affected: [{ id: 7 }] },
    });

    expect(Object.getPrototypeOf(result.input)).toBe(null);
    expect(result.input).toEqual({
      ['__proto__']: { credentials: { secret: '[REDACTED]' } },
      constructor: { targets: [{ token: '[REDACTED]' }] },
      prototype: { credentials: { secret: '[REDACTED]' } },
    });
    expect(JSON.stringify(result.input)).not.toMatch(/proto-secret|constructor-secret|prototype-secret/);
  });

  it('masks nested object and array writeOnly response values on the recognized path', () => {
    const ability = createTestAbility('delete-site-v1', { destructive: true });
    ability.output_schema = {
      type: 'object',
      properties: {
        affected: {
          type: 'array',
          items: NESTED_WRITE_ONLY_SCHEMA,
        },
      },
    };

    const result = controller.formatPreviewResult(ability, {}, {
      success: true,
      data: {
        affected: [{
          credentials: { label: 'visible', secret: 'response-object-secret' },
          targets: [{ id: 7, token: 'response-array-secret' }],
        }],
      },
    });

    expect(result.affected).toEqual([{
      credentials: { label: 'visible', secret: '[REDACTED]' },
      targets: [{ id: 7, token: '[REDACTED]' }],
    }]);
  });

  it('masks nested object and array writeOnly input values on the unrecognized path', () => {
    const ability = createTestAbility('delete-site-v1', { destructive: true });
    ability.input_schema = NESTED_WRITE_ONLY_SCHEMA;

    const result = controller.formatPreviewResult(ability, {
      credentials: { label: 'visible', secret: 'input-object-secret' },
      targets: [{ id: 7, token: 'input-array-secret' }],
    }, {
      success: true,
      data: { payload: { name: 'visible' } },
    });

    expect(result.summary).toContain('unrecognized format');
    expect(result.input).toEqual({
      credentials: { label: 'visible', secret: '[REDACTED]' },
      targets: [{ id: 7, token: '[REDACTED]' }],
    });
  });

  it('masks nested object and array writeOnly response values on the unrecognized path', () => {
    const ability = createTestAbility('delete-site-v1', { destructive: true });
    ability.output_schema = {
      type: 'object',
      properties: {
        payload: NESTED_WRITE_ONLY_SCHEMA,
      },
    };

    const result = controller.formatPreviewResult(ability, {}, {
      success: true,
      data: {
        payload: {
          credentials: { label: 'visible', secret: 'response-object-secret' },
          targets: [{ id: 7, token: 'response-array-secret' }],
        },
      },
    });

    expect(result.summary).toContain('unrecognized format');
    expect(result.affected).toEqual([{
      payload: {
        credentials: { label: 'visible', secret: '[REDACTED]' },
        targets: [{ id: 7, token: '[REDACTED]' }],
      },
    }]);
  });
});

describe('ACTION_VERBS substring ordering', () => {
  it('uses "deactivated" verb for deactivate abilities, not "activated"', () => {
    const controller = new SafetyController();
    const ability = createTestAbility('mainwp/deactivate-site-plugins-v1', {
      destructive: true,
    });
    const result = controller.formatPreviewResult(ability, {}, {
      success: true,
      data: { affected: [{ id: 1 }] },
    });
    expect(result.summary).toContain('deactivated');
    // Ensure it matched "deactivate" not "activate" — the word before
    // "activated" must be "de" (i.e., only "deactivated" appears, not
    // a separate "activated" match)
    expect(result.summary).not.toMatch(/(?<!de)activated/);
  });
});
