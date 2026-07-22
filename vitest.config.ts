import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: [
      'src/__tests__/process/live-api.test.ts',
      'src/__tests__/process/live-workflow-docs.test.ts',
    ],
    // Process tests spawn CLI as child process; Windows CI needs extra time
    // (child boot can exceed 15s cold there, see cli-runner DEFAULT_TIMEOUT)
    testTimeout: process.platform === 'win32' ? 90_000 : 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts'],
    },
  },
});
