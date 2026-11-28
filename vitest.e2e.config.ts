import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['tests/e2e/helpers/setupDeterministic.ts'],
    testTimeout: 15000,
  },
});
