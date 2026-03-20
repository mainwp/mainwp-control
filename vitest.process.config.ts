import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/process/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
