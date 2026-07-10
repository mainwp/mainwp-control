/**
 * E2E Test Helpers
 *
 * Shared utilities for integration tests.
 * Provides singleton reset functions, mock factories, and assertion helpers.
 */

import { vi } from 'vitest';
import type { Command } from '@oclif/core';
import type { Ability, ExecutionResult } from '../../core/abilities-executor.js';
import type { JobStatus } from '../../core/batch-manager.js';
import type { LLMProvider, LLMResponse, Message, ChatOptions } from '../../chat/providers/provider.js';

// ============================================================================
// Types
// ============================================================================

export interface MockProfile {
  name: string;
  dashboardUrl: string;
  username: string;
  skipSSLVerification?: boolean;
  createdAt: string;
  lastUsedAt?: string;
}

export interface MockProfilesFile {
  activeProfile?: string;
  profiles: MockProfile[];
}

export interface MockHttpClient {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
}

export interface MockReadlineInterface {
  question: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

// ============================================================================
// Mock Factories
// ============================================================================

/**
 * Create a mock profile with sensible defaults
 */
export function createMockProfile(overrides: Partial<MockProfile> = {}): MockProfile {
  return {
    name: 'test-dashboard',
    dashboardUrl: 'https://dashboard.test',
    username: 'admin',
    skipSSLVerification: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Create a mock profiles file
 */
export function createMockProfilesFile(
  profiles: MockProfile[] = [createMockProfile()],
  activeProfile?: string
): MockProfilesFile {
  return {
    activeProfile: activeProfile ?? profiles[0]?.name,
    profiles,
  };
}

/**
 * Create a mock ability definition
 */
export function createMockAbility(
  name: string,
  annotations: { readonly?: boolean; destructive?: boolean; idempotent?: boolean } = {},
  inputSchema?: Record<string, unknown>
): Ability {
  const shortName = name.replace(/^mainwp\//, '');
  return {
    name: `mainwp/${shortName}`,
    label: shortName.replace(/-/g, ' ').replace(/v1$/, '').trim(),
    description: `Test ability: ${shortName}`,
    category: 'test',
    input_schema: inputSchema ?? { type: 'object', properties: {} },
    meta: {
      annotations: {
        readonly: annotations.readonly ?? false,
        destructive: annotations.destructive ?? false,
        idempotent: annotations.idempotent ?? false,
      },
    },
  };
}

/**
 * Create a mock HTTP response
 */
export function createMockHttpResponse<T = unknown>(
  status: number,
  data: T
): { status: number; data: T } {
  return { status, data };
}

/**
 * Create a mock job status
 */
export function createMockJobStatus(overrides: Partial<JobStatus> = {}): JobStatus {
  return {
    id: 'job_test123',
    status: 'pending',
    progress: 0,
    total: 10,
    processed: 0,
    results: undefined,
    errors: undefined,
    created_at: undefined,
    completed_at: undefined,
    ...overrides,
  };
}

/**
 * Create a mock LLM response with a tool call
 */
export function createMockLLMToolCallResponse(
  toolName: string,
  input: Record<string, unknown>,
  id = 'call_1'
): LLMResponse {
  return {
    content: '',
    toolCalls: [{ id, name: toolName, arguments: input }],
    finishReason: 'tool_calls',
    model: 'test-model',
  };
}

/**
 * Create a mock LLM response with a JSON answer
 */
export function createMockLLMAnswerResponse(answer: string): LLMResponse {
  return {
    content: JSON.stringify({ answer }),
    finishReason: 'stop',
    model: 'test-model',
  };
}

/**
 * Create a mock LLM provider that returns predefined responses in sequence
 */
export function createMockProvider(responses: LLMResponse[]): LLMProvider {
  let callIndex = 0;
  return {
    name: 'mock-provider',
    capabilities: {
      functionCalling: true,
      streaming: false,
      systemMessages: true,
      vision: false,
      maxContextLength: 4096,
    },
    chat: vi.fn(async (_messages: Message[], _options?: ChatOptions): Promise<LLMResponse> => {
      const response = responses[callIndex];
      if (!response) {
        throw new Error(`No more mock responses (called ${callIndex + 1} times, only ${responses.length} provided)`);
      }
      callIndex++;
      return response;
    }),
    isConfigured: () => true,
    getModels: () => ['test-model'],
    getDefaultModel: () => 'test-model',
  };
}

/**
 * Create an execution result for success
 */
export function createSuccessResult<T = unknown>(data: T): ExecutionResult<T> {
  return { success: true, data };
}

/**
 * Create an execution result for error
 */
export function createErrorResult(code: string, message: string): ExecutionResult {
  return { success: false, error: { code, message } };
}

/**
 * Create a preview result for destructive actions
 */
export function createPreviewResult(affected: unknown[]): ExecutionResult {
  return { success: true, data: { affected } };
}

/**
 * Create a mock HTTP client
 */
export function createMockHttpClient(): MockHttpClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
    put: vi.fn(),
  };
}

/**
 * Create a mock readline interface with response queue
 */
export function createMockReadlineInterface(responses: string[] = []): MockReadlineInterface {
  const responseQueue = [...responses];
  return {
    question: vi.fn((prompt: string, callback: (answer: string) => void) => {
      const response = responseQueue.shift() ?? '';
      // Use setImmediate to simulate async behavior
      setImmediate(() => callback(response));
    }),
    on: vi.fn((_event: string, _callback: () => void) => {
      // No-op for tests
      return { on: vi.fn(), close: vi.fn() };
    }),
    close: vi.fn(),
  };
}

// ============================================================================
// Command Harness Factory
// ============================================================================

/**
 * Output captured from a mocked command run
 */
export interface CapturedOutput {
  stdout: string[];
  stderr: string[];
  exitCode?: number;
}

/**
 * Create a command instance with a mocked oclif Config and captured
 * log/logToStderr/exit/error output. Shared by the e2e command-harness
 * factories, which layer command-specific `parse` wiring on top.
 */
export function createCommandHarness<T extends Command>(
  CommandClass: new (argv: string[], config: unknown) => T,
  argv: string[] = []
): { command: T; output: CapturedOutput } {
  const output: CapturedOutput = { stdout: [], stderr: [] };

  const mockConfig = {
    root: '/mock/root',
    bin: 'mainwpcontrol',
    name: 'mainwpcontrol',
    version: '1.0.0',
    pjson: { name: 'mainwpcontrol', version: '1.0.0' },
    dataDir: '/mock/data',
    cacheDir: '/mock/cache',
    configDir: '/mock/config',
    findCommand: vi.fn(),
    runCommand: vi.fn(),
    runHook: vi.fn(),
  };

  const command = new CommandClass(argv, mockConfig as never);

  command.log = vi.fn((...args: unknown[]) => {
    output.stdout.push(args.map(String).join(' '));
  });
  command.logToStderr = vi.fn((...args: unknown[]) => {
    output.stderr.push(args.map(String).join(' '));
  });
  command.exit = vi.fn((code?: number) => {
    output.exitCode = code ?? 0;
    throw new Error(`EXIT:${code ?? 0}`);
  }) as never;
  command.error = vi.fn((message: string | Error, options?: { exit?: number }) => {
    output.stderr.push(message instanceof Error ? message.message : message);
    output.exitCode = options?.exit ?? 1;
    throw new Error(`EXIT:${output.exitCode}`);
  }) as never;

  return { command, output };
}

// ============================================================================
// Mock Executor Factory
// ============================================================================

export interface MockExecutorConfig {
  abilities: Ability[];
  executeHandler?: (
    name: string,
    input: Record<string, unknown>,
    options?: { dryRun?: boolean; confirm?: boolean }
  ) => ExecutionResult;
}

/**
 * Create a mock abilities executor
 */
export function createMockExecutor(config: MockExecutorConfig): {
  listAbilities: ReturnType<typeof vi.fn>;
  getAbility: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
  getCategories: ReturnType<typeof vi.fn>;
  listByCategory: ReturnType<typeof vi.fn>;
  clearCache: ReturnType<typeof vi.fn>;
} {
  const { abilities, executeHandler } = config;
  const abilityMap = new Map<string, Ability>();

  // Store by both full and short name
  for (const ability of abilities) {
    abilityMap.set(ability.name, ability);
    const shortName = ability.name.replace(/^mainwp\//, '');
    abilityMap.set(shortName, ability);
  }

  return {
    listAbilities: vi.fn(async () => abilities),
    getAbility: vi.fn(async (name: string) => abilityMap.get(name)),
    execute: vi.fn(async (name: string, input: Record<string, unknown>, options?: { dryRun?: boolean; confirm?: boolean }) => {
      if (executeHandler) {
        return executeHandler(name, input, options);
      }
      return createSuccessResult({ executed: true });
    }),
    getCategories: vi.fn(async () => [...new Set(abilities.map((a) => a.category))]),
    listByCategory: vi.fn(async (category: string) => abilities.filter((a) => a.category === category)),
    clearCache: vi.fn(),
  };
}

// ============================================================================
// Environment Variable Helpers
// ============================================================================

const originalEnv: Record<string, string | undefined> = {};

/**
 * Set an environment variable for testing (saves original value)
 */
export function setEnvVar(key: string, value: string): void {
  if (!(key in originalEnv)) {
    originalEnv[key] = process.env[key];
  }
  process.env[key] = value;
}

/**
 * Clear an environment variable (saves original value)
 */
export function clearEnvVar(key: string): void {
  if (!(key in originalEnv)) {
    originalEnv[key] = process.env[key];
  }
  delete process.env[key];
}

/**
 * Restore all modified environment variables
 */
export function restoreEnvVars(): void {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  // Clear the tracking object
  for (const key of Object.keys(originalEnv)) {
    delete originalEnv[key];
  }
}

/**
 * Run a function with a temporary environment variable
 */
export async function withEnvVar<T>(
  key: string,
  value: string,
  fn: () => Promise<T>
): Promise<T> {
  setEnvVar(key, value);
  try {
    return await fn();
  } finally {
    restoreEnvVars();
  }
}

// ============================================================================
// Standard Test Abilities
// ============================================================================

export const STANDARD_ABILITIES = {
  listSites: createMockAbility('list-sites-v1', { readonly: true }),
  deleteSite: createMockAbility('delete-site-v1', { destructive: true }, {
    type: 'object',
    properties: {
      site_id: { type: 'integer', description: 'Site ID' },
    },
    required: ['site_id'],
  }),
  updateSite: createMockAbility('update-site-v1', { destructive: false }),
  syncSites: createMockAbility('sync-sites-v1', { destructive: false }, {
    type: 'object',
    properties: {
      site_ids: { type: 'array', items: { type: 'integer' } },
    },
  }),
};

// ============================================================================
// Assertion Helpers
// ============================================================================

/**
 * Assert that output is a success JSON envelope
 */
export function expectSuccessOutput(output: unknown): void {
  expect(output).toMatchObject({
    success: true,
    data: expect.anything(),
  });
}

/**
 * Assert that output is an error JSON envelope
 */
export function expectErrorOutput(output: unknown, expectedCode?: string): void {
  expect(output).toMatchObject({
    success: false,
    error: expect.objectContaining({
      code: expectedCode ? expectedCode : expect.any(String),
    }),
  });
}

// ============================================================================
// Vitest Setup Utilities
// ============================================================================

/**
 * Common beforeEach setup for E2E tests
 */
export function setupE2ETest(): void {
  // Clear all mocks between tests
  vi.clearAllMocks();
}

/**
 * Common afterEach cleanup for E2E tests
 */
export function cleanupE2ETest(): void {
  // Restore environment variables
  restoreEnvVars();
  // Clear all mocks
  vi.clearAllMocks();
}
