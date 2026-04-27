import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**'],
      exclude: [
        'src/cli.ts',                   // stub dispatcher — integration tests in Sprint 3
        'src/shared/types.ts',          // pure TS interfaces, no executable statements
        'src/shared/ipc-protocol.ts',   // pure TS interfaces, no executable statements
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
