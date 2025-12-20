/**
 * Abilities list command for mainwpctl
 *
 * Lists all available abilities from the Dashboard.
 */

import { Flags } from '@oclif/core';
import { BaseCommand, commonFlags } from '../../lib/base-command.js';
import { formatTable, formatHeading } from '../../output/formatter.js';

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

          lines.push(formatTable(headers, rows));
          lines.push('');
        }

        return lines.join('\n');
      }
    );
  }
}
