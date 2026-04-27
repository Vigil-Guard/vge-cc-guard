# SPRINT 4 — TUI + E2E Tests

**Status:** Ready to execute after Sprint 3 is complete  
**Duration:** 4–5 days  
**Predecessor:** Sprint 3 (install must work; shim must route correctly)  
**Unlocks:** Phase 1a complete — `pnpm add -g vge-cc-guard && vge-cc-guard install` is the full user story

---

## Objective

Two parallel tracks that must both be complete before Phase 1a is declared done:

1. **TUI configurator** — `vge-cc-guard config` opens a terminal UI with 6 screens. A new user can configure their VGE API key and per-tool policy without editing JSON by hand.
2. **End-to-end fixture tests** — golden Claude Code hook payloads exercised through the full shim → daemon → response stack, plus a full escalation flow test.

---

## Prerequisites

Read before writing any code:

| Document | Sections | Why |
|---|---|---|
| [CONFIG_DESIGN.md](../../CONFIG_DESIGN.md) | All sections | Canonical TUI spec — every screen, every keyboard shortcut, all copy text |
| [PRD_1.md §7.9](./PRD_1.md#79-ask-dialog-layer-2) | Full section | Escalation flow for E2E test |
| [PRD_1.md §7.10](./PRD_1.md#710-resource-allowlist-session-scoped-soft) | Full section | Allowlist behavior for E2E test |
| [PRD_1.md §8](./PRD_1.md#8-phase-1-acceptance-criteria) | Criteria 1–23 | These are the acceptance criteria you are testing against |
| [PRD_1.md §13 Steps 5, 7](./PRD_1.md#13-execution-plan) | Steps 5, 7 | Execution plan for TUI and E2E steps |

---

## New dependencies to add

```bash
pnpm add ink ink-select-input ink-text-input react
pnpm add -D @types/react ink-testing-library
```

> **Ink version note:** Use Ink 4.x (requires React 18). Ink renders React components as terminal output — components receive props and use React hooks exactly as in a browser React app, but render to TTY rather than DOM.

---

## Track 1 — TUI Configurator (Days 1–3)

### Architecture overview

The TUI is launched by `vge-cc-guard config`. It renders a multi-screen terminal application using Ink. Navigation: `↑`/`↓` to move between items, `Enter` to select, `Esc` to go back, `Ctrl-C` to quit and discard unsaved changes.

All config reads and writes go through `src/daemon/tool-policy.ts` (or directly read/write `~/.vge-cc-guard/config.json` using the Zod schema from `src/shared/config-schema.ts`).

The TUI **does not start or talk to the daemon**. It reads and writes the config file directly.

### File structure for TUI

```
src/tui/
├── App.tsx           ← root component, owns screen state
├── strings.ts        ← all user-visible copy strings
└── screens/
    ├── MainMenu.tsx
    ├── InstallWizard.tsx
    ├── ApiKeys.tsx
    ├── ToolsPolicy.tsx
    ├── SecurityBaseline.tsx
    └── ViewConfig.tsx
```

### `src/tui/App.tsx`

Root component. Maintains `screen` state and renders the current screen. When a screen calls `onBack()`, go back to MainMenu.

```tsx
import React, { useState } from 'react';
import { MainMenu } from './screens/MainMenu.js';
import { ApiKeys } from './screens/ApiKeys.js';
import { ToolsPolicy } from './screens/ToolsPolicy.js';
import { SecurityBaseline } from './screens/SecurityBaseline.js';
import { ViewConfig } from './screens/ViewConfig.js';

type Screen = 'main' | 'api-keys' | 'tools-policy' | 'security-baseline' | 'view-config';

export function App() {
  const [screen, setScreen] = useState<Screen>('main');

  const goBack = () => setScreen('main');

  // onNavigate receives Screen values only — 'quit' is handled inside MainMenu
  // via process.exit(0) and never reaches here.
  const onNavigate = (s: Screen) => setScreen(s);

  switch (screen) {
    case 'main':
      return <MainMenu onNavigate={onNavigate} />;
    case 'api-keys':
      return <ApiKeys onBack={goBack} />;
    case 'tools-policy':
      return <ToolsPolicy onBack={goBack} />;
    case 'security-baseline':
      return <SecurityBaseline onBack={goBack} />;
    case 'view-config':
      return <ViewConfig onBack={goBack} />;
  }
}
```

### `src/tui/strings.ts`

Put every user-visible string here (no hardcoded strings in components). This enables future i18n and makes copy changes easy.

```typescript
export const S = {
  APP_TITLE: 'VGE Agent Guard — Configuration',
  MAIN_MENU_ITEMS: [
    { key: 'api-keys',          label: 'API Keys',           description: 'Set VGE endpoint and API keys' },
    { key: 'tools-policy',      label: 'Tools Policy',       description: 'Per-tool gate and analysis settings' },
    { key: 'security-baseline', label: 'Security Baseline',  description: 'Credential protection and session limits' },
    { key: 'view-config',       label: 'View Configuration', description: 'Read-only summary of current settings' },
    { key: 'quit',              label: 'Quit',               description: '' },
  ],
  API_KEYS_TITLE: 'API Keys',
  API_KEYS_URL_LABEL: 'VGE API URL',
  API_KEYS_KEY_LABEL: 'API Key (input)',
  API_KEYS_TEST_LABEL: 'Test Connection',
  TOOLS_POLICY_TITLE: 'Tools Policy',
  SECURITY_TITLE: 'Security Baseline',
  CREDENTIAL_PROTECTION_LABEL: 'Credential path protection',
  CREDENTIAL_PROTECTION_WARNING: '⚠ Disabling this allows Claude to read ~/.ssh/, ~/.aws/credentials, and similar files.',
  CREDENTIAL_PROTECTION_DENY_LIST_HEADER: 'Protected paths:',
  FATIGUE_CAP_LABEL: 'Max ask-dialogs per session',
  VIEW_CONFIG_TITLE: 'Current Configuration',
  SAVE_SUCCESS: '✓ Configuration saved',
  SAVE_ERROR: '✗ Failed to save configuration',
  BACK_HINT: 'Esc: back',
  TEST_CONNECTING: 'Testing connection...',
  TEST_SUCCESS: '✓ Connected',
  TEST_FAIL: '✗ Connection failed',
};
```

### Screen specifications

> **Full spec lives in CONFIG_DESIGN.md.** The summaries below are implementation reminders. When in doubt, CONFIG_DESIGN.md is authoritative.

#### `MainMenu.tsx`

- Renders a list of 4 menu items + Quit using `SelectInput` from `ink-select-input`.
- Each item has a label and a short description rendered below it.
- `onNavigate` prop has type `(screen: Screen) => void` — it does NOT accept `'quit'`.
- Selecting "Quit" calls `process.exit(0)` **directly inside MainMenu**, never via `onNavigate`. This keeps the `Screen` type clean and avoids a TypeScript error from passing a non-Screen value to a `Dispatch<SetStateAction<Screen>>`.

#### `ApiKeys.tsx`

- Two `TextInput` fields: VGE API URL and API Key (input).
- A "Test Connection" option that calls `GET /v1/license/status` with the entered key. Shows "Testing..." then "✓ Connected" or "✗ Connection failed: <message>".
- Save button: validates URL (must be a valid URL) and key format (non-empty). On success, writes to config and sets `verified_at` to current ISO datetime.
- `Esc` goes back without saving.

> **API key format validation:** use the same regex as the Python SDK — `vg_(live|test)_[a-zA-Z0-9_\-]{32,}`. If the entered key does not match, show an inline warning but do not block saving (the user might be using a custom format).

#### `ToolsPolicy.tsx`

- Table view of all tools from the config (default 9 tools + `*`).
- Two columns per tool: `gate` (allow/block/ask) and `analyze_output` (on/off).
- Navigate with arrow keys; `Enter` on a gate cell cycles through allow → block → ask → allow.
- `Enter` on an analyze_output cell toggles true/false.
- `s` to save changes. `Esc` to go back discarding changes (with confirmation if unsaved changes exist).

#### `SecurityBaseline.tsx`

- Toggle for `policy.credential_protection` (default: on).
- When the user attempts to turn it OFF: render the full deny list (from `path-deny.ts`) and the warning string from `S.CREDENTIAL_PROTECTION_WARNING`. Require a second Enter keypress to confirm.
- Number input for `policy.fatigue_cap_per_session` (1–20 range, validated).
- Number input for `policy.session_idle_ttl_hours` (1–168 range, validated).
- `s` to save. `Esc` to go back.

#### `ViewConfig.tsx`

- Read-only. Renders the current config as formatted JSON using Ink's `<Text>` component.
- Syntax-highlights JSON keys/values by using color props on `<Text>`.
- `Esc` to go back.

#### `InstallWizard.tsx`

This screen is shown when `vge-cc-guard install` is run without `--apply`. It renders the install confirmation flow from CONFIG_DESIGN §2.

- Two `SelectInput` choices: scope (user-wide / project) and mode (merge / dry-run).
- A final "Continue" / "Cancel" confirmation.
- When "Continue" is selected: calls the install logic from `src/commands/install.ts`.
- On success: shows the summary and offers to continue to `ApiKeys` screen.

**Sprint 4 required change to `src/commands/install.ts`:** Sprint 3's `install.ts` uses a basic readline confirmation prompt. Sprint 4 must update it to launch `InstallWizard` via Ink when running interactively (no `--apply` flag):

```typescript
// In src/commands/install.ts
if (!flags.apply) {
  const { render } = await import('ink');
  const { InstallWizard } = await import('../tui/screens/InstallWizard.js');
  const { waitUntilExit } = render(React.createElement(InstallWizard, { scope: flags.scope }));
  await waitUntilExit();
  return;
}
// --apply flag: run headlessly without TUI
await runInstallHeadless(flags);
```

This replaces the readline prompt from Sprint 3 — there should be no duplicate install flows after this change.

### Launching the TUI

Add to `src/commands/config.ts`:

```typescript
import { render } from 'ink';
import React from 'react';
import { App } from '../tui/App.js';

export async function runConfig(): Promise<void> {
  const { waitUntilExit } = render(React.createElement(App));
  await waitUntilExit();
}
```

Update `src/cli.ts` to call `runConfig()` for the `config` command.

### Testing the TUI

TUI components cannot be tested with full interaction in unit tests — use snapshot tests for rendering and manual keyboard checklist for interaction.

**`tests/unit/tui-render.test.ts`** — snapshot tests:

```typescript
import { render } from 'ink-testing-library';
import React from 'react';
import { MainMenu } from '../../src/tui/screens/MainMenu.js';

test('MainMenu renders all 4 menu items', () => {
  const { lastFrame } = render(React.createElement(MainMenu, { onSelect: () => {} }));
  expect(lastFrame()).toContain('API Keys');
  expect(lastFrame()).toContain('Tools Policy');
  expect(lastFrame()).toContain('Security Baseline');
  expect(lastFrame()).toContain('View Configuration');
});
```

(`ink-testing-library` is already in the dev dependencies added at the top of this sprint.)

Write one snapshot test per screen. The test renders the screen with mock props and asserts that key text is present.

**Manual keyboard checklist** (verify by running `node dist/cli.js config`):

```
□ Main menu renders all 4 items
□ ↑/↓ navigation works
□ Enter opens the selected screen
□ Esc returns to main menu from any screen
□ ApiKeys: typing in URL field updates the display
□ ApiKeys: Test Connection shows "Testing..." then result
□ ApiKeys: Esc discards without saving
□ ToolsPolicy: cycling gate values works
□ ToolsPolicy: s key saves and shows confirmation
□ SecurityBaseline: toggling credential_protection shows warning
□ SecurityBaseline: disabling requires second Enter confirmation
□ ViewConfig: shows current config as JSON
□ Ctrl-C from any screen exits cleanly
```

---

## Track 2 — End-to-End Tests (Days 3–5)

E2E tests start the daemon on a temp socket, run the shim as a child process, and verify the full round-trip through every hook event type.

### Test infrastructure prerequisite — `VGE_CC_GUARD_CONFIG_DIR`

Integration tests **must not** use `~/.vge-cc-guard/` — that is the developer's real production directory. The daemon must support a config directory override via environment variable.

**Before writing any integration test**, verify that `src/daemon/tool-policy.ts` respects `process.env.VGE_CC_GUARD_CONFIG_DIR` (this was specced in Sprint 2 Module 1). Every integration test that starts a daemon process must:

1. Create a `tmp` directory via `fs.mkdtempSync(path.join(os.tmpdir(), 'vge-cc-guard-test-'))`.
2. Write a test `config.json` there (using `DEFAULT_CONFIG` with a test API URL pointing to the local VGE mock server).
3. Create `tmp/sessions/` subdirectory.
4. Start the daemon with `VGE_CC_GUARD_CONFIG_DIR=tmp` in its env.
5. Clean up `tmp` in `afterAll`.

The VGE mock server is a real HTTP server on `localhost:<random-port>` started by the test. The test config's `vge.api_url` points to it. This verifies the actual HTTP request body structure.

### `tests/integration/claude-code-fixtures.test.ts`

Golden payload tests. Each test sends a real Claude Code hook payload (as it would arrive from CC) through the shim to the daemon and asserts the response.

Prepare a fixture file `tests/fixtures/cc-hooks.json` with one representative payload per event type. Use real field names from the CC documentation. Example:

```json
{
  "sessionStart": {
    "session_id": "sess_test_001",
    "hook_event_name": "SessionStart",
    "cwd": "/home/user/project"
  },
  "preToolAllowed": {
    "session_id": "sess_test_001",
    "hook_event_name": "PreToolUse",
    "tool_name": "Bash",
    "tool_input": { "command": "ls -la" }
  },
  "preToolBlocked": {
    "session_id": "sess_test_001",
    "hook_event_name": "PreToolUse",
    "tool_name": "Write",
    "tool_input": { "file_path": "/tmp/test.txt", "content": "hello" }
  },
  "preToolCredentialDenied": {
    "session_id": "sess_test_001",
    "hook_event_name": "PreToolUse",
    "tool_name": "Read",
    "tool_input": { "file_path": "~/.aws/credentials" }
  },
  "postToolNoAnalysis": {
    "session_id": "sess_test_001",
    "hook_event_name": "PostToolUse",
    "tool_name": "Glob",
    "tool_input": { "pattern": "**/*.ts" },
    "tool_response": "src/main.ts\nsrc/lib.ts",
    "tool_error": null
  },
  "sessionEnd": {
    "session_id": "sess_test_001",
    "hook_event_name": "SessionEnd"
  }
}
```

**Tests to write:**

```
✓ SessionStart → session created, shim exits 0, no stdout
✓ PreToolUse (Bash, gate=allow, session=clean) → permissionDecision=allow
✓ PreToolUse (Write, gate=block) → permissionDecision=deny
✓ PreToolUse (Read on ~/.aws/credentials) → permissionDecision=deny with credential message
✓ PostToolUse (Glob, analyze_output=false) → no VGE call, shim exits 0
✓ SessionEnd → session deleted, shim exits 0
✓ subagent session (parent_session_id present) → inherits parent state
```

For the VGE call assertions, mock the network using a local HTTP test server (not msw — use a real HTTP server on localhost that the daemon can call). This verifies the actual HTTP request structure.

### `tests/integration/escalation-flow.test.ts`

The most important integration test. Exercises the full ask-dialog flow end-to-end.

> **Reference:** PRD_1 §8 acceptance criteria items 11–15

**Scenario:** WebFetch returns suspicious content → Confidence Router returns ESCALATE → next PreToolUse is denied with dialog → user replies `session` → same WebFetch passes through allowlist.

**Test sequence:**

```typescript
// Setup: daemon running, VGE mock server returning a single-branch 72-score response

// Step 1: SessionStart
await runHook('sessionstart', { session_id: SESS, hook_event_name: 'SessionStart' });

// Step 2: PostToolUse with WebFetch output (VGE mock returns semantic=72, score=72)
await runHook('posttool', {
  session_id: SESS,
  hook_event_name: 'PostToolUse',
  tool_name: 'WebFetch',
  tool_input: { url: 'https://example.com/blog/xss-tutorial' },
  tool_response: 'Some fetched content that triggers semantic branch...',
  tool_error: null,
});

// Step 3: Next PreToolUse is denied (pending escalation)
const preResult1 = await runHook('pretool', {
  session_id: SESS,
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'echo hi' },
});
expect(preResult1.hookSpecificOutput.permissionDecision).toBe('deny');
expect(preResult1.hookSpecificOutput.permissionDecisionReason).toContain('WebFetch');
expect(preResult1.hookSpecificOutput.permissionDecisionReason).toContain('session');

// Step 4: User replies 'session' via UserPromptSubmit
const promptResult = await runHook('userprompt', {
  session_id: SESS,
  hook_event_name: 'UserPromptSubmit',
  prompt: 'session',
});
expect(promptResult).toBeNull();  // allow prompt through

// Step 5: Same WebFetch again → PostToolUse analysis still runs (soft allowlist)
// VGE mock is called again (verify with mock assertion)
await runHook('posttool', { /* same WebFetch */ });
// Verify VGE was called with userAllowlisted=true in metadata

// Step 6: Pending queue is now empty; next PreToolUse for Bash falls through
// to gate=allow from config. This is NOT an allowlist hit — the allowlist
// entry is (WebFetch, <url>), not (Bash, <anything>). The allow here comes
// from Bash's default gate config after the escalation queue was cleared.
const preResult2 = await runHook('pretool', {
  session_id: SESS,
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'echo hi' },
});
expect(preResult2.hookSpecificOutput.permissionDecision).toBe('allow');

// Step 7: Verify audit log contains full escalation lifecycle
// tool_output_escalated → escalation_resolved → tool_output_analyzed (user_allowlisted=true)
```

**Additional E2E test:**

```
✓ Tainted session denies Bash even when gate=allow
  - Send PostToolUse with VGE mock returning 2 branches agreed → HARD_TAINT
  - Verify session.state === 'tainted'
  - Send PreToolUse for Bash → permissionDecision=deny
  - Send PreToolUse for WebSearch → permissionDecision=allow (not in tainted deny set)
```

```
✓ Credential path deny list overrides all other logic
  - Start clean session
  - Send PreToolUse for Read("~/.aws/credentials")
  - permissionDecision=deny, reason contains "credential protection"
  - Disable credential_protection in config, repeat → still deny
  Wait... check PRD_1 §7.11: "Applies to Read, Edit, Write" and
  "Default ON, toggleable in the TUI with a red warning"
  So when credential_protection=false → the deny is NOT applied.
  Test: with credential_protection=false → permissionDecision follows normal gate logic
```

---

## Final directory structure at end of Sprint 4

```
src/
├── cli.ts                         ✅ (fully dispatching)
├── commands/
│   ├── install.ts                 ✅
│   ├── uninstall.ts               ✅
│   ├── reset-session.ts           ✅
│   ├── daemon.ts                  ✅
│   └── config.ts                  ✅
├── shim/                          ✅
├── daemon/                        ✅
├── shared/                        ✅
└── tui/
    ├── App.tsx                    ✅
    ├── strings.ts                 ✅
    └── screens/
        ├── MainMenu.tsx           ✅
        ├── InstallWizard.tsx      ✅
        ├── ApiKeys.tsx            ✅
        ├── ToolsPolicy.tsx        ✅
        ├── SecurityBaseline.tsx   ✅
        └── ViewConfig.tsx         ✅

tests/
├── unit/                          ✅ (Sprint 2)
│   └── tui-render.test.ts         ✅ (new)
├── integration/
│   ├── shim-daemon.test.ts        ✅ (Sprint 3)
│   ├── install-uninstall.test.ts  ✅ (Sprint 3)
│   ├── claude-code-fixtures.test.ts ✅
│   └── escalation-flow.test.ts   ✅
└── fixtures/
    └── cc-hooks.json              ✅
```

---

## External References

| Resource | Path | Why |
|---|---|---|
| CONFIG_DESIGN.md | `docs/CONFIG_DESIGN.md` | Full TUI screen specs — canonical spec for every screen |
| CONFIG_DESIGN.md §9 | `docs/CONFIG_DESIGN.md` | Phase 1c live-monitoring screens (not built in Sprint 4, but read so you know what NOT to build) |
| PRD_1 §8 acceptance criteria | `docs/prd/PRD_1/PRD_1.md` | Items 11–15 are tested by escalation-flow.test.ts |
| PRD_1 §7.9 | `docs/prd/PRD_1/PRD_1.md` | Dialog text and session decision vocabulary |
| PRD_1 §7.10 | `docs/prd/PRD_1/PRD_1.md` | Soft allowlist behavior after 'session' decision |
| Ink documentation | https://github.com/vadimdemedes/ink | Ink component API, useInput, SelectInput, TextInput |
| ink-testing-library | https://github.com/vadimdemedes/ink-testing-library | Testing Ink components |
| VGE Python SDK detect() | `python-SDK-vge/src/vigil/_client.py` | Pattern for Test Connection in ApiKeys.tsx (call /v1/license/status) |
| VGE API /v1/license/status | `Vigil-Guard-Enterprise/docs/api/endpoints.md` | Endpoint used by "Test Connection" button |

---

## Acceptance Criteria (Phase 1a complete)

All acceptance criteria from PRD_1 §8 items 1–23 must be verifiable. Key items verified by this sprint:

- [ ] `vge-cc-guard config` opens TUI with 6 screens navigable by keyboard
- [ ] ApiKeys screen writes verified API key to config.json on save
- [ ] ToolsPolicy screen: gate cycling and analyze_output toggle work
- [ ] SecurityBaseline: disabling credential_protection requires second-Enter confirmation and shows deny list
- [ ] `pnpm test` exits 0 (all unit + integration tests)
- [ ] All integration tests use `VGE_CC_GUARD_CONFIG_DIR` pointing to a temp dir (never `~/.vge-cc-guard/`)
- [ ] escalation-flow test: `session` decision → resource added to allowlist → subsequent PreToolUse on same session allows through
- [ ] escalation-flow test: VGE still called on allowlisted resource with `userAllowlisted=true` in metadata
- [ ] tainted session denies Bash regardless of gate=allow config
- [ ] credential-path test: Read("~/.aws/credentials") → deny when protection=true; follows gate config when protection=false
- [ ] Manual keyboard checklist (all items checked)
- [ ] `pnpm build && pnpm add -g .` and `vge-cc-guard install && vge-cc-guard config` works end-to-end
