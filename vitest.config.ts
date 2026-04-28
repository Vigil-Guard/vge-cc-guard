import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 15000,
    hookTimeout: 15000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**'],
      exclude: [
        'src/shared/types.ts',          // pure TS interfaces, no executable statements
        'src/shared/ipc-protocol.ts',   // pure TS interfaces, no executable statements
        'src/commands/daemon.ts',       // 4-line wrapper; covered by manual smoke test
      ],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
});
