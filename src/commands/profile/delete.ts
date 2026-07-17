/**
 * Profile delete command for mainwpcontrol
 *
 * Deletes a Dashboard profile and its credentials.
 */

import { Args } from '@oclif/core';
import { BaseCommand, commonFlags } from '../../lib/base-command.js';
import { getProfileStore } from '../../config/profile-store.js';
import { getKeychain } from '../../config/keychain.js';
import { formatSuccess, formatWarning } from '../../output/formatter.js';
import { ConfigError } from '../../utils/errors.js';
import { promptForConfirmation } from '../../utils/prompt.js';

export default class ProfileDelete extends BaseCommand {
  static description = 'Delete a Dashboard profile';

  static examples = [
    '<%= config.bin %> profile delete staging',
    '<%= config.bin %> profile delete old-profile --json',
  ];

  static flags = {
    ...commonFlags,
  };

  static args = {
    name: Args.string({
      description: 'Profile name to delete',
      required: true,
    }),
  };

  // Doesn't need a profile loaded initially
  protected needsProfile(): boolean {
    return false;
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ProfileDelete);
    await this.initCommon(flags);

    const profileStore = getProfileStore();
    const profile = await profileStore.get(args.name);

    if (!profile) {
      throw new ConfigError(
        `Profile not found: ${args.name}. Run \`mainwpcontrol profile list\` to see available profiles.`
      );
    }

    // Prompt for confirmation (returns false in non-interactive mode = safe default)
    const confirmed = await promptForConfirmation(
      `Delete profile "${args.name}" and its credentials?`
    );

    if (!confirmed) {
      this.log(formatWarning('Profile deletion cancelled.'));
      return;
    }

    // Delete credentials from keychain
    const keychain = getKeychain();
    const credentialDeletion = await keychain.delete(args.name);

    // Remove profile from profile store (handles active profile switching automatically)
    await profileStore.remove(args.name);

    this.output(
      {
        deleted: args.name,
        credentialsDeleted: credentialDeletion.deleted,
        message: credentialDeletion.deleted
          ? 'Profile and credentials deleted successfully'
          : 'Profile deleted, but keychain credential removal failed',
        ...(credentialDeletion.error ? { credentialWarning: credentialDeletion.error } : {}),
      },
      () => credentialDeletion.deleted
        ? formatSuccess(`Deleted profile: ${args.name}`)
        : [
            formatSuccess(`Deleted profile: ${args.name}`),
            formatWarning(
              `Keychain credential removal failed${credentialDeletion.error ? `: ${credentialDeletion.error}` : '.'}`
            ),
          ].join('\n')
    );
  }
}
