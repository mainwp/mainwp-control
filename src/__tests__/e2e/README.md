# E2E Integration Tests

End-to-end integration tests that verify complete CLI workflows from command initialization through output.

## Purpose

**E2E tests** differ from unit tests in scope and intent:

| Aspect | Unit Tests | E2E Tests |
|--------|------------|-----------|
| **Scope** | Single function/class | Complete workflow |
| **Dependencies** | Mocked at boundaries | Mocked at external layer |
| **Focus** | Implementation correctness | User-facing behavior |
| **Speed** | Very fast | Fast (no real I/O) |
| **Isolation** | Complete | Workflow-level |

E2E tests verify that components work together correctly: commands load profiles, create executors, make HTTP calls, handle responses, and format output.

## Running Tests

```bash
# Run all E2E tests
npm test src/__tests__/e2e

# Run a specific test file
npm test src/__tests__/e2e/login-abilities-flow.test.ts

# Run with verbose output
npm test src/__tests__/e2e -- --reporter=verbose

# Run with coverage
npm test src/__tests__/e2e -- --coverage
```

## Test Files

| File | Coverage |
|------|----------|
| `login-abilities-flow.test.ts` | Login, profile storage, abilities listing |
| `chat-destructive-flow.test.ts` | Chat engine, destructive action preview/approval |
| `batch-polling-flow.test.ts` | Batch job submission, polling, timeout handling |
| `test-helpers.ts` | Shared utilities and mock factories |

## Mocking Strategy

E2E tests mock at the external boundary layer:

```
┌─────────────────────────────────────────────────┐
│                   Test Code                      │
└─────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│    Commands / Chat Engine / Batch Manager        │
│         (Real implementation tested)             │
└─────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│              External Boundaries                 │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌────────┐ │
│  │ HTTP    │ │ File    │ │ Keytar  │ │Readline│ │
│  │ Client  │ │ System  │ │         │ │        │ │
│  │ (mock)  │ │ (mock)  │ │ (mock)  │ │ (mock) │ │
│  └─────────┘ └─────────┘ └─────────┘ └────────┘ │
└─────────────────────────────────────────────────┘
```

### Module-Level Mocks

Vitest requires mocks to be declared before imports:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Module-level mocks MUST come before imports
vi.mock('node:fs', () => ({
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
  },
}));

vi.mock('keytar', () => ({
  setPassword: vi.fn(),
  getPassword: vi.fn(),
  deletePassword: vi.fn(),
}));

// Now import the modules under test
import { ProfileStore } from '../../../config/profile-store.js';
```

## Singleton Management

ProfileStore and Keychain use singleton patterns. Tests must create fresh instances to avoid state pollution:

```typescript
import { ProfileStore } from '../../../config/profile-store.js';

describe('My test', () => {
  let profileStore: ProfileStore;

  beforeEach(() => {
    vi.clearAllMocks();
    // Create fresh instance for each test
    profileStore = new ProfileStore('/mock/config/path');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });
});
```

### Reset Pattern

Each test file should:

1. Clear all mocks in `beforeEach`
2. Create fresh instances of singletons
3. Clear mocks again in `afterEach`

```typescript
beforeEach(() => {
  vi.clearAllMocks();
  // Reset mock implementations to defaults
  mockFsReadFile.mockResolvedValue(JSON.stringify({
    activeProfile: 'default',
    profiles: [createMockProfile()],
  }));
});

afterEach(() => {
  vi.clearAllMocks();
  restoreEnvVars(); // Restore any modified env vars
});
```

## Environment Variables

Use the helpers from `test-helpers.ts`:

```typescript
import { setEnvVar, clearEnvVar, restoreEnvVars, withEnvVar } from './test-helpers.js';

// Set for duration of test
setEnvVar('MAINWP_APP_PASSWORD', 'test-password');

// Clear a variable
clearEnvVar('OPENAI_API_KEY');

// Restore all modified variables
restoreEnvVars();

// Run function with temporary env var
await withEnvVar('DEBUG', 'true', async () => {
  // Variable is set here
  await doSomething();
});
// Variable is restored after
```

## Mocking Interactive Input (Readline)

For testing commands that prompt for user input:

```typescript
import { createMockReadlineInterface } from './test-helpers.js';

// Create mock with queued responses
const mockRl = createMockReadlineInterface([
  'https://dashboard.example.com',  // First prompt
  'admin',                           // Second prompt
  'password123',                     // Third prompt
]);

// Mock readline module
vi.mock('node:readline', () => ({
  createInterface: vi.fn(() => mockRl),
}));

// Test will receive responses in order
```

## Mocking LLM Providers

For chat engine tests with sequential LLM responses:

```typescript
import { createMockProvider, createMockLLMToolCallResponse, createMockLLMAnswerResponse } from './test-helpers.js';

// Create provider with response queue
const mockProvider = createMockProvider([
  // First call: LLM requests a tool call
  createMockLLMToolCallResponse('mainwp/list-sites-v1', {}),
  // Second call: LLM provides final answer
  createMockLLMAnswerResponse('Found 5 sites connected to your dashboard.'),
]);

// Provider returns responses in sequence
const engine = createChatEngine({
  provider: mockProvider,
  executor: mockExecutor,
});
```

## Mock Factories

Use factories from `test-helpers.ts` for consistent test data:

```typescript
import {
  createMockProfile,
  createMockAbility,
  createMockHttpResponse,
  createMockJobStatus,
  createMockExecutor,
  createSuccessResult,
  createErrorResult,
  STANDARD_ABILITIES,
} from './test-helpers.js';

// Create profile with overrides
const profile = createMockProfile({
  name: 'production',
  dashboardUrl: 'https://prod.example.com',
});

// Create ability with annotations
const deleteAbility = createMockAbility('delete-site-v1', {
  destructive: true,
});

// Use standard abilities
const abilities = [
  STANDARD_ABILITIES.listSites,
  STANDARD_ABILITIES.deleteSite,
];

// Create mock executor
const executor = createMockExecutor({
  abilities,
  executeHandler: (name, input, options) => {
    if (options?.dryRun) {
      return createSuccessResult({ affected: [{ id: 1 }] });
    }
    return createSuccessResult({ deleted: true });
  },
});
```

## Testing Destructive Actions

Destructive actions require the preview-then-confirm flow:

```typescript
it('requires preview before execution', async () => {
  // 1. LLM requests destructive action
  const toolCallResponse = createMockLLMToolCallResponse(
    'mainwp/delete-site-v1',
    { site_id: 1 }
  );

  // 2. Executor returns preview with dry_run
  mockExecutor.execute.mockResolvedValue(
    createSuccessResult({ affected: [{ id: 1, name: 'Example Site' }] })
  );

  // 3. Process message
  const result = await engine.processMessage('delete site 1');

  // 4. Verify dry_run was used
  expect(mockExecutor.execute).toHaveBeenCalledWith(
    'mainwp/delete-site-v1',
    expect.objectContaining({ site_id: 1 }),
    expect.objectContaining({ dryRun: true })
  );

  // 5. Verify preview is pending
  expect(engine.hasPendingPreview()).toBe(true);
});
```

## Testing Batch Operations

For polling and timeout scenarios:

```typescript
it('surfaces partial results on timeout', async () => {
  let pollCount = 0;

  mockHttpPost.mockImplementation(async () => {
    pollCount++;
    return {
      data: {
        job_id: 'job_123',
        status: 'running',
        progress: pollCount * 25,
        total: 10,
        processed: pollCount * 2,
        results: Array.from({ length: pollCount * 2 }, (_, i) => ({
          site_id: i + 1,
          synced: true,
        })),
      },
    };
  });

  const result = await batchManager.pollJobStatus('job_123', {
    maxWait: 100,      // Short timeout
    pollInterval: 20,   // Fast polling
  });

  expect(result.timedOut).toBe(true);
  expect(result.status).toBe('partial');
  expect(result.results.length).toBeGreaterThan(0);
});
```

## Common Pitfalls

### 1. Forgetting to Reset Mocks

```typescript
// ❌ Bad: Mocks accumulate state
it('first test', () => {
  mockFn.mockReturnValue('a');
  // ...
});

it('second test', () => {
  // mockFn still returns 'a'!
});

// ✅ Good: Reset in beforeEach
beforeEach(() => {
  vi.clearAllMocks();
});
```

### 2. Async Mock Implementation

```typescript
// ❌ Bad: Synchronous mock for async function
mockFn.mockReturnValue(data);

// ✅ Good: Use async mock
mockFn.mockResolvedValue(data);

// ✅ Or for rejections
mockFn.mockRejectedValue(new Error('Failed'));
```

### 3. Module Import Order

```typescript
// ❌ Bad: Import before mock
import { ProfileStore } from './profile-store.js';

vi.mock('node:fs', /* ... */);

// ✅ Good: Mock before import
vi.mock('node:fs', /* ... */);

import { ProfileStore } from './profile-store.js';
```

### 4. Singleton State Leakage

```typescript
// ❌ Bad: Reusing singleton across tests
const store = ProfileStore.getInstance();

// ✅ Good: Create fresh instance
let store: ProfileStore;
beforeEach(() => {
  store = new ProfileStore('/mock/path');
});
```

### 5. Missing Await on Async Operations

```typescript
// ❌ Bad: Missing await
it('async test', () => {
  const result = engine.processMessage('hello');
  expect(result).toBeDefined(); // result is a Promise!
});

// ✅ Good: Await the operation
it('async test', async () => {
  const result = await engine.processMessage('hello');
  expect(result).toBeDefined();
});
```

## Debugging Tips

### View Mock Calls

```typescript
// See all calls to a mock
console.log(mockFn.mock.calls);

// See specific call arguments
console.log(mockFn.mock.calls[0]); // First call args

// Check call count
expect(mockFn).toHaveBeenCalledTimes(2);
```

### Verbose Test Output

```bash
# Run with detailed output
npm test src/__tests__/e2e -- --reporter=verbose

# Run single test with name filter
npm test src/__tests__/e2e -- -t "successful login"
```

### Extended Timeouts

For slow tests (polling, retries):

```typescript
it('handles long operation', { timeout: 10000 }, async () => {
  // Test with 10-second timeout
});
```

### Inspect Mock Implementation

```typescript
// Log when mock is called
mockFn.mockImplementation((...args) => {
  console.log('Mock called with:', args);
  return { success: true };
});
```
