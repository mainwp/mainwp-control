/**
 * Doctor Command for mainwpctl
 *
 * Diagnoses configuration issues and validates connectivity.
 *
 * Checks:
 * - Profile configuration
 * - Credential storage (keychain)
 * - Dashboard connectivity
 * - Abilities API availability
 * - LLM provider configuration
 */

import { Flags } from '@oclif/core';
import { BaseCommand, commonFlags } from '../lib/base-command.js';
import { getProfileStore } from '../config/profile-store.js';
import { getKeychain } from '../config/keychain.js';
import {
  detectConfiguredProvider,
  PROVIDER_ENV_VARS,
  getProviderConfigFromEnv,
} from '../chat/providers/provider.js';

/**
 * Check result
 */
interface CheckResult {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
  details?: string | undefined;
}

/**
 * Doctor report
 */
interface DoctorReport {
  checks: CheckResult[];
  summary: {
    passed: number;
    warnings: number;
    failed: number;
  };
  ready: boolean;
}

export default class DoctorCommand extends BaseCommand {
  static override description = 'Diagnose configuration and connectivity issues';

  static override examples = [
    {
      command: '<%= config.bin %> doctor',
      description: 'Run all diagnostic checks',
    },
    {
      command: '<%= config.bin %> doctor --json',
      description: 'Output results in JSON format',
    },
  ];

  static override flags = {
    ...commonFlags,
    verbose: Flags.boolean({
      char: 'v',
      description: 'Show detailed output',
      default: false,
    }),
  };

  /**
   * Don't require a profile for doctor command
   */
  protected override needsProfile(): boolean {
    return false;
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(DoctorCommand);

    await this.initCommon(flags);

    const checks: CheckResult[] = [];

    // Run all checks
    checks.push(await this.checkProfiles());
    checks.push(await this.checkKeychain());
    checks.push(await this.checkActiveProfile());
    checks.push(await this.checkCredentials());
    checks.push(await this.checkDashboardConnection());
    checks.push(await this.checkAbilitiesAPI());
    checks.push(await this.checkLLMProvider());

    // Build report
    const report = this.buildReport(checks);

    // Output
    if (this.jsonOutput) {
      this.output(report);
    } else {
      this.displayReport(report, flags.verbose);
    }

    // Exit with error if not ready
    if (!report.ready) {
      this.exit(1);
    }
  }

  /**
   * Check if profiles are configured
   */
  private async checkProfiles(): Promise<CheckResult> {
    try {
      const profileStore = getProfileStore();
      const profiles = await profileStore.list();

      if (profiles.length === 0) {
        return {
          name: 'Profiles',
          status: 'fail',
          message: 'No profiles configured',
          details: 'Run `mainwpctl login` to create a profile',
        };
      }

      return {
        name: 'Profiles',
        status: 'pass',
        message: `${profiles.length} profile(s) configured`,
        details: profiles.map((p) => p.name).join(', '),
      };
    } catch (error) {
      return {
        name: 'Profiles',
        status: 'fail',
        message: 'Failed to read profiles',
        details: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Check keychain availability
   */
  private async checkKeychain(): Promise<CheckResult> {
    try {
      const keychain = getKeychain();
      const available = await keychain.isAvailable();

      if (!available) {
        return {
          name: 'Keychain',
          status: 'warn',
          message: 'OS keychain not available',
          details:
            'Credentials will use MAINWP_APP_PASSWORD environment variable. ' +
            'Consider installing keytar for secure storage.',
        };
      }

      return {
        name: 'Keychain',
        status: 'pass',
        message: 'OS keychain available',
      };
    } catch (error) {
      return {
        name: 'Keychain',
        status: 'warn',
        message: 'Could not check keychain',
        details: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Check active profile
   */
  private async checkActiveProfile(): Promise<CheckResult> {
    try {
      const profileStore = getProfileStore();
      const activeProfile = await profileStore.getActive();

      if (!activeProfile) {
        return {
          name: 'Active Profile',
          status: 'fail',
          message: 'No active profile',
          details: 'Run `mainwpctl login` or `mainwpctl profile use <name>`',
        };
      }

      this.currentProfile = activeProfile;

      return {
        name: 'Active Profile',
        status: 'pass',
        message: `Active: ${activeProfile.name}`,
        details: activeProfile.dashboardUrl,
      };
    } catch (error) {
      return {
        name: 'Active Profile',
        status: 'fail',
        message: 'Failed to load active profile',
        details: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Check credentials
   */
  private async checkCredentials(): Promise<CheckResult> {
    if (!this.currentProfile) {
      return {
        name: 'Credentials',
        status: 'fail',
        message: 'No profile to check',
      };
    }

    try {
      const keychain = getKeychain();
      const password = await keychain.get(this.currentProfile.name);

      if (!password) {
        return {
          name: 'Credentials',
          status: 'fail',
          message: 'No credentials found',
          details:
            'Run `mainwpctl login` or set MAINWP_APP_PASSWORD environment variable',
        };
      }

      // Mask password for display
      const masked = password.substring(0, 4) + '...' + password.substring(password.length - 4);

      return {
        name: 'Credentials',
        status: 'pass',
        message: 'Credentials available',
        details: `Application Password: ${masked}`,
      };
    } catch (error) {
      return {
        name: 'Credentials',
        status: 'fail',
        message: 'Failed to load credentials',
        details: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Check Dashboard connection
   */
  private async checkDashboardConnection(): Promise<CheckResult> {
    if (!this.currentProfile) {
      return {
        name: 'Dashboard Connection',
        status: 'fail',
        message: 'No profile to check',
      };
    }

    try {
      // Try to get executor (which validates connection)
      const executor = await this.getExecutor();

      // Test with a simple request
      const abilities = await executor.listAbilities();

      return {
        name: 'Dashboard Connection',
        status: 'pass',
        message: 'Connected to Dashboard',
        details: `${abilities.length} abilities available`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // Provide specific guidance based on error
      let details = message;
      if (message.includes('ECONNREFUSED')) {
        details = 'Connection refused. Is the Dashboard running?';
      } else if (message.includes('ENOTFOUND')) {
        details = 'Host not found. Check the Dashboard URL.';
      } else if (message.includes('certificate')) {
        details = 'SSL certificate error. Use --skip-ssl-verify if needed.';
      } else if (message.includes('401') || message.includes('Authentication')) {
        details = 'Authentication failed. Check your credentials.';
      }

      return {
        name: 'Dashboard Connection',
        status: 'fail',
        message: 'Cannot connect to Dashboard',
        details,
      };
    }
  }

  /**
   * Check Abilities API
   */
  private async checkAbilitiesAPI(): Promise<CheckResult> {
    if (!this.currentProfile) {
      return {
        name: 'Abilities API',
        status: 'fail',
        message: 'No profile to check',
      };
    }

    try {
      const executor = await this.getExecutor();
      const abilities = await executor.listAbilities();

      // Check for required abilities
      const requiredAbilities = [
        'list-sites-v1',
        'get-site-v1',
      ];

      const missing = requiredAbilities.filter(
        (name) => !abilities.find((a) => a.name === name)
      );

      if (missing.length > 0) {
        return {
          name: 'Abilities API',
          status: 'warn',
          message: 'Some abilities missing',
          details: `Missing: ${missing.join(', ')}`,
        };
      }

      // Check for destructive abilities
      const destructive = abilities.filter((a) => a.meta?.annotations?.destructive);

      return {
        name: 'Abilities API',
        status: 'pass',
        message: `${abilities.length} abilities available`,
        details: `${destructive.length} destructive abilities (safety enforced)`,
      };
    } catch (error) {
      return {
        name: 'Abilities API',
        status: 'fail',
        message: 'Failed to load abilities',
        details: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Check LLM provider configuration
   */
  private async checkLLMProvider(): Promise<CheckResult> {
    const detectedProvider = detectConfiguredProvider();

    if (!detectedProvider) {
      // List all possible env vars
      const envVars = Object.entries(PROVIDER_ENV_VARS)
        .map(([name, config]) => `  ${name}: ${config.key}`)
        .join('\n');

      return {
        name: 'LLM Provider',
        status: 'warn',
        message: 'No LLM provider configured',
        details:
          'Chat mode will not work. Set one of these environment variables:\n' +
          envVars,
      };
    }

    // Check if provider has valid config
    const config = getProviderConfigFromEnv(detectedProvider);

    if (!config?.apiKey) {
      return {
        name: 'LLM Provider',
        status: 'warn',
        message: `${detectedProvider} detected but no API key`,
        details: `Set ${PROVIDER_ENV_VARS[detectedProvider]?.key ?? 'API key'}`,
      };
    }

    // Mask API key
    const masked =
      config.apiKey.substring(0, 6) +
      '...' +
      config.apiKey.substring(config.apiKey.length - 4);

    return {
      name: 'LLM Provider',
      status: 'pass',
      message: `${detectedProvider} configured`,
      details: `API Key: ${masked}`,
    };
  }

  /**
   * Build summary report
   */
  private buildReport(checks: CheckResult[]): DoctorReport {
    const summary = {
      passed: checks.filter((c) => c.status === 'pass').length,
      warnings: checks.filter((c) => c.status === 'warn').length,
      failed: checks.filter((c) => c.status === 'fail').length,
    };

    // Ready if no critical failures (connection to dashboard)
    const criticalChecks = ['Profiles', 'Active Profile', 'Credentials', 'Dashboard Connection'];
    const criticalFailed = checks.some(
      (c) => criticalChecks.includes(c.name) && c.status === 'fail'
    );

    return {
      checks,
      summary,
      ready: !criticalFailed,
    };
  }

  /**
   * Display report in human-readable format
   */
  private displayReport(report: DoctorReport, verbose: boolean): void {
    this.log('\n  MainWP Control CLI - System Check\n');
    this.log('  ' + '─'.repeat(40));

    for (const check of report.checks) {
      const icon = this.getStatusIcon(check.status);
      const color = this.getStatusColor(check.status);

      this.log(`  ${icon} ${check.name}`);
      this.log(`     ${color}${check.message}\x1b[0m`);

      if (verbose && check.details) {
        // Indent multiline details
        const detailLines = check.details.split('\n');
        for (const line of detailLines) {
          this.log(`     \x1b[90m${line}\x1b[0m`);
        }
      }
    }

    this.log('  ' + '─'.repeat(40));

    // Summary
    this.log(
      `  Summary: \x1b[32m${report.summary.passed} passed\x1b[0m, ` +
        `\x1b[33m${report.summary.warnings} warnings\x1b[0m, ` +
        `\x1b[31m${report.summary.failed} failed\x1b[0m`
    );

    if (report.ready) {
      this.log('\n  \x1b[32m✓ System is ready\x1b[0m\n');
    } else {
      this.log('\n  \x1b[31m✗ System has critical issues\x1b[0m');
      this.log('  Run with -v for more details\n');
    }
  }

  /**
   * Get status icon
   */
  private getStatusIcon(status: CheckResult['status']): string {
    switch (status) {
      case 'pass':
        return '\x1b[32m✓\x1b[0m';
      case 'warn':
        return '\x1b[33m⚠\x1b[0m';
      case 'fail':
        return '\x1b[31m✗\x1b[0m';
    }
  }

  /**
   * Get status color escape code
   */
  private getStatusColor(status: CheckResult['status']): string {
    switch (status) {
      case 'pass':
        return '\x1b[32m';
      case 'warn':
        return '\x1b[33m';
      case 'fail':
        return '\x1b[31m';
    }
  }
}
