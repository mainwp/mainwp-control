/**
 * Profile use command for mainwpctl
 *
 * Switches the active Dashboard profile.
 */

import { Args } from '@oclif/core';
import { BaseCommand, commonFlags } from '../../lib/base-command.js';
import { getProfileStore } from '../../config/profile-store.js';
import { formatSuccess } from '../../output/formatter.js';
import { ConfigError } from '../../utils/errors.js';

export default class ProfileUse extends BaseCommand {
  static description = 'Switch active Dashboard profile';

  static examples = [
    '<%= config.bin %> profile use production',
    '<%= config.bin %> profile use staging --json',
  ];

  static flags = {
    ...commonFlags,
  };

  static args = {
    name: Args.string({
      description: 'Profile name to activate',
      required: true,
    }),
  };

  // Doesn't need a profile loaded initially
  protected needsProfile(): boolean {
    return false;
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ProfileUse);
    await this.initCommon(flags);

    const profileStore = getProfileStore();
    const profile = await profileStore.get(args.name);

    if (!profile) {
      throw new ConfigError(
        `Profile not found: ${args.name}. Run \`mainwpctl profile list\` to see available profiles.`
      );
    }

    await profileStore.setActive(args.name);

    this.output(
      {
        profile: args.name,
        url: profile.dashboardUrl,
        username: profile.username,
      },
      () => formatSuccess(`Switched to profile: ${args.name}`)
    );
  }
}
