import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.ts'],
    testTimeout: 20000,
    hookTimeout: 20000,
    // Integration tests share one Postgres connection pool and must not
    // run their transactions concurrently against the same fixture data.
    fileParallelism: false,
  },
});
