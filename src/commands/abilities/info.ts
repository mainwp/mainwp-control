/**
 * Abilities info command for mainwpcontrol
 *
 * Shows detailed information about a specific ability.
 */

import { Args } from '@oclif/core';
import { BaseCommand, commonFlags } from '../../lib/base-command.js';
import { formatHeading, formatKeyValue } from '../../output/formatter.js';
import { InputError } from '../../utils/errors.js';

export default class AbilitiesInfo extends BaseCommand {
  static description = 'Get detailed information about an ability';

  static examples = [
    '<%= config.bin %> abilities info list-sites-v1',
    '<%= config.bin %> abilities info mainwp/delete-site-v1 --json',
  ];

  static flags = {
    ...commonFlags,
  };

  static args = {
    name: Args.string({
      description: 'Ability name (e.g., list-sites-v1)',
      required: true,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AbilitiesInfo);
    await this.initCommon(flags);

    const executor = await this.getExecutor();
    const ability = await executor.getAbility(args.name);

    if (!ability) {
      throw new InputError(
        `Ability not found: ${args.name}. Run \`mainwpcontrol abilities list\` to see available abilities.`
      );
    }

    this.output(
      {
        name: ability.name,
        label: ability.label,
        description: ability.description,
        category: ability.category,
        annotations: ability.meta?.annotations ?? {},
        inputSchema: ability.input_schema,
        outputSchema: ability.output_schema,
      },
      () => {
        const lines = [
          formatHeading(ability.label || ability.name),
          '',
          ability.description,
          '',
          formatKeyValue('Name', ability.name),
          formatKeyValue('Category', ability.category),
          '',
          formatHeading('Annotations'),
        ];

        const annotations = ability.meta?.annotations;
        if (annotations) {
          lines.push(formatKeyValue('  Readonly', annotations.readonly ? 'Yes' : 'No'));
          lines.push(formatKeyValue('  Destructive', annotations.destructive ? 'Yes' : 'No'));
          lines.push(formatKeyValue('  Idempotent', annotations.idempotent ? 'Yes' : 'No'));

          if (annotations.instructions) {
            lines.push('');
            lines.push(formatHeading('Instructions'));
            lines.push(annotations.instructions);
          }
        } else {
          lines.push('  (no annotations)');
        }

        if (ability.input_schema) {
          lines.push('');
          lines.push(formatHeading('Input Schema'));
          lines.push(JSON.stringify(ability.input_schema, null, 2));
        }

        if (ability.output_schema) {
          lines.push('');
          lines.push(formatHeading('Output Schema'));
          lines.push(JSON.stringify(ability.output_schema, null, 2));
        }

        return lines.join('\n');
      }
    );
  }
}
