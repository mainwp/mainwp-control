#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import type { ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigDir } from '../../src/__tests__/process/fixtures/config-dir.js';
import {
  MockServer,
  type RecordedRequest,
} from '../../src/__tests__/process/fixtures/mock-server.js';
import {
  FIXTURE_ABILITIES,
  FIXTURE_APP_PASSWORD,
  FIXTURE_SITES,
  FIXTURE_USERNAME,
} from './fixtures.js';
import { createArtifacts, type Artifacts } from './lib/artifacts.js';
import { CommandRunner } from './lib/commands.js';
import {
  resolveAcceptanceCredentials,
  type AcceptanceCredentials,
} from './lib/env.js';
import { getWriteGuardReason } from './lib/guards.js';
import { packAndInstall, type PackedPackage } from './lib/pack.js';
import { Redactor } from './lib/redact.js';
import { IndependentVerifier } from './lib/verify.js';

type AgentMode = 'packed' | 'source';
type AgentStatus = 'passed' | 'failed' | 'skipped' | 'unverified';

interface AgentRunnerOptions {
  mode: AgentMode;
  scenarioIds: string[];
  writes: boolean;
  list: boolean;
  keepConsumer: boolean;
  help: boolean;
}

interface AgentGroundTruth {
  count?: number;
  siteId?: number;
  siteUrl?: string;
  siteName?: string;
  pluginActive?: boolean;
  pluginName?: string;
  pluginSlug?: string;
  updateSiteUrls?: string[];
  beforeSiteCount?: number;
  targetSiteId?: number;
  targetSiteUrl?: string;
  targetSiteName?: string;
}

interface AgentScenario {
  id: string;
  kind: 'read' | 'write';
  target: 'live' | 'fixture';
  task(groundTruth: AgentGroundTruth): string;
  expectedAbilities: string[];
  groundTruth(verifier: IndependentVerifier): Promise<AgentGroundTruth>;
  evaluate?: (
    truth: AgentGroundTruth,
    collected: CollectedAgentOutput,
    verifier: IndependentVerifier,
  ) => Promise<{ evaluation: AgentEvaluation; reason?: string }>;
}

interface EvaluationField {
  pass: boolean;
  evidence: unknown;
}

interface AgentEvaluation {
  understoodRequest: EvaluationField;
  rightCapability: EvaluationField;
  rightArguments: EvaluationField;
  correctCliResult: EvaluationField;
  stateChange: EvaluationField;
  faithfulFinalAnswer: EvaluationField;
}

interface AgentTiming {
  process_wall_clock_ms: number | null;
  duration_ms: number | null;
  duration_api_ms: number | null;
  ttft_ms: number | null;
  invocation_count: number;
}

interface AgentResult {
  id: string;
  status: AgentStatus;
  target: 'live' | 'fixture';
  model?: string;
  invocations: RecordedCliInvocation[];
  finalText: string;
  timing: AgentTiming;
  groundTruth?: AgentGroundTruth;
  evaluation?: AgentEvaluation;
  reason?: string;
}

interface AgentResultDocument {
  runId: string;
  mode: AgentMode;
  target: 'live';
  totals: Record<AgentStatus, number>;
  scenarios: AgentResult[];
  artifactAudit: {
    passed: boolean;
    message: string;
  };
  harnessError: string | null;
}

interface RecordedCliInvocation {
  toolUseId?: string;
  command: string;
  argv: string[];
  parseError?: string;
}

interface RecordedToolResult {
  toolUseId?: string;
  content: unknown;
  isError?: boolean;
}

interface CollectedAgentOutput {
  invocations: RecordedCliInvocation[];
  toolResults: RecordedToolResult[];
  finalText: string;
  model?: string;
  durationMs?: number;
  durationApiMs?: number;
  ttftMs?: number;
}

interface PreparedCli {
  binDir: string;
  cwd: string;
  packedPackage: PackedPackage | null;
  cleanup(): void;
}

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

// The delete scenario runs against the local fixture Dashboard. A live victim
// is not repeatable: MainWP Child locks to a dashboard key on first connect,
// so every add->delete cycle would leave the child rejecting the next add.
// The mcp reference harness scopes its agent delete scenario the same way.
type AgentFixtureSite = Omit<(typeof FIXTURE_SITES)[number], 'plugins'>;

function jsonResponse(response: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(encoded),
  });
  response.end(encoded);
}

function fixtureRequestInput(request: RecordedRequest): Record<string, unknown> {
  if (request.method === 'GET' || request.method === 'DELETE') {
    const input: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(request.query)) {
      const match = key.match(/^input\[([^\]]+)\]$/);
      if (!match?.[1]) continue;
      input[match[1]] = /^-?\d+$/.test(value) ? Number(value) : value;
    }
    return input;
  }
  const body = request.body as Record<string, unknown> | undefined;
  const input = body?.['input'];
  return input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
}

function programAgentFixture(server: MockServer): void {
  const sites: AgentFixtureSite[] = FIXTURE_SITES.map(
    ({ plugins: _plugins, ...site }) => ({ ...site }),
  );
  const findSite = (identifier: unknown): AgentFixtureSite | undefined => {
    const normalized = String(identifier ?? '').replace(/\/+$/, '').toLowerCase();
    return sites.find(site => {
      const url = site.url.replace(/\/+$/, '').toLowerCase();
      return String(site.id) === normalized
        || url === normalized
        || new URL(url).hostname === normalized;
    });
  };

  server.reset();
  server.setCredentials(FIXTURE_USERNAME, FIXTURE_APP_PASSWORD);
  server.setAbilities(FIXTURE_ABILITIES);
  server.addRoute(
    'GET',
    '/wp-json/wp-abilities/v1/abilities/mainwp/list-sites-v1/run',
    (request, response) => {
      const input = fixtureRequestInput(request);
      const page = typeof input['page'] === 'number' ? input['page'] : 1;
      const perPage = typeof input['per_page'] === 'number' ? input['per_page'] : 20;
      const start = (page - 1) * perPage;
      jsonResponse(response, 200, {
        items: sites.slice(start, start + perPage),
        page,
        per_page: perPage,
        total: sites.length,
      });
    },
  );
  server.addRoute(
    'GET',
    '/wp-json/wp-abilities/v1/abilities/mainwp/count-sites-v1/run',
    (_request, response) => jsonResponse(response, 200, { total: sites.length }),
  );
  server.addRoute(
    'GET',
    '/wp-json/wp-abilities/v1/abilities/mainwp/get-site-v1/run',
    (request, response) => {
      const site = findSite(fixtureRequestInput(request)['site_id_or_domain']);
      if (!site) {
        jsonResponse(response, 404, {
          code: 'mainwp_site_not_found',
          message: 'The requested synthetic site was not found.',
          data: { status: 404 },
        });
        return;
      }
      jsonResponse(response, 200, site);
    },
  );
  server.addRoute(
    'POST',
    '/wp-json/wp-abilities/v1/abilities/mainwp/delete-site-v1/run',
    (request, response) => {
      const input = fixtureRequestInput(request);
      const site = findSite(input['site_id_or_domain']);
      if (!site) {
        jsonResponse(response, 404, {
          code: 'mainwp_site_not_found',
          message: 'The requested synthetic site was not found.',
          data: { status: 404 },
        });
        return;
      }
      if (input['dry_run'] === true) {
        jsonResponse(response, 200, {
          dry_run: true,
          would_affect: { id: site.id, url: site.url, name: site.name },
          warnings: ['This synthetic site record will be permanently deleted.'],
        });
        return;
      }
      sites.splice(sites.findIndex(candidate => candidate.id === site.id), 1);
      jsonResponse(response, 200, {
        dry_run: false,
        deleted: true,
        site: { id: site.id, url: site.url, name: site.name },
        would_affect: {},
        warnings: [],
      });
    },
  );
}

const agentScenarios: AgentScenario[] = [
  {
    id: 'agent-count-sites',
    kind: 'read',
    target: 'live',
    task: () => 'How many sites are currently connected to my MainWP dashboard?',
    expectedAbilities: ['mainwp/count-sites-v1', 'mainwp/list-sites-v1'],
    groundTruth: async verifier => ({ count: await verifier.countSites() }),
  },
  {
    id: 'agent-updates',
    kind: 'read',
    target: 'live',
    task: () => 'Which of my sites need plugin updates?',
    expectedAbilities: [
      'mainwp/list-updates-v1',
      'mainwp/list-sites-v1',
      'mainwp/get-site-plugins-v1',
    ],
    groundTruth: async verifier => {
      const updateSiteUrls: string[] = [];
      for (const site of await verifier.listSites()) {
        const plugins = await verifier.getSitePlugins(site.id);
        if (plugins.plugins.some(plugin => Boolean(plugin.update_version))) {
          updateSiteUrls.push(site.url);
        }
      }
      return { updateSiteUrls: updateSiteUrls.sort() };
    },
  },
  {
    id: 'agent-plugin-active',
    kind: 'read',
    target: 'live',
    task: truth =>
      `Is the ${truth.pluginName} plugin active on ${truth.siteUrl}? Answer yes or no with the site name.`,
    expectedAbilities: [
      'mainwp/get-site-plugins-v1',
      'mainwp/get-site-v1',
      'mainwp/list-sites-v1',
    ],
    groundTruth: async verifier => {
      const preferred = process.env['MAINWP_CONTROL_ACCEPTANCE_TOGGLE_PLUGIN'];
      const sites = await verifier.listSites();
      if (sites.length === 0) throw new Error('No site is available for agent-plugin-active');
      for (const site of sites) {
        const plugins = (await verifier.getSitePlugins(site.id)).plugins;
        const plugin = preferred
          ? plugins.find(candidate => candidate.slug === preferred)
          : plugins[0];
        if (plugin?.name) {
          return {
            siteId: site.id,
            siteUrl: site.url,
            siteName: site.name,
            pluginActive: plugin.active,
            pluginName: plugin.name,
            pluginSlug: plugin.slug,
          };
        }
      }
      throw new Error('No discoverable plugin was found for agent-plugin-active');
    },
  },
  {
    id: 'agent-confirm-delete-site',
    kind: 'write',
    target: 'fixture',
    task: truth =>
      `Delete the MainWP site named ${truth.targetSiteName} at ${truth.targetSiteUrl} (site ID ${truth.targetSiteId}). This deletion is explicitly authorized. Preview the deletion first. If the preview matches this site, execute it with explicit confirmation and no interactive prompt, then report the outcome.`,
    expectedAbilities: ['mainwp/delete-site-v1'],
    groundTruth: async verifier => {
      const sites = await verifier.listSites();
      const target = sites[0];
      if (!target) throw new Error('No fixture site was available for the delete scenario');
      return {
        beforeSiteCount: sites.length,
        targetSiteId: target.id,
        targetSiteUrl: target.url,
        targetSiteName: target.name,
      };
    },
    evaluate: evaluateDeleteScenario,
  },
];

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function parseArgs(argv: string[]): AgentRunnerOptions {
  const options: AgentRunnerOptions = {
    mode: 'packed',
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
  console.log(`Usage: tsx tests/acceptance/agent-run.ts [options]

Options:
  --mode packed|source      Run the packed install (default) or repo binary
  --scenario <id>           Run one scenario; repeat to select multiple
  --writes                  Allow live write scenarios (the delete scenario
                            uses the local fixture Dashboard and always runs)
  --list                    List registered agent scenarios
  --keep-consumer           Preserve the packed consumer directory
  --help                    Show this help`);
}

function selectedScenarios(ids: string[]): AgentScenario[] {
  if (ids.length === 0) return agentScenarios;
  const byId = new Map(agentScenarios.map(scenario => [scenario.id, scenario]));
  const unknown = ids.filter(id => !byId.has(id));
  if (unknown.length > 0) throw new Error(`Unknown agent scenario IDs: ${unknown.join(', ')}`);
  return ids.map(id => byId.get(id)!);
}

function shellDisplay(argv: string[]): string {
  return argv.map(value => (/[\s*]/.test(value) ? JSON.stringify(value) : value)).join(' ');
}

function parseShellArgv(command: string): string[] {
  const argv: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;
  const pushCurrent = (): void => {
    if (current.length > 0) {
      argv.push(current);
      current = '';
    }
  };

  for (const character of command) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      pushCurrent();
      continue;
    }
    if (character === ';' || character === '|' || character === '&') {
      pushCurrent();
      break;
    }
    current += character;
  }
  if (escaped || quote) throw new Error('Bash command contains an unterminated escape or quote');
  pushCurrent();
  return argv;
}

function contentBlocks(event: unknown): unknown[] {
  if (!event || typeof event !== 'object') return [];
  const message = (event as Record<string, unknown>)['message'];
  if (!message || typeof message !== 'object') return [];
  const content = (message as Record<string, unknown>)['content'];
  return Array.isArray(content) ? content : [];
}

function collectEvent(
  event: unknown,
  accumulator: CollectedAgentOutput,
  elapsedMs: number,
): void {
  if (!event || typeof event !== 'object') return;
  const record = event as Record<string, unknown>;
  if (record['type'] === 'assistant' && accumulator.ttftMs === undefined) {
    accumulator.ttftMs = elapsedMs;
  }
  if (typeof record['model'] === 'string') accumulator.model = record['model'];
  const message = record['message'];
  if (message && typeof message === 'object') {
    const model = (message as Record<string, unknown>)['model'];
    if (typeof model === 'string') accumulator.model = model;
  }

  for (const block of contentBlocks(event)) {
    if (!block || typeof block !== 'object') continue;
    const content = block as Record<string, unknown>;
    if (content['type'] === 'tool_use' && content['name'] === 'Bash') {
      const input = content['input'];
      const command = input && typeof input === 'object'
        ? (input as Record<string, unknown>)['command']
        : undefined;
      if (typeof command === 'string' && command.startsWith('mainwpcontrol')) {
        try {
          accumulator.invocations.push({
            ...(typeof content['id'] === 'string' ? { toolUseId: content['id'] } : {}),
            command,
            argv: parseShellArgv(command),
          });
        } catch (error) {
          accumulator.invocations.push({
            ...(typeof content['id'] === 'string' ? { toolUseId: content['id'] } : {}),
            command,
            argv: [],
            parseError: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } else if (content['type'] === 'tool_result') {
      accumulator.toolResults.push({
        ...(typeof content['tool_use_id'] === 'string'
          ? { toolUseId: content['tool_use_id'] }
          : {}),
        content: content['content'],
        ...((content['is_error'] === true || content['isError'] === true)
          ? { isError: true }
          : {}),
      });
    } else if (content['type'] === 'text' && typeof content['text'] === 'string') {
      accumulator.finalText = content['text'];
    }
  }

  if (record['type'] === 'result') {
    if (typeof record['result'] === 'string') accumulator.finalText = record['result'];
    if (typeof record['duration_ms'] === 'number') accumulator.durationMs = record['duration_ms'];
    if (typeof record['duration_api_ms'] === 'number') {
      accumulator.durationApiMs = record['duration_api_ms'];
    }
  }
}

function invocationAbility(invocation: RecordedCliInvocation): string | null {
  const [binary, topic, command, ability] = invocation.argv;
  if (
    binary !== 'mainwpcontrol'
    || topic !== 'abilities'
    || command !== 'run'
    || !ability
  ) {
    return null;
  }
  return ability.includes('/') ? ability : `mainwp/${ability}`;
}

function hasFlag(invocation: RecordedCliInvocation, flag: string): boolean {
  return invocation.argv.includes(flag);
}

function invocationInput(invocation: RecordedCliInvocation): Record<string, unknown> | null {
  const index = invocation.argv.findIndex(value => value === '--input' || value === '-i');
  if (index === -1) return {};
  const value = invocation.argv[index + 1];
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function targetMatches(input: Record<string, unknown> | null, truth: AgentGroundTruth): boolean {
  if (!input) return false;
  const target = input['site_id_or_domain'] ?? input['site_id'];
  return (
    (truth.siteId !== undefined && String(target) === String(truth.siteId))
    || (truth.siteUrl !== undefined && String(target) === truth.siteUrl)
    || (truth.targetSiteId !== undefined && String(target) === String(truth.targetSiteId))
    || (truth.targetSiteUrl !== undefined && String(target) === truth.targetSiteUrl)
  );
}

function flattenStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(flattenStrings);
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap(flattenStrings);
  }
  return [];
}

function resultsForInvocations(
  invocations: RecordedCliInvocation[],
  toolResults: RecordedToolResult[],
): RecordedToolResult[] {
  const ids = new Set(
    invocations
      .map(invocation => invocation.toolUseId)
      .filter((value): value is string => Boolean(value)),
  );
  return toolResults.filter(result => Boolean(result.toolUseId && ids.has(result.toolUseId)));
}

function cliResultsMatchTruth(
  truth: AgentGroundTruth,
  toolResults: RecordedToolResult[],
): boolean {
  const text = `${flattenStrings(toolResults).join('\n')}\n${JSON.stringify(toolResults)}`;
  if (truth.count !== undefined) {
    return (
      new RegExp(`"total"\\s*:\\s*${truth.count}(?:\\D|$)`).test(text)
      || new RegExp(`(?:total|sites?(?: connected)?)\\D{0,20}${truth.count}\\b`, 'i').test(text)
    );
  }
  if (truth.updateSiteUrls) {
    if (truth.updateSiteUrls.length === 0) return /\b(no|none|zero|0)\b/i.test(text);
    return truth.updateSiteUrls.every(url => text.includes(url));
  }
  if (truth.pluginActive !== undefined && truth.pluginSlug) {
    const slug = truth.pluginSlug.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    const structured = (
      new RegExp(
        `"slug"\\s*:\\s*"${slug}"[^}]*"active"\\s*:\\s*${truth.pluginActive}`,
      ).test(text)
      || new RegExp(
        `"active"\\s*:\\s*${truth.pluginActive}[^}]*"slug"\\s*:\\s*"${slug}"`,
      ).test(text)
    );
    const status = truth.pluginActive ? /\bactive\b/i : /\binactive\b/i;
    return structured || (text.includes(truth.pluginSlug) && status.test(text));
  }
  return false;
}

function finalAnswerMatches(truth: AgentGroundTruth, text: string): boolean {
  if (truth.count !== undefined) {
    return [...text.matchAll(/\b\d+\b/g)].some(match => Number(match[0]) === truth.count);
  }
  if (truth.updateSiteUrls) {
    if (truth.updateSiteUrls.length === 0) return /\b(no|none|zero|0)\b/i.test(text);
    const hostnameOf = (url: string): string => {
      try {
        return new URL(url).hostname;
      } catch {
        return url;
      }
    };
    const lower = text.toLowerCase();
    return truth.updateSiteUrls.every(url => lower.includes(hostnameOf(url).toLowerCase()));
  }
  if (truth.pluginActive !== undefined) {
    const answer = text.match(/\b(yes|no)\b/i)?.[1]?.toLowerCase();
    return (
      answer === (truth.pluginActive ? 'yes' : 'no')
      && Boolean(truth.siteName && text.toLowerCase().includes(truth.siteName.toLowerCase()))
    );
  }
  return false;
}

function evaluateReadScenario(
  scenario: AgentScenario,
  truth: AgentGroundTruth,
  collected: CollectedAgentOutput,
): AgentEvaluation {
  const appropriate = collected.invocations.filter(invocation => {
    const ability = invocationAbility(invocation);
    return ability !== null && scenario.expectedAbilities.includes(ability);
  });
  const relevantResults = resultsForInvocations(appropriate, collected.toolResults);
  const rightArguments = appropriate.every(invocation => invocationInput(invocation) !== null);
  const hasTargetArgument = (
    truth.siteId === undefined
    || appropriate.some(invocation => targetMatches(invocationInput(invocation), truth))
  );
  // A CLI agent discovers input schemas by trying, so failed intermediate
  // attempts are legitimate; grade the non-error results and the end state.
  const successfulResults = relevantResults.filter(result => !result.isError);
  const lastResult = relevantResults[relevantResults.length - 1];
  const resultsMatch = cliResultsMatchTruth(truth, successfulResults);
  return {
    understoodRequest: {
      pass: collected.finalText.trim().length > 0,
      evidence: collected.finalText,
    },
    rightCapability: {
      pass: appropriate.length > 0,
      evidence: collected.invocations.map(invocation => invocation.argv),
    },
    rightArguments: {
      pass: appropriate.length > 0 && rightArguments && hasTargetArgument,
      evidence: appropriate.map(invocation => invocationInput(invocation)),
    },
    correctCliResult: {
      pass: successfulResults.length > 0 && resultsMatch && lastResult?.isError !== true,
      evidence: {
        resultCount: relevantResults.length,
        errorCount: relevantResults.length - successfulResults.length,
        groundTruthMatched: resultsMatch,
        endedWithError: lastResult?.isError === true,
      },
    },
    stateChange: {
      pass: true,
      evidence: 'Not applicable. This agent scenario is read-only.',
    },
    faithfulFinalAnswer: {
      pass: finalAnswerMatches(truth, collected.finalText),
      evidence: { truth, finalText: collected.finalText },
    },
  };
}

async function evaluateDeleteScenario(
  truth: AgentGroundTruth,
  collected: CollectedAgentOutput,
  verifier: IndependentVerifier,
): Promise<{ evaluation: AgentEvaluation; reason?: string }> {
  if (
    truth.beforeSiteCount === undefined
    || truth.targetSiteId === undefined
    || !truth.targetSiteName
  ) {
    throw new Error('Delete scenario ground truth was incomplete');
  }
  const deleteInvocations = collected.invocations
    .map((invocation, index) => ({ invocation, index }))
    .filter(({ invocation }) => invocationAbility(invocation) === 'mainwp/delete-site-v1');
  const targeting = deleteInvocations.filter(({ invocation }) =>
    targetMatches(invocationInput(invocation), truth));
  const preview = targeting.find(({ invocation }) => hasFlag(invocation, '--dry-run'));
  const confirmed = targeting.find(({ invocation, index }) =>
    Boolean(
      preview
      && index > preview.index
      && hasFlag(invocation, '--confirm')
      && hasFlag(invocation, '--force'),
    ));
  const confirmedResults = confirmed
    ? resultsForInvocations([confirmed.invocation], collected.toolResults)
    : [];
  const after = await verifier.listSites();
  const targetStillPresent = after.some(site => site.id === truth.targetSiteId);
  const finalText = collected.finalText.toLowerCase();
  const transcriptPass = Boolean(preview && confirmed);
  const evaluation: AgentEvaluation = {
    understoodRequest: {
      pass: collected.finalText.trim().length > 0,
      evidence: collected.finalText,
    },
    rightCapability: {
      pass: targeting.length >= 2,
      evidence: deleteInvocations.map(({ invocation }) => invocation.argv),
    },
    rightArguments: {
      pass: transcriptPass,
      evidence: {
        targetSiteId: truth.targetSiteId,
        previewIndex: preview?.index,
        confirmedIndex: confirmed?.index,
      },
    },
    correctCliResult: {
      pass: confirmedResults.length > 0 && confirmedResults.every(result => !result.isError),
      evidence: confirmedResults,
    },
    stateChange: {
      pass: after.length === truth.beforeSiteCount - 1 && !targetStillPresent,
      evidence: {
        beforeCount: truth.beforeSiteCount,
        afterCount: after.length,
        targetStillPresent,
      },
    },
    faithfulFinalAnswer: {
      pass: (
        finalText.includes(truth.targetSiteName.toLowerCase())
        && /\b(deleted|removed)\b/.test(finalText)
      ),
      evidence: collected.finalText,
    },
  };
  return {
    evaluation,
    ...(!preview
      ? { reason: 'No target-matching delete invocation used --dry-run.' }
      : !confirmed
        ? { reason: 'No later target-matching delete invocation used --confirm --force.' }
        : {}),
  };
}

async function runClaude(
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  onLine: (line: string, elapsedMs: number) => void,
): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }> {
  const started = performance.now();
  const executable = argv[0];
  if (!executable) throw new Error('Claude argv did not contain an executable');
  const child = spawn(executable, argv.slice(1), {
    cwd,
    env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let pending = '';
  child.stdout.on('data', chunk => {
    const buffer = Buffer.from(chunk);
    stdoutChunks.push(buffer);
    pending += buffer.toString('utf8');
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) {
      onLine(line, Math.round(performance.now() - started));
    }
  });
  child.stderr.on('data', chunk => stderrChunks.push(Buffer.from(chunk)));
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve(code ?? 1));
  });
  if (pending.length > 0) onLine(pending, Math.round(performance.now() - started));
  return {
    exitCode,
    stdout: Buffer.concat(stdoutChunks).toString('utf8'),
    stderr: Buffer.concat(stderrChunks).toString('utf8'),
    durationMs: Math.round(performance.now() - started),
  };
}

function emptyTiming(): AgentTiming {
  return {
    process_wall_clock_ms: null,
    duration_ms: null,
    duration_api_ms: null,
    ttft_ms: null,
    invocation_count: 0,
  };
}

function timingFrom(
  collected: CollectedAgentOutput,
  processWallClockMs: number,
): AgentTiming {
  return {
    process_wall_clock_ms: processWallClockMs,
    duration_ms: collected.durationMs ?? null,
    duration_api_ms: collected.durationApiMs ?? null,
    ttft_ms: collected.ttftMs ?? null,
    invocation_count: collected.invocations.length,
  };
}

function totals(results: AgentResult[]): Record<AgentStatus, number> {
  return {
    passed: results.filter(result => result.status === 'passed').length,
    failed: results.filter(result => result.status === 'failed').length,
    skipped: results.filter(result => result.status === 'skipped').length,
    unverified: results.filter(result => result.status === 'unverified').length,
  };
}

function resultDocument(
  artifacts: Artifacts,
  options: AgentRunnerOptions,
  results: AgentResult[],
  artifactAudit: AgentResultDocument['artifactAudit'],
  harnessError: string | null,
): AgentResultDocument {
  return {
    runId: artifacts.runId,
    mode: options.mode,
    target: 'live',
    totals: totals(results),
    scenarios: results,
    artifactAudit,
    harnessError,
  };
}

function summaryMarkdown(document: AgentResultDocument): string {
  const timed = document.scenarios.filter(
    result => result.timing.process_wall_clock_ms !== null,
  );
  const slowest = [...timed].sort(
    (left, right) =>
      (right.timing.process_wall_clock_ms ?? 0)
      - (left.timing.process_wall_clock_ms ?? 0),
  )[0];
  const lines = [
    '# MainWP Control agent acceptance results',
    '',
    `- Run: ${document.runId}`,
    `- Mode: ${document.mode}`,
    `- Target: live${(() => {
      const fixtureIds = document.scenarios
        .filter(result => result.target === 'fixture')
        .map(result => result.id);
      return fixtureIds.length > 0 ? ` (fixture Dashboard: ${fixtureIds.join(', ')})` : '';
    })()}`,
    `- Passed: ${document.totals.passed}`,
    `- Failed: ${document.totals.failed}`,
    `- Skipped: ${document.totals.skipped}`,
    `- Unverified: ${document.totals.unverified}`,
    `- Artifact audit: ${document.artifactAudit.passed ? 'passed' : 'failed'} - ${document.artifactAudit.message}`,
    ...(document.harnessError ? [`- Harness error: ${document.harnessError}`] : []),
    ...(slowest
      ? [
          `- Slowest scenario: ${slowest.id} (${slowest.timing.process_wall_clock_ms} ms wall clock)`,
        ]
      : ['- Slowest scenario: unavailable (no Claude process completed)']),
    '',
    '| Scenario | Status | Wall (ms) | Claude duration (ms) | API duration (ms) | TTFT (ms) | CLI calls |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: |',
    ...document.scenarios.map(result => {
      const timing = result.timing;
      return `| ${result.id} | ${result.status} | ${timing.process_wall_clock_ms ?? '-'} | ${timing.duration_ms ?? '-'} | ${timing.duration_api_ms ?? '-'} | ${timing.ttft_ms ?? '-'} | ${timing.invocation_count} |`;
    }),
    '',
    ...document.scenarios
      .filter(result => result.reason)
      .map(result => `- ${result.id}: ${result.reason}`),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function registerAuditValues(
  values: Set<string>,
  credentials: AcceptanceCredentials,
): void {
  values.add(credentials.username);
  values.add(credentials.appPassword);
  values.add(credentials.appPassword.replace(/\s+/g, ''));
  values.add(new URL(credentials.dashboardUrl).origin);
  values.add(
    `Basic ${Buffer.from(`${credentials.username}:${credentials.appPassword}`).toString('base64')}`,
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

async function prepareCli(
  options: AgentRunnerOptions,
  runner: CommandRunner,
  artifacts: Artifacts,
): Promise<PreparedCli> {
  if (options.mode === 'packed') {
    const packedPackage = await packAndInstall(
      repoRoot,
      runner,
      artifacts,
      options.keepConsumer,
    );
    return {
      binDir: path.dirname(packedPackage.binPath),
      cwd: packedPackage.consumerDir,
      packedPackage,
      cleanup: () => packedPackage.cleanup(),
    };
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mainwp-control-agent-source-'));
  const binDir = path.join(tempRoot, 'bin');
  fs.mkdirSync(binDir);
  fs.symlinkSync(path.join(repoRoot, 'bin', 'run.js'), path.join(binDir, 'mainwpcontrol'));
  return {
    binDir,
    cwd: repoRoot,
    packedPackage: null,
    cleanup: () => {
      if (!options.keepConsumer) fs.rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

const agentSystemPrompt = [
  'A MainWP Dashboard is managed exclusively through the mainwpcontrol CLI,',
  'which is on PATH and already configured with credentials.',
  'Use the Bash tool to run explicit mainwpcontrol subcommands with --json output, for example:',
  '`mainwpcontrol abilities list --json` or',
  '`mainwpcontrol abilities run <namespace/name> --input \'<json>\' --json`.',
  'Destructive abilities accept --dry-run to preview and --confirm --force to execute',
  'without an interactive prompt.',
  'Do not attempt to reach the Dashboard any other way.',
].join(' ');

async function runAgentAcceptance(options: AgentRunnerOptions): Promise<number> {
  if (options.help) {
    printHelp();
    return 0;
  }
  if (options.list) {
    for (const scenario of agentScenarios) console.log(scenario.id);
    return 0;
  }

  const scenarios = selectedScenarios(options.scenarioIds);
  const credentials = resolveAcceptanceCredentials();
  const fixtureCredentials: AcceptanceCredentials = {
    dashboardUrl: 'http://127.0.0.1',
    username: FIXTURE_USERNAME,
    appPassword: FIXTURE_APP_PASSWORD,
  };
  const redactor = new Redactor({
    ...credentials,
    authorization: `Basic ${Buffer.from(
      `${credentials.username}:${credentials.appPassword}`,
    ).toString('base64')}`,
  });
  redactor.add({
    ...fixtureCredentials,
    authorization: `Basic ${Buffer.from(
      `${fixtureCredentials.username}:${fixtureCredentials.appPassword}`,
    ).toString('base64')}`,
  });
  const auditValues = new Set<string>();
  registerAuditValues(auditValues, credentials);
  registerAuditValues(auditValues, fixtureCredentials);

  const runner = new CommandRunner();
  const artifacts = await createArtifacts(
    repoRoot,
    redactor,
    runner,
    options.mode,
    'live',
    {
      agent: true,
      writes: options.writes,
      scenarios: options.scenarioIds,
      keepConsumer: options.keepConsumer,
    },
    '-agent',
  );
  const verifier = new IndependentVerifier(credentials, true);
  const results: AgentResult[] = [];
  let preparedCli: PreparedCli | null = null;
  let harnessError: unknown;
  let artifactAudit: AgentResultDocument['artifactAudit'] = {
    passed: true,
    message: 'No registered credential or Dashboard-origin values were found.',
  };

  try {
    preparedCli = await prepareCli(options, runner, artifacts);
    const which = await runner.run(['which', 'claude'], repoRoot, { allowFailure: true });
    const claudeAvailable = which.exitCode === 0;

    for (const scenario of scenarios) {
      let truth: AgentGroundTruth | undefined;
      let configDir: ConfigDir | null = null;
      let mockServer: MockServer | null = null;
      let scenarioVerifier = verifier;
      let scenarioCredentials = credentials;
      let result: AgentResult | undefined;
      try {
        if (scenario.kind === 'write' && scenario.target === 'live') {
          const guardReason = getWriteGuardReason(credentials.dashboardUrl, options.writes, 'live');
          if (guardReason) {
            result = {
              id: scenario.id,
              status: 'skipped',
              target: scenario.target,
              invocations: [],
              finalText: '',
              timing: emptyTiming(),
              reason: guardReason,
            };
            continue;
          }
        }

        if (scenario.target === 'fixture') {
          mockServer = new MockServer();
          await mockServer.start();
          programAgentFixture(mockServer);
          scenarioCredentials = {
            dashboardUrl: mockServer.baseUrl,
            username: FIXTURE_USERNAME,
            appPassword: FIXTURE_APP_PASSWORD,
          };
          scenarioVerifier = new IndependentVerifier(scenarioCredentials, false);
        }

        try {
          truth = await scenario.groundTruth(scenarioVerifier);
        } catch (error) {
          result = {
            id: scenario.id,
            status: 'unverified',
            target: scenario.target,
            invocations: [],
            finalText: '',
            timing: emptyTiming(),
            reason: `Independent verifier precondition failed: ${error instanceof Error ? error.message : String(error)}`,
          };
          continue;
        }

        const task = scenario.task(truth);
        const argv = [
          'claude',
          '-p',
          task,
          '--allowedTools',
          'Bash(mainwpcontrol *)',
          '--disallowedTools',
          'mcp__*',
          '--strict-mcp-config',
          // The child's Bash sandbox would block CLI network access to the
          // Dashboard host, forcing error-and-retry churn on every command.
          '--settings',
          '{"sandbox": {"enabled": false}}',
          '--append-system-prompt',
          agentSystemPrompt,
          '--output-format',
          'stream-json',
          '--verbose',
          '--max-turns',
          '20',
        ];
        if (!claudeAvailable) {
          result = {
            id: scenario.id,
            status: 'unverified',
            target: scenario.target,
            invocations: [],
            finalText: '',
            timing: emptyTiming(),
            groundTruth: truth,
            reason: `Blocked command: ${shellDisplay(argv)}. The claude CLI was not found.`,
          };
          continue;
        }

        const insecureHttp = new URL(scenarioCredentials.dashboardUrl).protocol === 'http:';
        configDir = await ConfigDir.create({
          profiles: [{
            name: 'acceptance',
            dashboardUrl: scenarioCredentials.dashboardUrl,
            username: scenarioCredentials.username,
            ...(scenario.target === 'live' ? { skipSSLVerification: true } : {}),
          }],
          activeProfile: 'acceptance',
          ...(insecureHttp ? { settings: { allowInsecureHttp: true } } : {}),
        });
        const collected: CollectedAgentOutput = {
          invocations: [],
          toolResults: [],
          finalText: '',
        };
        const command = await runClaude(
          argv,
          preparedCli.cwd,
          {
            ...process.env,
            PATH: `${preparedCli.binDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
            XDG_CONFIG_HOME: configDir.xdgHome,
            MAINWPCONTROL_NO_KEYTAR: '1',
            MAINWP_APP_PASSWORD: scenarioCredentials.appPassword,
            ...(insecureHttp ? { MAINWP_ALLOW_HTTP: '1' } : {}),
          },
          (line, elapsedMs) => {
            artifacts.appendJsonLine('agent-transcript.jsonl', {
              scenario: scenario.id,
              line,
            });
            try {
              collectEvent(JSON.parse(line) as unknown, collected, elapsedMs);
            } catch {
              // The raw line is already preserved in the redacted transcript.
            }
          },
        );
        runner.record({
          argv,
          cwd: preparedCli.cwd,
          exitCode: command.exitCode,
          durationMs: command.durationMs,
          stdoutTail: command.stdout.slice(-12_000),
          stderrTail: command.stderr.slice(-12_000),
        });
        const timing = timingFrom(collected, command.durationMs);
        if (command.exitCode !== 0) {
          result = {
            id: scenario.id,
            status: 'unverified',
            target: scenario.target,
            ...(collected.model ? { model: collected.model } : {}),
            invocations: collected.invocations,
            finalText: collected.finalText,
            timing,
            groundTruth: truth,
            reason: `Blocked command: ${shellDisplay(argv)}. Exit ${command.exitCode}: ${command.stderr.slice(-2000)}`,
          };
          continue;
        }

        const evaluated = scenario.evaluate
          ? await scenario.evaluate(truth, collected, scenarioVerifier)
          : { evaluation: evaluateReadScenario(scenario, truth, collected) };
        const passed = Object.values(evaluated.evaluation).every(field => field.pass);
        result = {
          id: scenario.id,
          status: passed ? 'passed' : 'failed',
          target: scenario.target,
          ...(collected.model ? { model: collected.model } : {}),
          invocations: collected.invocations,
          finalText: collected.finalText,
          timing,
          groundTruth: truth,
          evaluation: evaluated.evaluation,
          ...(!passed && evaluated.reason ? { reason: evaluated.reason } : {}),
        };
      } catch (error) {
        result = {
          id: scenario.id,
          status: 'failed',
          target: scenario.target,
          invocations: [],
          finalText: '',
          timing: emptyTiming(),
          ...(truth ? { groundTruth: truth } : {}),
          reason: error instanceof Error ? error.message : String(error),
        };
      } finally {
        await configDir?.cleanup().catch(error => {
          result = {
            ...(result ?? {
              id: scenario.id,
              target: scenario.target,
              invocations: [],
              finalText: '',
              timing: emptyTiming(),
            }),
            status: 'failed',
            reason: `Config cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        });
        if (scenarioVerifier !== verifier) {
          await scenarioVerifier.close().catch(() => {});
        }
        if (mockServer) {
          await mockServer.stop().catch(() => {});
        }
        if (result) {
          results.push(result);
          const document = resultDocument(
            artifacts,
            options,
            results,
            artifactAudit,
            null,
          );
          artifacts.writeJson('results.json', document);
          artifacts.write('summary.md', summaryMarkdown(document));
        }
      }
    }
  } catch (error) {
    harnessError = error;
  } finally {
    preparedCli?.cleanup();
    await verifier.close().catch(error => {
      harnessError ??= error;
    });
  }

  const initialFindings = auditArtifacts(artifacts.runDir, auditValues);
  if (initialFindings.length > 0) {
    artifactAudit = {
      passed: false,
      message: `Sensitive values were found in: ${initialFindings.join(', ')}`,
    };
  }
  const harnessMessage = harnessError instanceof Error
    ? harnessError.message
    : harnessError === undefined
      ? null
      : String(harnessError);
  const document = resultDocument(
    artifacts,
    options,
    results,
    artifactAudit,
    harnessMessage,
  );
  artifacts.writeJson('results.json', document);
  artifacts.write('summary.md', summaryMarkdown(document));
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
    artifacts.write('summary.md', summaryMarkdown(failedAuditDocument));
    artifacts.finish();
  }

  for (const result of results) console.log(`${result.status.toUpperCase()} ${result.id}`);
  console.log(`Agent acceptance artifacts: ${artifacts.runDir}`);
  if (harnessError) console.error(redactor.redact(harnessMessage ?? 'Agent harness failed'));
  return (
    harnessError
    || results.some(result => result.status === 'failed')
    || !artifactAudit.passed
  ) ? 1 : 0;
}

try {
  process.exitCode = await runAgentAcceptance(parseArgs(process.argv.slice(2)));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
