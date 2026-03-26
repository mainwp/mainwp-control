/**
 * Abilities list command for mainwpcontrol
 *
 * Lists all available abilities from the Dashboard.
 */

import { Flags } from '@oclif/core';
import { BaseCommand, commonFlags } from '../../lib/base-command.js';
import { formatTable, formatHeading } from '../../output/formatter.js';
import { color, colors } from '../../utils/colors.js';
import { stripControlChars } from '../../utils/terminal-sanitizer.js';
import type { Ability } from '../../core/abilities-executor.js';

/**
 * Build a copy-pasteable usage hint for an ability.
 * If the ability has required parameters, includes --input with placeholder values.
 */
function buildUsageHint(shortName: string, ability: Ability): string {
  const schema = ability.input_schema as
    | { required?: string[]; properties?: Record<string, { type?: string }> }
    | undefined;
  const required = schema?.required;
  if (!required || required.length === 0) {
    return `mainwpcontrol abilities run ${shortName}`;
  }

  const properties = schema?.properties ?? {};
  const params: Record<string, unknown> = {};

  for (const paramName of required) {
    params[paramName] = placeholderFor(paramName, properties[paramName]?.type);
  }

  return `mainwpcontrol abilities run ${shortName} --input '${JSON.stringify(params)}'`;
}

function placeholderFor(name: string, type?: string): unknown {
  // Specific names first
  if (name === 'job_id') return 'sync_abc123';
  if (name === 'url') return 'https://example.com';
  if (name === 'admin_username') return 'admin';
  if (name === 'name') return 'My Name';
  if (name === 'action') return 'ignore';
  if (name === 'type') return 'plugin';
  if (name === 'slug') return 'akismet/akismet.php';
  if (name === 'theme') return 'theme-slug';
  if (name === 'plugins') return ['akismet/akismet.php'];
  if (name === 'themes') return ['theme-slug'];
  if (name === 'slugs') return ['slug'];

  // Pattern-based names
  if (name.endsWith('_id_or_email') || name.endsWith('_id_or_domain')) return 1;
  if (name.endsWith('_id')) return 1;

  // Fall back to schema type
  if (type === 'integer' || type === 'number') return 1;
  if (type === 'boolean') return true;
  if (type === 'array') return ['value'];
  return 'value';
}

export default class AbilitiesList extends BaseCommand {
  static description = 'List available abilities';

  static examples = [
    '<%= config.bin %> abilities list',
    '<%= config.bin %> abilities list --category sites',
    '<%= config.bin %> abilities list --json',
  ];

  static flags = {
    ...commonFlags,
    category: Flags.string({
      char: 'c',
      description: 'Filter by category',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(AbilitiesList);
    await this.initCommon(flags);

    const executor = await this.getExecutor();

    let abilities = await executor.listAbilities();

    // Filter by category if specified
    if (flags.category) {
      abilities = abilities.filter(
        (a) => a.category.toLowerCase() === flags.category?.toLowerCase()
      );
    }

    // Get unique categories for display
    const categories = [...new Set(abilities.map((a) => a.category))].sort();

    this.output(
      {
        abilities: abilities.map((a) => ({
          name: a.name,
          label: a.label,
          category: a.category,
          readonly: a.meta?.annotations?.readonly ?? false,
          destructive: a.meta?.annotations?.destructive ?? false,
        })),
        total: abilities.length,
        categories,
      },
      () => {
        if (abilities.length === 0) {
          return 'No abilities found.';
        }

        const lines = [
          formatHeading(`Abilities (${abilities.length} total)`),
          '',
        ];

        // Group by category
        const grouped = new Map<string, typeof abilities>();
        for (const ability of abilities) {
          const cat = ability.category;
          if (!grouped.has(cat)) {
            grouped.set(cat, []);
          }
          grouped.get(cat)?.push(ability);
        }

        // Sort categories
        const sortedCategories = [...grouped.keys()].sort();

        for (const category of sortedCategories) {
          const catAbilities = grouped.get(category) ?? [];

          lines.push(formatHeading(`  ${category}`));

          const headers = ['Name', 'Description', 'Type'];
          const rows = catAbilities.map((a) => {
            let type = '📖 read';
            if (a.meta?.annotations?.destructive) {
              type = '⚠️  destructive';
            } else if (!a.meta?.annotations?.readonly) {
              type = '✏️  write';
            }
            return [a.name, a.label || a.description.slice(0, 50), type];
          });

          // Render table with usage sub-rows under each ability
          const tableStr = formatTable(headers, rows);
          const tableLines = tableStr.split('\n');
          // Header and separator
          lines.push(tableLines[0] ?? '', tableLines[1] ?? '');
          // Data rows with copy-pasteable usage hints
          for (let j = 0; j < catAbilities.length; j++) {
            lines.push(tableLines[j + 2] ?? '');
            const ability = catAbilities[j]!;
            const safeName = stripControlChars(ability.name);
            const shortName = safeName.split('/').pop() ?? safeName;
            const hint = buildUsageHint(shortName, ability);
            lines.push(color(`    ${hint}`, colors.dim));
          }

          lines.push('');
        }

        return lines.join('\n');
      }
    );
  }
}
