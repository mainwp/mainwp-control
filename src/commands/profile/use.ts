/**
 * Profile use command for mainwpcontrol
 *
 * Switches the active Dashboard profile.
 */

import { Args } from '@oclif/core';
import { BaseCommand, commonFlags } from '../../lib/base-command.js';
import { getProfileStore } from '../../config/profile-store.js';
import { formatSuccess } from '../../output/formatter.js';
import { maskUrlUserinfo } from '../../utils/format.js';
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
        `Profile not found: ${args.name}. Run \`mainwpcontrol profile list\` to see available profiles.`
      );
    }

    await profileStore.setActive(args.name);

    this.output(
      {
        profile: args.name,
        // Legacy profiles may carry user:pass@ in the stored URL; every
        // display path must mask it.
        url: maskUrlUserinfo(profile.dashboardUrl),
        username: profile.username,
      },
      () => formatSuccess(`Switched to profile: ${args.name}`)
    );
  }
}
