import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/process/**/*.test.ts'],
    exclude: [
      'src/__tests__/process/live-api.test.ts',
      'src/__tests__/process/live-workflow-docs.test.ts',
    ],
    // Windows child boot can exceed 15s cold; see cli-runner DEFAULT_TIMEOUT
    testTimeout: process.platform === 'win32' ? 90_000 : 30_000,
    hookTimeout: 30_000,
  },
});
