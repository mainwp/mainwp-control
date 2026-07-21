import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigDir } from '../../src/__tests__/process/fixtures/config-dir.js';
import { MockServer } from '../../src/__tests__/process/fixtures/mock-server.js';
import {
  FIXTURE_APP_PASSWORD,
  FIXTURE_USERNAME,
  programFixtureServer,
} from './fixtures.js';
import { createArtifacts, type Artifacts } from './lib/artifacts.js';
import { CLIInvoker } from './lib/cli.js';
import { CommandRunner, type CommandRecord } from './lib/commands.js';
import {
  resolveAcceptanceCredentials,
  type AcceptanceCredentials,
} from './lib/env.js';
import { getWriteGuardReason } from './lib/guards.js';
import { packAndInstall, type PackedPackage } from './lib/pack.js';
import { Redactor } from './lib/redact.js';
import { IndependentVerifier } from './lib/verify.js';
import { scenarios } from './scenarios/index.js';
import {
  AssertionRecorder,
  type AcceptanceMode,
  type AcceptanceTarget,
  type ScenarioContext,
  type ScenarioDefinition,
  type ScenarioResult,
} from './scenarios/types.js';

interface RunnerOptions {
  mode: AcceptanceMode;
  target: AcceptanceTarget;
  scenarioIds: string[];
  writes: boolean;
  list: boolean;
  keepConsumer: boolean;
  help: boolean;
}

interface ResultDocument {
  runId: string;
  mode: AcceptanceMode;
  target: AcceptanceTarget;
  totals: Record<'passed' | 'failed' | 'skipped' | 'unverified', number>;
  scenarios: ScenarioResult[];
  artifactAudit: {
    passed: boolean;
    message: string;
  };
  harnessError: string | null;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function parseArgs(argv: string[]): RunnerOptions {
  const options: RunnerOptions = {
    mode: 'packed',
    target: 'live',
    scenarioIds: [],
    writes: false,
    list: false,
    keepConsumer: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--mode') {
      const value = requiredValue(argv, index, arg);
      if (value !== 'packed' && value !== 'source') {
        throw new Error(`Invalid --mode value: ${value}`);
      }
      options.mode = value;
      index += 1;
    } else if (arg === '--target') {
      const value = requiredValue(argv, index, arg);
      if (value !== 'live' && value !== 'fixture') {
        throw new Error(`Invalid --target value: ${value}`);
      }
      options.target = value;
      index += 1;
    } else if (arg === '--scenario') {
      options.scenarioIds.push(requiredValue(argv, index, arg));
      index += 1;
    } else if (arg === '--writes') {
      options.writes = true;
    } else if (arg === '--list') {
      options.list = true;
    } else if (arg === '--keep-consumer') {
      options.keepConsumer = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown acceptance flag: ${arg}`);
    }
  }
  return options;
}

function printHelp(): void {
  console.log(`Usage: tsx tests/acceptance/run.ts [options]

Options:
  --mode packed|source      Run the packed install (default) or repo binary
  --target live|fixture     Use live credentials (default) or local fixtures
  --scenario <id>           Run one scenario; repeat to select multiple
  --writes                  Enable guarded live write scenarios
  --list                    List registered scenarios
  --keep-consumer           Preserve the packed consumer directory
  --help                    Show this help`);
}

function selectedScenarios(ids: string[]): ScenarioDefinition[] {
  if (ids.length === 0) return scenarios;
  const byId = new Map(scenarios.map(scenario => [scenario.id, scenario]));
  const unknown = ids.filter(id => !byId.has(id));
  if (unknown.length > 0) throw new Error(`Unknown scenario IDs: ${unknown.join(', ')}`);
  return ids.map(id => byId.get(id)!);
}

function summarize(results: ScenarioResult[]): ResultDocument['totals'] {
  return {
    passed: results.filter(result => result.status === 'passed').length,
    failed: results.filter(result => result.status === 'failed').length,
    skipped: results.filter(result => result.status === 'skipped').length,
    unverified: results.filter(result => result.status === 'unverified').length,
  };
}

function invocationLabel(record: CommandRecord): string {
  return record.argv.slice(1).join(' ');
}

function summaryMarkdown(
  document: ResultDocument,
  cliInvocations: CommandRecord[],
): string {
  const lines = [
    '# MainWP Control acceptance results',
    '',
    `- Run: ${document.runId}`,
    `- Mode: ${document.mode}`,
    `- Target: ${document.target}`,
    `- Passed: ${document.totals.passed}`,
    `- Failed: ${document.totals.failed}`,
    `- Skipped: ${document.totals.skipped}`,
    `- Unverified: ${document.totals.unverified}`,
    `- Artifact audit: ${document.artifactAudit.passed ? 'passed' : 'failed'} — ${document.artifactAudit.message}`,
    ...(document.harnessError ? [`- Harness error: ${document.harnessError}`] : []),
    '',
    '| Scenario | Status | Duration (ms) | Purpose |',
    '| --- | --- | ---: | --- |',
    ...document.scenarios.map(result =>
      `| ${result.id} | ${result.status} | ${result.durationMs} | ${result.purpose.replace(/\|/g, '\\|')} |`
    ),
    '',
    '## 10 slowest scenarios',
    '',
    '| Scenario | Duration (ms) |',
    '| --- | ---: |',
    ...[...document.scenarios]
      .sort((left, right) => right.durationMs - left.durationMs)
      .slice(0, 10)
      .map(result => `| ${result.id} | ${result.durationMs} |`),
    '',
    '## 10 slowest CLI invocations',
    '',
    '| Invocation | Duration (ms) |',
    '| --- | ---: |',
    ...[...cliInvocations]
      .sort((left, right) => right.durationMs - left.durationMs)
      .slice(0, 10)
      .map(record => `| ${invocationLabel(record).replace(/\|/g, '\\|')} | ${record.durationMs} |`),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function resultDocument(
  artifacts: Artifacts,
  options: RunnerOptions,
  results: ScenarioResult[],
  artifactAudit: ResultDocument['artifactAudit'],
  harnessError: string | null = null,
): ResultDocument {
  return {
    runId: artifacts.runId,
    mode: options.mode,
    target: options.target,
    totals: summarize(results),
    scenarios: results,
    artifactAudit,
    harnessError,
  };
}

function recordAuditValues(
  values: Set<string>,
  credentials: AcceptanceCredentials,
): void {
  values.add(credentials.username);
  values.add(credentials.appPassword);
  values.add(credentials.appPassword.replace(/\s+/g, ''));
  values.add(new URL(credentials.dashboardUrl).origin);
  // Basic Authorization headers carry the credential base64-encoded; a leaked
  // header would otherwise slip past the plaintext checks above.
  values.add(
    Buffer.from(`${credentials.username}:${credentials.appPassword}`).toString('base64'),
  );
  values.add(
    Buffer.from(
      `${credentials.username}:${credentials.appPassword.replace(/\s+/g, '')}`,
    ).toString('base64'),
  );
}

function auditArtifacts(runDir: string, auditValues: Set<string>): string[] {
  const findings: string[] = [];
  const values = [...auditValues].filter(Boolean);
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      const content = fs.readFileSync(fullPath, 'utf8');
      if (values.some(value => content.includes(value))) {
        findings.push(path.relative(runDir, fullPath));
      }
    }
  };
  visit(runDir);
  return findings;
}

function combineScenarioErrors(current: unknown, next: unknown): unknown {
  if (current === undefined) return next;
  const currentMessage = current instanceof Error ? current.message : String(current);
  const nextMessage = next instanceof Error ? next.message : String(next);
  return new Error(`${currentMessage}\nCleanup error: ${nextMessage}`);
}

async function runScenario(
  definition: ScenarioDefinition,
  options: RunnerOptions,
  liveCredentials: AcceptanceCredentials | null,
  packedPackage: PackedPackage | null,
  runner: CommandRunner,
  artifacts: Artifacts,
  redactor: Redactor,
  auditValues: Set<string>,
  cliInvocations: CommandRecord[],
): Promise<ScenarioResult> {
  const started = performance.now();
  const assert = new AssertionRecorder();
  const skipped = (status: 'skipped' | 'unverified', reason: string): ScenarioResult => ({
    id: definition.id,
    purpose: definition.purpose,
    kind: definition.kind,
    status,
    durationMs: Math.round(performance.now() - started),
    assertions: assert.results,
    reason,
  });

  if (!definition.targets.includes(options.target)) {
    return skipped('skipped', `Scenario does not run against the ${options.target} target.`);
  }
  if (definition.id === 'packed-integrity' && options.mode === 'source') {
    return skipped('skipped', 'packed-integrity applies only to --mode packed.');
  }

  const guardUrl = liveCredentials?.dashboardUrl ?? 'http://127.0.0.1';
  if (definition.kind === 'write') {
    const guardReason = getWriteGuardReason(
      guardUrl,
      options.writes,
      options.target,
    );
    if (guardReason) return skipped('skipped', guardReason);
  }

  let mockServer: MockServer | null = null;
  let configDir: ConfigDir | null = null;
  let verifier: IndependentVerifier | null = null;
  let context: ScenarioContext | null = null;
  let scenarioError: unknown;
  let deferredResult: { status: 'skipped' | 'unverified'; reason: string } | null = null;
  const commandStart = runner.records.length;
  artifacts.appendScenarioStderr(definition.id, '');

  try {
    let credentials: AcceptanceCredentials;
    if (options.target === 'fixture') {
      mockServer = new MockServer();
      await mockServer.start();
      programFixtureServer(mockServer);
      credentials = {
        dashboardUrl: mockServer.baseUrl,
        username: FIXTURE_USERNAME,
        appPassword: FIXTURE_APP_PASSWORD,
      };
    } else {
      if (!liveCredentials) throw new Error('Live credentials were not resolved');
      credentials = liveCredentials;
    }

    recordAuditValues(auditValues, credentials);
    redactor.add({
      username: credentials.username,
      appPassword: credentials.appPassword,
      dashboardUrl: credentials.dashboardUrl,
      authorization: `Basic ${Buffer.from(
        `${credentials.username}:${credentials.appPassword}`,
      ).toString('base64')}`,
    });

    const skipTlsVerify = options.target === 'live';
    verifier = new IndependentVerifier(credentials, skipTlsVerify);
    let precondition;
    try {
      precondition = await definition.preconditions?.({
        target: options.target,
        mode: options.mode,
        credentials,
        verifier,
        packedPackage,
      });
    } catch (error) {
      deferredResult = {
        status: 'unverified',
        reason: `Precondition failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!deferredResult && precondition?.status) {
      deferredResult = {
        status: precondition.status,
        reason: precondition.reason ?? 'Precondition was not met.',
      };
    }

    if (!deferredResult) {
      configDir = await ConfigDir.create({
        profiles: [{
          name: 'acceptance',
          dashboardUrl: credentials.dashboardUrl,
          username: credentials.username,
          ...(skipTlsVerify ? { skipSSLVerification: true } : {}),
        }],
        activeProfile: 'acceptance',
        ...(precondition?.launch?.settings
          ? { settings: precondition.launch.settings }
          : {}),
      });
      const binaryPath = options.mode === 'packed'
        ? packedPackage?.binPath
        : path.join(repoRoot, 'bin', 'run.js');
      if (!binaryPath) throw new Error('Packed mode did not produce an installed binary');
      const cli = new CLIInvoker({
        binaryPath,
        cwd: options.mode === 'packed' ? packedPackage!.consumerDir : repoRoot,
        runner,
        configDir,
        credentials,
        ...(precondition?.launch?.env ? { env: precondition.launch.env } : {}),
        onStderr: stderr => {
          artifacts.appendScenarioStderr(
            definition.id,
            `\n--- CLI invocation stderr ---\n${stderr}`,
          );
        },
      });
      context = {
        cli,
        verifier,
        configDir,
        mockServer,
        config: {
          target: options.target,
          mode: options.mode,
          dashboardUrl: credentials.dashboardUrl,
          packageVersion: artifacts.manifest.packageVersion,
        },
        packedPackage,
        assert,
        state: precondition?.state ?? {},
      };

      artifacts.appendEvent(definition.id, 'runner-to-cli', { event: 'scenario-start' });
      await definition.run(context);
      if (process.env['MAINWP_CONTROL_ACCEPTANCE_FORCE_FAILURE'] === definition.id) {
        assert.equal('forced harness self-test failure', true, false);
      }
    }
  } catch (error) {
    scenarioError = combineScenarioErrors(scenarioError, error);
  } finally {
    if (context && definition.cleanup) {
      try {
        await definition.cleanup(context);
      } catch (error) {
        scenarioError = combineScenarioErrors(scenarioError, error);
      }
    }
    await verifier?.close().catch(error => {
      scenarioError = combineScenarioErrors(scenarioError, error);
    });
    await configDir?.cleanup().catch(error => {
      scenarioError = combineScenarioErrors(scenarioError, error);
    });
    await mockServer?.stop().catch(error => {
      scenarioError = combineScenarioErrors(scenarioError, error);
    });

    const scenarioCommands = runner.records.slice(commandStart).filter(record => {
      const executable = record.argv[0];
      return executable === context?.cli.binaryPath;
    });
    cliInvocations.push(...scenarioCommands);
    artifacts.appendEvent(definition.id, 'cli-to-runner', {
      event: 'scenario-finish',
      commandCount: scenarioCommands.length,
    });
  }

  if (scenarioError === undefined && deferredResult) {
    return skipped(deferredResult.status, deferredResult.reason);
  }
  const failed = scenarioError !== undefined || assert.results.some(result => !result.pass);
  return {
    id: definition.id,
    purpose: definition.purpose,
    kind: definition.kind,
    status: failed ? 'failed' : 'passed',
    durationMs: Math.round(performance.now() - started),
    assertions: assert.results,
    ...(scenarioError === undefined
      ? {}
      : { error: scenarioError instanceof Error ? scenarioError.message : String(scenarioError) }),
  };
}

async function runAcceptance(options: RunnerOptions): Promise<number> {
  if (options.help) {
    printHelp();
    return 0;
  }
  if (options.list) {
    for (const scenario of scenarios) {
      console.log(`${scenario.id}\t${scenario.kind}\t${scenario.targets.join(',')}\t${scenario.purpose}`);
    }
    return 0;
  }
  const definitions = selectedScenarios(options.scenarioIds);
  const liveCredentials = options.target === 'live'
    ? resolveAcceptanceCredentials()
    : null;
  const redactor = new Redactor(
    liveCredentials
      ? {
          username: liveCredentials.username,
          appPassword: liveCredentials.appPassword,
          dashboardUrl: liveCredentials.dashboardUrl,
          authorization: `Basic ${Buffer.from(
            `${liveCredentials.username}:${liveCredentials.appPassword}`,
          ).toString('base64')}`,
        }
      : {
          username: FIXTURE_USERNAME,
          appPassword: FIXTURE_APP_PASSWORD,
        },
  );
  const auditValues = new Set<string>();
  if (liveCredentials) recordAuditValues(auditValues, liveCredentials);
  else {
    auditValues.add(FIXTURE_USERNAME);
    auditValues.add(FIXTURE_APP_PASSWORD);
    auditValues.add(FIXTURE_APP_PASSWORD.replace(/\s+/g, ''));
  }
  const runner = new CommandRunner();
  const artifacts = await createArtifacts(
    repoRoot,
    redactor,
    runner,
    options.mode,
    options.target,
    {
      writes: options.writes,
      scenarios: options.scenarioIds,
      keepConsumer: options.keepConsumer,
    },
  );
  const results: ScenarioResult[] = [];
  const cliInvocations: CommandRecord[] = [];
  let packedPackage: PackedPackage | null = null;
  let harnessError: unknown;
  let artifactAudit: ResultDocument['artifactAudit'] = {
    passed: true,
    message: 'No registered credential or Dashboard-origin values were found.',
  };

  try {
    if (options.mode === 'packed') {
      packedPackage = await packAndInstall(
        repoRoot,
        runner,
        artifacts,
        options.keepConsumer,
      );
    }
    for (const definition of definitions) {
      const result = await runScenario(
        definition,
        options,
        liveCredentials,
        packedPackage,
        runner,
        artifacts,
        redactor,
        auditValues,
        cliInvocations,
      );
      results.push(result);
      artifacts.writeJson(
        'results.json',
        resultDocument(artifacts, options, results, artifactAudit),
      );
    }
    const document = resultDocument(artifacts, options, results, artifactAudit);
    artifacts.writeJson('results.json', document);
    artifacts.write('summary.md', summaryMarkdown(document, cliInvocations));
    artifacts.finish();
  } catch (error) {
    harnessError = error;
    const message = error instanceof Error ? error.message : String(error);
    const document = resultDocument(artifacts, options, results, artifactAudit, message);
    artifacts.writeJson('results.json', document);
    artifacts.write('summary.md', summaryMarkdown(document, cliInvocations));
    artifacts.finish();
  } finally {
    packedPackage?.cleanup();
  }

  const findings = auditArtifacts(artifacts.runDir, auditValues);
  if (findings.length > 0) {
    artifactAudit = {
      passed: false,
      message: `Sensitive values were found in: ${findings.join(', ')}`,
    };
  }
  const harnessMessage = harnessError instanceof Error
    ? harnessError.message
    : harnessError === undefined
      ? null
      : String(harnessError);
  const finalDocument = resultDocument(
    artifacts,
    options,
    results,
    artifactAudit,
    harnessMessage,
  );
  artifacts.writeJson('results.json', finalDocument);
  artifacts.write('summary.md', summaryMarkdown(finalDocument, cliInvocations));
  artifacts.finish();

  const finalFindings = auditArtifacts(artifacts.runDir, auditValues);
  if (finalFindings.length > 0 && artifactAudit.passed) {
    artifactAudit = {
      passed: false,
      message: `Sensitive values were found in: ${finalFindings.join(', ')}`,
    };
    const failedAuditDocument = resultDocument(
      artifacts,
      options,
      results,
      artifactAudit,
      harnessMessage,
    );
    artifacts.writeJson('results.json', failedAuditDocument);
    artifacts.write('summary.md', summaryMarkdown(failedAuditDocument, cliInvocations));
    artifacts.finish();
  }

  console.log(`Acceptance artifacts: ${artifacts.runDir}`);
  if (harnessError) {
    console.error(redactor.redact(harnessError instanceof Error ? harnessError.message : String(harnessError)));
    return 1;
  }
  return summarize(results).failed > 0 || !artifactAudit.passed ? 1 : 0;
}

try {
  process.exitCode = await runAcceptance(parseArgs(process.argv.slice(2)));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
