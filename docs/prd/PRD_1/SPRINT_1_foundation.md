# SPRINT 1 — Foundation

**Status:** Ready to execute  
**Duration:** 2–3 days  
**Predecessor:** none (first sprint)  
**Unlocks:** Sprint 2 (daemon core depends on shared schema and IPC contract)

---

## Objective

Create a working project skeleton: the repo compiles, tests run, CI is green, and the three shared modules (`config-schema`, `types`, `ipc-protocol`) are fully defined. No runtime logic yet — this sprint is purely infrastructure and contracts.

At the end of Sprint 1 you can run:

```bash
pnpm build      # exits 0, produces dist/
pnpm test       # exits 0, all smoke tests pass
pnpm lint       # exits 0
pnpm typecheck  # exits 0
```

> **Tooling decision:** this project uses **pnpm** (consistent with the VGE monorepo). Use `pnpm add <pkg>` to add dependencies, `pnpm add -D <pkg>` for dev dependencies, and `pnpm install --frozen-lockfile` in CI. Never use `npm install` — it creates a `package-lock.json` which conflicts with `pnpm-lock.yaml`.

---

## Prerequisites

Before you write a single line of code, read these in full:

| Document | Why |
|---|---|
| [PRD_1.md §5.1](./PRD_1.md#51-configuration-file-schema) | Config file schema — this is the Zod source of truth |
| [PRD_1.md §4.3](./PRD_1.md#43-sidecar-internal-architecture) | Component diagram — shows every module you'll be building across sprints |
| [PRD_1.md §13 Steps 0–2](./PRD_1.md#13-execution-plan) | Execution plan for these three steps |
| [CONFIG_DESIGN.md §1–2](../../CONFIG_DESIGN.md) | Install flow — needed to understand `vge-cc-guard install` command shape |
| VGE `packages/shared/src/schemas/index.ts` | GuardResponse type and VGE payload constraints |

---

## Step 0 — Repo rename (manual, ~10 min)

> **Run these commands yourself before coding.** They cannot be run from inside a Claude Code session.

```bash
# 1. Rename on GitHub
gh repo rename vge-cc-guard   # run from inside the repo directory

# 2. Update the local remote URL
git remote set-url origin git@github.com:Vigil-Guard/vge-cc-guard.git

# 3. Verify
git remote -v
# should show: origin  git@github.com:Vigil-Guard/vge-cc-guard.git

# 4. Archive Phase 0 artefacts (keep but separate from new code)
mkdir -p vg-cc-legacy
git mv vg-cc/hooks vg-cc-legacy/hooks
git commit -m "chore: archive Phase 0 hook artefacts to vg-cc-legacy"
```

**Verify:** `pwd` shows `.../vge-cc-guard` and `git remote -v` points at the renamed origin.

---

## Step 1 — Project scaffold

### 1.1 Create `package.json`

```json
{
  "name": "vge-cc-guard",
  "version": "0.1.0",
  "description": "Security sidecar for Claude Code — gates tool calls, scans outputs via VGE",
  "type": "module",
  "engines": {
    "node": ">=24.13.0 <25"
  },
  "bin": {
    "vge-cc-guard": "./dist/cli.js"
  },
  "main": "./dist/cli.js",
  "files": [
    "dist/",
    "config/"
  ],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "postbuild": "chmod +x dist/cli.js",
    "build:watch": "tsc -p tsconfig.json --watch",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "lint": "eslint src tests",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^24",
    "@typescript-eslint/eslint-plugin": "^8",
    "@typescript-eslint/parser": "^8",
    "eslint": "^9",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8",
    "@vitest/coverage-v8": "^2.1.8"
  }
}
```

> **Reference:** VGE uses `"node": ">=24.13.0 <25"` (`/Users/tomaszbartel/Development/Vigil-Guard-Enterprise/package.json`). Match exactly — `">=24.0.0"` is too broad and allows future major versions.
>
> `postbuild` runs automatically after `build` and marks `dist/cli.js` executable. Without it, global installs (`pnpm add -g`) on Linux produce a non-executable binary (the shebang alone is insufficient on some shells).

### 1.2 Create `tsconfig.json`

> **Reference:** Pattern taken from VGE `packages/shared/tsconfig.json` — strict mode, ES2022, NodeNext modules.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests", "vitest.config.ts"]
}
```

### 1.3 Create `vitest.config.ts`

> **Reference:** Pattern taken from VGE `packages/shared/vitest.config.ts` — identical structure.

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
});
```

### 1.4 Create `eslint.config.js`

```javascript
import tseslint from '@typescript-eslint/eslint-plugin';
import parser from '@typescript-eslint/parser';

export default [
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: { parser },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
];
```

### 1.5 Create `.gitignore`

```
node_modules/
dist/
*.tsbuildinfo
coverage/
*.log
.DS_Store
# The user's runtime data directory (~/.vge-cc-guard/) cannot be gitignored
# via a ~ path — git does not expand tildes in .gitignore. It lives outside
# the repo anyway; this comment is a reminder not to add it as a submodule.
pnpm-debug.log*
```

### 1.6 Create `src/cli.ts` (skeleton only)

This is a dispatcher — it reads `process.argv[2]` and routes to subcommands. Each subcommand is a stub that prints "not yet implemented" and exits 0.

```typescript
#!/usr/bin/env node

const command = process.argv[2];

const usage = `
vge-cc-guard <command>

Commands:
  install        Register hooks in Claude Code settings
  uninstall      Remove hooks and delete ~/.vge-cc-guard/
  config         Open TUI configurator
  hook <event>   Handle a Claude Code hook event (called by CC, not the user)
  daemon         Start the daemon in foreground (development)
  reset-session  Clear allowlist and pending escalations for active session
`.trim();

switch (command) {
  case 'install':
  case 'uninstall':
  case 'config':
  case 'hook':
  case 'daemon':
  case 'reset-session':
    console.log(`[stub] ${command} — not yet implemented`);
    break;
  default:
    console.log(usage);
    process.exit(command === '--help' || command === '-h' ? 0 : 1);
}
```

> **Important:** add the shebang line (`#!/usr/bin/env node`) — it is required for the `bin` entry to work. The `postbuild` script in `package.json` runs `chmod +x dist/cli.js` automatically after every build, making the binary executable on Linux/macOS.

### 1.7 Create directory structure

Run these `mkdir` commands to pre-create all Sprint 1–4 directories at once:

```bash
mkdir -p src/commands
mkdir -p src/shim
mkdir -p src/daemon
mkdir -p src/shared
mkdir -p src/tui/screens
mkdir -p config
mkdir -p tests/unit
mkdir -p tests/integration
mkdir -p .github/workflows
```

### 1.8 Create a smoke test to verify the scaffold

`tests/unit/cli-smoke.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

describe('project scaffold', () => {
  it('package name is correct', async () => {
    const pkg = await import('../../package.json', { assert: { type: 'json' } });
    expect(pkg.default.name).toBe('vge-cc-guard');
  });

  it('bin entry points to cli.js', async () => {
    const pkg = await import('../../package.json', { assert: { type: 'json' } });
    expect(pkg.default.bin['vge-cc-guard']).toBe('./dist/cli.js');
  });
});
```

### 1.9 Create `.github/workflows/ci.yml`

> **Reference:** VGE `.github/workflows/` — use the same Node version and test steps.

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: latest

      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Lint
        run: pnpm lint

      - name: Typecheck
        run: pnpm typecheck

      - name: Test
        run: pnpm test:coverage

      - name: Build
        run: pnpm build
```

---

## Step 2 — Shared schema and IPC contract

This is the most important step in Sprint 1. All other modules in Sprint 2 import from `src/shared/`. Getting these right prevents cascading type errors later.

### 2.1 `src/shared/config-schema.ts`

This is the Zod schema for `~/.vge-cc-guard/config.json`. It is the single source of truth — the daemon, TUI, and installer all import from this file.

> **Reference before coding:**  
> - PRD_1.md §5.1 — full config file structure  
> - VGE `packages/shared/src/schemas/index.ts` lines 1–30 — pattern for exporting Zod schema + inferred type together

```typescript
import { z } from 'zod';

const toolPolicySchema = z.object({
  gate: z.enum(['allow', 'block', 'ask']),
  analyze_output: z.boolean(),
});

export type ToolPolicy = z.infer<typeof toolPolicySchema>;

const vgeConfigSchema = z.object({
  api_url: z.string().url(),
  // No .min(1) — empty string is valid at schema level (user hasn't configured yet).
  // vge-client.ts checks for a non-empty key before making any VGE call and logs
  // a clear warning when the key is missing. Enforcing min(1) here would crash
  // the daemon on first boot before the user has run `vge-cc-guard config`.
  api_key_input: z.string(),
  api_key_output: z.string().nullable().default(null),
  verified_at: z.string().datetime().nullable().default(null),
});

const policyConfigSchema = z.object({
  credential_protection: z.boolean().default(true),
  fatigue_cap_per_session: z.number().int().min(1).max(20).default(3),
  session_idle_ttl_hours: z.number().int().min(1).max(168).default(24),
});

export const configSchema = z.object({
  version: z.literal('1.0.0'),
  vge: vgeConfigSchema,
  tools: z.record(z.string(), toolPolicySchema),
  policy: policyConfigSchema,
});

export type Config = z.infer<typeof configSchema>;

export const DEFAULT_CONFIG: Config = {
  version: '1.0.0',
  vge: {
    api_url: 'https://api.vigilguard',
    api_key_input: '',
    api_key_output: null,
    verified_at: null,
  },
  tools: {
    Bash:      { gate: 'allow', analyze_output: true },
    Read:      { gate: 'allow', analyze_output: true },
    Grep:      { gate: 'allow', analyze_output: true },
    Glob:      { gate: 'allow', analyze_output: false },
    WebSearch: { gate: 'allow', analyze_output: true },
    WebFetch:  { gate: 'allow', analyze_output: true },
    Write:     { gate: 'block', analyze_output: false },
    Edit:      { gate: 'block', analyze_output: false },
    Task:      { gate: 'allow', analyze_output: false },
    '*':       { gate: 'ask',   analyze_output: false },
  },
  policy: {
    credential_protection: true,
    fatigue_cap_per_session: 3,
    session_idle_ttl_hours: 24,
  },
};
```

**Write a unit test now** — `tests/unit/config-schema.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { configSchema, DEFAULT_CONFIG } from '../../src/shared/config-schema.js';

describe('config-schema', () => {
  it('DEFAULT_CONFIG passes schema validation as-is (empty api_key is allowed)', () => {
    // api_key_input is '' by default — the schema allows this so the daemon
    // starts successfully before the user has configured a key via TUI.
    // vge-client.ts validates non-empty key at call time, not here.
    expect(() => configSchema.parse(DEFAULT_CONFIG)).not.toThrow();
  });

  it('accepts a valid API key', () => {
    const config = { ...DEFAULT_CONFIG, vge: { ...DEFAULT_CONFIG.vge, api_key_input: 'vg_live_testkey123' } };
    expect(() => configSchema.parse(config)).not.toThrow();
  });

  it('rejects unknown gate values', () => {
    const bad = { ...DEFAULT_CONFIG, tools: { Bash: { gate: 'maybe', analyze_output: true } } };
    expect(() => configSchema.parse(bad)).toThrow();
  });

  it('wildcard * tool entry is valid', () => {
    const result = configSchema.parse(DEFAULT_CONFIG);
    expect(result.tools['*']).toEqual({ gate: 'ask', analyze_output: false });
  });

  it('rejects version other than 1.0.0', () => {
    const bad = { ...DEFAULT_CONFIG, version: '2.0.0' };
    expect(() => configSchema.parse(bad)).toThrow();
  });
});
```

### 2.2 `src/shared/types.ts`

Domain types used across daemon, shim, and TUI. No Zod here — these are plain TypeScript interfaces.

> **Reference:** PRD_1.md §4.1 (session state machine), §7.7 (router outcomes), §7.9 (escalation), §7.10 (allowlist)

```typescript
// Session state machine (PRD_1 §4.1, §7.3)
export type SessionState = 'clean' | 'caution' | 'tainted';

// Confidence Router outcomes (PRD_1 §7.7)
export type RouterOutcome = 'HARD_TAINT' | 'SOFT_TAINT' | 'ESCALATE' | 'ALLOW';

// PreToolUse gate decision mapped to Claude Code permissionDecision
export type GateDecision = 'allow' | 'deny' | 'ask';

// Ask-dialog user decision vocabulary (PRD_1 §7.9)
export type EscalationDecision = 'once' | 'session' | 'block' | 'quarantine';

// One pending escalation (PRD_1 §7.9)
export interface Escalation {
  escalationId: string;
  sessionId: string;
  toolName: string;
  resourceId: string;
  analysisId: string | null;
  branches: { heuristics: number; semantic: number; llmGuard: number };
  routerOutcome: RouterOutcome;
  enqueuedAt: number;  // Date.now()
}

// In-memory per-session state (PRD_1 §4.1, §7.9.3)
export interface SessionData {
  sessionId: string;
  parentSessionId: string | null;
  createdAt: number;
  lastActivity: number;
  state: SessionState;
  // Set of canonicalized "(toolName):(resourceId)" strings
  allowlist: Set<string>;
  pendingEscalations: Escalation[];
  escalationCount: number;
}

// VGE GuardResponse branches subset used by the Confidence Router.
// Full GuardResponse lives in VGE packages/shared/src/schemas/index.ts:236–334.
// We only import the fields the sidecar needs, not the full VGE type.
export interface GuardBranches {
  heuristics?: { score: number } | null;
  semantic?: { score: number } | null;
  llmGuard?: { score: number } | null;
}

export interface GuardResponseSubset {
  decision: 'ALLOWED' | 'BLOCKED' | 'SANITIZED';
  score: number;
  branches: GuardBranches;
  ruleAction?: 'ALLOW' | 'BLOCK' | 'LOG' | 'SANITIZE';
  decisionFlags?: string[];
  failOpen?: boolean;
  id?: string;
}

// Claude Code hook payload shapes (what CC sends to our shim via stdin)
export interface CCBasePayload {
  session_id: string;
  hook_event_name: string;
  cwd?: string;
  parent_session_id?: string;  // present for sub-agent sessions (PRD_1 §7.12)
}

export interface CCSessionStartPayload extends CCBasePayload {
  hook_event_name: 'SessionStart';
}

export interface CCSessionEndPayload extends CCBasePayload {
  hook_event_name: 'SessionEnd';
}

export interface CCUserPromptPayload extends CCBasePayload {
  hook_event_name: 'UserPromptSubmit';
  prompt: string;
}

export interface CCPreToolPayload extends CCBasePayload {
  hook_event_name: 'PreToolUse';
  tool_name: string;
  tool_input: Record<string, unknown>;
}

export interface CCPostToolPayload extends CCBasePayload {
  hook_event_name: 'PostToolUse';
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: string;
  tool_error: string | null;
}

export type CCHookPayload =
  | CCSessionStartPayload
  | CCSessionEndPayload
  | CCUserPromptPayload
  | CCPreToolPayload
  | CCPostToolPayload;
```

**Write a unit test** — `tests/unit/types-smoke.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type { SessionData, RouterOutcome } from '../../src/shared/types.js';

describe('types', () => {
  it('SessionData can be constructed inline (type check via compile)', () => {
    const s: SessionData = {
      sessionId: 'sess_abc',
      parentSessionId: null,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      state: 'clean',
      allowlist: new Set(),
      pendingEscalations: [],
      escalationCount: 0,
    };
    expect(s.state).toBe('clean');
  });

  it('RouterOutcome union covers all four values', () => {
    const outcomes: RouterOutcome[] = ['HARD_TAINT', 'SOFT_TAINT', 'ESCALATE', 'ALLOW'];
    expect(outcomes).toHaveLength(4);
  });
});
```

### 2.3 `src/shared/ipc-protocol.ts`

This defines the contract between the shim (per-call process) and the daemon (long-lived server). The shim sends a JSON request body to one of the daemon's HTTP routes over the Unix socket; the daemon responds with a JSON body. Every field here is load-bearing — do not add optional fields "for later" unless PRD_1 requires them.

> **Reference:** PRD_1.md §4.3 (component diagram), §4.4 (Claude Code hook contract)

```typescript
// Shim → Daemon request: the shim forwards the raw CC hook payload plus the
// event name so the daemon can dispatch without re-parsing the payload.
export interface ShimRequest {
  event: 'sessionstart' | 'userprompt' | 'pretool' | 'posttool' | 'sessionend';
  payload: Record<string, unknown>;  // raw CC JSON
}

// Daemon → Shim response shapes, one per hook event type.
// The shim writes the "ccOutput" field verbatim to stdout (what CC reads).
// null means "write nothing to stdout" (for SessionStart/SessionEnd).

export interface SessionStartResponse {
  event: 'sessionstart';
  ccOutput: null;
}

export interface SessionEndResponse {
  event: 'sessionend';
  ccOutput: null;
}

// UserPromptSubmit response:
// - decision: "block" to reject the prompt with a reason
// - null to let it through
export interface UserPromptResponse {
  event: 'userprompt';
  ccOutput: { decision: 'block'; reason: string } | null;
}

// PreToolUse response (PRD_1 §4.4):
// MUST use hookSpecificOutput, never top-level decision.
export interface PreToolResponse {
  event: 'pretool';
  ccOutput: {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse';
      permissionDecision: 'allow' | 'deny' | 'ask';
      permissionDecisionReason?: string;
    };
  };
}

// PostToolUse response:
// decision: "block" provides feedback to Claude (tool already ran, not pre-enforcement)
export interface PostToolResponse {
  event: 'posttool';
  ccOutput: { decision: 'block'; reason: string } | null;
}

export type DaemonResponse =
  | SessionStartResponse
  | SessionEndResponse
  | UserPromptResponse
  | PreToolResponse
  | PostToolResponse;
```

**Write a unit test** — `tests/unit/ipc-protocol.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type { PreToolResponse, ShimRequest } from '../../src/shared/ipc-protocol.js';

describe('ipc-protocol types', () => {
  it('PreToolResponse deny shape matches Claude Code spec', () => {
    const resp: PreToolResponse = {
      event: 'pretool',
      ccOutput: {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'test reason',
        },
      },
    };
    expect(resp.ccOutput.hookSpecificOutput.permissionDecision).toBe('deny');
    // Verify no top-level "decision" field leaks in
    expect('decision' in resp.ccOutput).toBe(false);
  });

  it('ShimRequest accepts all five event names', () => {
    const events: ShimRequest['event'][] = [
      'sessionstart', 'userprompt', 'pretool', 'posttool', 'sessionend',
    ];
    expect(events).toHaveLength(5);
  });
});
```

---

## Final directory structure at end of Sprint 1

```
vge-cc-guard/
├── .github/
│   └── workflows/
│       └── ci.yml
├── config/                     # (empty — Sprint 2 adds default-tools.json)
├── src/
│   ├── cli.ts                  # stub dispatcher
│   ├── commands/               # (empty — Sprint 3)
│   ├── shim/                   # (empty — Sprint 3)
│   ├── daemon/                 # (empty — Sprint 2)
│   ├── shared/
│   │   ├── config-schema.ts    # ✅ Zod schema + DEFAULT_CONFIG
│   │   ├── types.ts            # ✅ SessionData, RouterOutcome, CC payloads
│   │   └── ipc-protocol.ts     # ✅ shim ↔ daemon contract
│   └── tui/                    # (empty — Sprint 4)
├── tests/
│   ├── unit/
│   │   ├── cli-smoke.test.ts
│   │   ├── config-schema.test.ts
│   │   ├── types-smoke.test.ts
│   │   └── ipc-protocol.test.ts
│   └── integration/            # (empty — Sprint 3)
├── .gitignore
├── eslint.config.js
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

---

## External References

| Resource | Path | Why |
|---|---|---|
| VGE GuardResponse schema | `Vigil-Guard-Enterprise/packages/shared/src/schemas/index.ts:236–334` | Authoritative shape for `GuardResponseSubset` in `types.ts` |
| VGE payload constants | `Vigil-Guard-Enterprise/packages/shared/src/schemas/index.ts:20–25` | `MAX_PROMPT_LENGTH=100000`, `MAX_TOOL_VALUE_BYTES=65536` |
| VGE TS config pattern | `Vigil-Guard-Enterprise/packages/shared/tsconfig.json` | NodeNext + strict baseline |
| VGE vitest config pattern | `Vigil-Guard-Enterprise/packages/shared/vitest.config.ts` | Coverage thresholds, globals |
| VGE CI workflow | `Vigil-Guard-Enterprise/.github/workflows/` | Node version, steps |
| PRD_1 §5.1 | `docs/prd/PRD_1/PRD_1.md` | Full config.json schema — source of truth for `DEFAULT_CONFIG` |
| PRD_1 §4.4 | `docs/prd/PRD_1/PRD_1.md` | Claude Code hook output format — source of truth for `ipc-protocol.ts` |
| Anthropic hooks reference | https://docs.anthropic.com/en/docs/claude-code/hooks | `permissionDecision` values, `hookSpecificOutput` shape |

---

## Acceptance Criteria

All of the following must be true before Sprint 2 starts:

- [ ] `pnpm install --frozen-lockfile && pnpm build` exits 0, produces `dist/cli.js` with shebang
- [ ] `dist/cli.js` is executable (`ls -la dist/cli.js` shows `-rwxr-xr-x`)
- [ ] `pnpm test` exits 0, all 4 test files pass
- [ ] `pnpm lint` exits 0
- [ ] `pnpm typecheck` exits 0
- [ ] CI workflow triggers on push to main, all steps green
- [ ] `configSchema.parse(DEFAULT_CONFIG)` does not throw (empty `api_key_input` is valid at schema level)
- [ ] `ipc-protocol.ts` has no top-level `decision` field in `PreToolResponse.ccOutput` (must use `hookSpecificOutput`)
- [ ] `src/shared/` contains exactly 3 files: `config-schema.ts`, `types.ts`, `ipc-protocol.ts`
- [ ] No runtime dependencies added beyond `zod`
