/**
 * Profile list command for mainwpcontrol
 *
 * Lists all saved Dashboard profiles.
 */

import { BaseCommand, commonFlags } from '../../lib/base-command.js';
import { getProfileStore } from '../../config/profile-store.js';
import { formatTable, formatHeading } from '../../output/formatter.js';
import { maskUrlUserinfo } from '../../utils/format.js';

export default class ProfileList extends BaseCommand {
  static description = 'List saved Dashboard profiles';

  static examples = [
    '<%= config.bin %> profile list',
    '<%= config.bin %> profile list --json',
  ];

  static flags = {
    ...commonFlags,
  };

  // Doesn't need a profile loaded
  protected needsProfile(): boolean {
    return false;
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(ProfileList);
    await this.initCommon(flags);

    const profileStore = getProfileStore();
    const profiles = await profileStore.list();
    const activeName = await profileStore.getActiveName();

    this.output(
      {
        profiles: profiles.map((p) => ({
          name: p.name,
          // Legacy profiles may carry user:pass@ in the stored URL; the table
          // below prints even without --json, so both paths must mask it.
          url: maskUrlUserinfo(p.dashboardUrl),
          username: p.username,
          active: p.name === activeName,
        })),
        activeProfile: activeName,
      },
      () => {
        if (profiles.length === 0) {
          return 'No profiles configured. Run `mainwpcontrol login` to add one.';
        }

        const lines = [formatHeading('Profiles'), ''];

        const headers = ['Name', 'URL', 'Username', 'Active'];
        const rows = profiles.map((p) => [
          p.name,
          maskUrlUserinfo(p.dashboardUrl),
          p.username,
          p.name === activeName ? '*' : '',
        ]);

        lines.push(formatTable(headers, rows));

        return lines.join('\n');
      }
    );
  }
}
