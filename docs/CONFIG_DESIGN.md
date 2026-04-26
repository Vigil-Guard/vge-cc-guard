# vge-cc-guard TUI Configurator — Design

> **Status:** Locked 2026-04-26. This document is the canonical specification
> for the `vge-cc-guard config` and `vge-cc-guard install` user-facing flows.
> The product behaviour, Confidence Router, ask-dialog, allowlist, and
> credential path protection that the configurator exposes are defined in
> [PRD_1](prd/PRD_1/PRD_1.md). Where the two disagree, PRD_1 is authoritative
> and this file is the bug.

The configurator is the only sanctioned way to change settings. Editing
`~/.vge-cc-guard/config.json` by hand works but is not the supported path —
the configurator validates, shows the security implication of each toggle,
and writes the file atomically with a backup.

## 1. Surfaces

| Command | Purpose | When |
|---|---|---|
| `vge-cc-guard install` | Register hooks in Claude Code settings, create `~/.vge-cc-guard/`, optionally launch `config`. | First run after `npm install -g`. |
| `vge-cc-guard config` | Interactive TUI for API keys, per-tool policy, security baseline, view-only summary. | Whenever the user wants to change settings. |
| `vge-cc-guard uninstall` | Revert `~/.claude/settings.json`, delete `~/.vge-cc-guard/`. | Tear-down. |
| `vge-cc-guard reset-session` | Clear allowlist, pending escalations, and fatigue cap for the active session. | Escape hatch when the session got stuck. |

## 2. Install Flow (`vge-cc-guard install`)

Interactive. Default answers reflect the safer path; the user can override.

```
┌──────────────────────────────────────────────────────────────────────┐
│  vge-cc-guard install                                                │
│                                                                      │
│  This will register sidecar hooks in your Claude Code settings.      │
│                                                                      │
│  Scope:                                                              │
│    > [user-wide]   ~/.claude/settings.json   (default)               │
│      [project]     ./.claude/settings.json                           │
│                                                                      │
│  Existing settings:                                                  │
│    > [merge]       Add our hooks alongside yours, backup the         │
│                    original to ~/.vge-cc-guard/.pre-install-...      │
│                    settings.backup.                                  │
│      [dry-run]     Show the diff and require --apply to write.       │
│                                                                      │
│  [Continue]  [Cancel]                                                │
└──────────────────────────────────────────────────────────────────────┘
```

After confirmation:

1. Read existing `~/.claude/settings.json` (or `<project>/.claude/settings.json`).
2. Snapshot the original to `~/.vge-cc-guard/.pre-install-settings.backup`.
3. Merge in:
   ```json
   {
     "hooks": {
       "UserPromptSubmit": [
         { "matcher": "*", "hooks": [{ "type": "command", "command": "vge-cc-guard hook userprompt" }] }
       ],
       "PreToolUse": [
         { "matcher": "*", "hooks": [{ "type": "command", "command": "vge-cc-guard hook pretool" }] }
       ],
       "PostToolUse": [
         { "matcher": "*", "hooks": [{ "type": "command", "command": "vge-cc-guard hook posttool" }] }
       ],
       "SessionStart": [
         { "matcher": "*", "hooks": [{ "type": "command", "command": "vge-cc-guard hook sessionstart" }] }
       ],
       "SessionEnd": [
         { "matcher": "*", "hooks": [{ "type": "command", "command": "vge-cc-guard hook sessionend" }] }
       ]
     }
   }
   ```
4. Write `~/.vge-cc-guard/config.json` with the default policy template
   (see §5) **only if** the file does not already exist.
5. Offer to chain into `vge-cc-guard config` for API-key setup.

### Re-running `install`

Idempotent. Re-running detects existing vge-cc-guard hook entries and
replaces them in place. The pre-install backup is created **only** on
the first install — subsequent runs do not overwrite the snapshot, so
`uninstall` always restores the true original.

### `--dry-run` and `--apply`

Same flags work non-interactively for CI:

```bash
vge-cc-guard install --dry-run                 # prints diff, exits 0
vge-cc-guard install --apply --scope=user      # write user-wide
vge-cc-guard install --apply --scope=project   # write current project
```

## 3. Main Menu (`vge-cc-guard config`)

Navigation: `↑`/`↓` select, `Enter` to open, `Esc` back, `Ctrl-C` quit.

```
┌──────────────────────────────────────────────────────────────────────┐
│  vge-cc-guard configuration                       v1.0.0             │
│  Config: ~/.vge-cc-guard/config.json              status: ok         │
│                                                                      │
│  > [1] API Keys & VGE Connection                                     │
│    [2] Tools Policy                                                  │
│    [3] Security Baseline                                             │
│    [4] View Current Configuration                                    │
│    [5] Exit                                                          │
│                                                                      │
│  q quit · ↑↓ navigate · Enter open                                   │
└──────────────────────────────────────────────────────────────────────┘
```

The status indicator on the title bar reads from the on-disk config:

- `ok` — config is valid and `api_key_input` is set.
- `incomplete` — file exists but `api_key_input` is missing/blank.
- `invalid` — JSON parse error or schema violation; details in `[4] View`.

## 4. Screen — API Keys & VGE Connection

```
┌──────────────────────────────────────────────────────────────────────┐
│  API Keys & VGE Connection                                           │
│                                                                      │
│  VGE API URL                                                         │
│    [https://api.vigilguard                                       ]   │
│                                                                      │
│  Input API Key (required)                                            │
│    [vg_test_*****************************                        ]   │
│    Format: vg_(test|live)_[a-zA-Z0-9_-]{32}                          │
│                                                                      │
│  Output API Key (optional, leave blank to reuse Input)               │
│    [                                                              ]  │
│                                                                      │
│    [Test Connection]    [Save]    [Cancel]                           │
│                                                                      │
│  Tab next field · Shift-Tab prev · Esc cancel                        │
└──────────────────────────────────────────────────────────────────────┘
```

### Validation

| Field | Rule |
|---|---|
| `api_url` | HTTPS URL, valid host, no path component beyond `/`. |
| `api_key_input` | Matches `vg_(test\|live)_[a-zA-Z0-9_-]{32}`. |
| `api_key_output` | Same format if set, or empty. |

### Test Connection

`GET <api_url>/health` with `Authorization: Bearer <api_key_input>`. Two
seconds timeout. Result rendered inline:

```
✓ Connected. VGE 1.6.3, key vg_test_***1Cc, latency 38 ms.
```

or:

```
✗ 401 Unauthorized.
  Check the key in the VGE web UI → API Keys.
```

### Persistence

Saving writes:

```json
"vge": {
  "api_url": "...",
  "api_key_input": "...",
  "api_key_output": null,
  "verified_at": "2026-04-26T20:15:33Z"
}
```

`verified_at` is set only when Test Connection succeeded immediately
before Save.

### Credential precedence (runtime)

Config file `vge.api_key_input` wins. Environment variables
(`VGE_API_KEY`, `VGE_API_URL`) are a fallback used when the config
file does not specify a value, intended for CI/Docker scenarios where
nobody runs the TUI. This is the inverse of the legacy Phase 0 hook
behaviour.

## 5. Screen — Tools Policy

The configurator scans for available tools at open time:

1. Built-in Claude Code tool list (`Bash`, `Read`, `Write`, `Edit`,
   `Glob`, `Grep`, `WebFetch`, `WebSearch`, `Task`).
2. Custom MCP tools discovered in `~/.claude/.mcp.json`,
   `<project>/.claude/.mcp.json`, `~/.mcp.json`.

Each tool is shown with two toggles: `gate` and `analyze_output`.

```
┌──────────────────────────────────────────────────────────────────────┐
│  Tools Policy                                                        │
│                                                                      │
│  Built-in tools                                                      │
│  ┌──────────────┬──────────────┬────────────────────────┐            │
│  │ Tool         │ Gate         │ Analyze output (VGE)   │            │
│  ├──────────────┼──────────────┼────────────────────────┤            │
│  │ Bash         │ [allow]  ▾   │ [on]   ▾                │           │
│  │ Read         │ [allow]  ▾   │ [on]   ▾                │           │
│  │ Grep         │ [allow]  ▾   │ [on]   ▾                │           │
│  │ Glob         │ [allow]  ▾   │ [off]  ▾                │           │
│  │ WebSearch    │ [allow]  ▾   │ [on]   ▾                │           │
│  │ WebFetch     │ [allow]  ▾   │ [on]   ▾                │           │
│  │ Write        │ [block]  ▾   │ [off]  ▾                │           │
│  │ Edit         │ [block]  ▾   │ [off]  ▾                │           │
│  │ Task         │ [allow]  ▾   │ [off]  ▾                │           │
│  └──────────────┴──────────────┴────────────────────────┘            │
│                                                                      │
│  Custom MCP tools (1 detected)                                       │
│    my-internal-mcp     Gate: [ask]   Analyze output: [off]           │
│                                                                      │
│  Unknown / fallback                                                  │
│    *                   Gate: [ask]   Analyze output: [off]           │
│                                                                      │
│    [Save]    [Reset to Defaults]    [Cancel]                         │
│                                                                      │
│  Tab move · Space cycle · Enter edit · ? help                        │
└──────────────────────────────────────────────────────────────────────┘
```

### Field semantics

| Field | Values | Meaning |
|---|---|---|
| `gate` | `allow` / `block` / `ask` | Maps to Claude Code `permissionDecision`. `ask` defers to Claude Code's native prompt. |
| `analyze_output` | `on` / `off` | When `on`, PostToolUse output is sent to VGE `/v1/guard/analyze` with `source: 'tool_output'`. |

### Defaults shipped with the package

```json
{
  "Bash":      { "gate": "allow", "analyze_output": true  },
  "Read":      { "gate": "allow", "analyze_output": true  },
  "Grep":      { "gate": "allow", "analyze_output": true  },
  "Glob":      { "gate": "allow", "analyze_output": false },
  "WebSearch": { "gate": "allow", "analyze_output": true  },
  "WebFetch":  { "gate": "allow", "analyze_output": true  },
  "Write":     { "gate": "block", "analyze_output": false },
  "Edit":      { "gate": "block", "analyze_output": false },
  "Task":      { "gate": "allow", "analyze_output": false },
  "*":         { "gate": "ask",   "analyze_output": false }
}
```

Rationale and per-category notes are in [PRD_1 §7.5](prd/PRD_1/PRD_1.md).

## 6. Screen — Security Baseline

```
┌──────────────────────────────────────────────────────────────────────┐
│  Security Baseline                                                   │
│                                                                      │
│  Credential path protection                            [enabled] ▾   │
│                                                                      │
│  When enabled, the sidecar refuses Read/Edit/Write on the            │
│  following paths regardless of per-tool configuration:               │
│                                                                      │
│    ~/.env, */.env, *.env                                             │
│    ~/.ssh/*                                                          │
│    ~/.aws/credentials, ~/.aws/config                                 │
│    ~/.kube/config                                                    │
│    ~/.config/gcloud/*, ~/.gcp/*                                      │
│    id_rsa*, id_ed25519*, id_ecdsa*                                   │
│    *credentials*, *secrets*                                          │
│                                                                      │
│  ⚠  Disabling this protection lets Claude read your credentials      │
│     into context. Only do this if you have a specific reason.        │
│                                                                      │
│    [Save]    [Cancel]                                                │
└──────────────────────────────────────────────────────────────────────┘
```

The toggle maps to `policy.credential_protection: true | false`.
When the user attempts to flip it to `disabled`, the configurator
shows a confirm dialog with the warning above and requires a second
key press (`y`) to commit.

## 7. Screen — View Current Configuration

Read-only summary, useful for share/paste in support requests. Sensitive
fields are masked. Non-blocking — opens fast, never validates connection.

```
┌──────────────────────────────────────────────────────────────────────┐
│  Current Configuration  (~/.vge-cc-guard/config.json)                │
│                                                                      │
│  Schema version: 1.0.0                                               │
│                                                                      │
│  VGE                                                                 │
│    api_url:        https://api.vigilguard                            │
│    api_key_input:  vg_test_***1Cc                                    │
│    api_key_output: (reuses Input)                                    │
│    verified_at:    2026-04-26T20:15:33Z                              │
│                                                                      │
│  Tools                                                               │
│    Bash:      gate=allow  analyze_output=on                          │
│    Read:      gate=allow  analyze_output=on                          │
│    Grep:      gate=allow  analyze_output=on                          │
│    Glob:      gate=allow  analyze_output=off                         │
│    WebSearch: gate=allow  analyze_output=on                          │
│    WebFetch:  gate=allow  analyze_output=on                          │
│    Write:     gate=block  analyze_output=off                         │
│    Edit:      gate=block  analyze_output=off                         │
│    Task:      gate=allow  analyze_output=off                         │
│    *:         gate=ask    analyze_output=off                         │
│                                                                      │
│  Policy                                                              │
│    credential_protection:    enabled                                 │
│    fatigue_cap_per_session:  3                                       │
│    session_idle_ttl_hours:   24                                      │
│                                                                      │
│  Last modified: 2026-04-26 20:15:33                                  │
│                                                                      │
│    [Edit Tools]  [Edit Keys]  [Export (redacted)]  [Back]            │
└──────────────────────────────────────────────────────────────────────┘
```

`[Export (redacted)]` writes the same content (with masked keys) to
`~/.vge-cc-guard/config.export-<timestamp>.txt` for sharing in support
tickets.

## 8. Configuration File

Path: `~/.vge-cc-guard/config.json`. Permissions: `0600` (enforced by
the daemon and the configurator on each save).

```json
{
  "version": "1.0.0",
  "vge": {
    "api_url": "https://api.vigilguard",
    "api_key_input": "vg_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "api_key_output": null,
    "verified_at": "2026-04-26T20:15:33Z"
  },
  "tools": {
    "Bash":      { "gate": "allow", "analyze_output": true  },
    "Read":      { "gate": "allow", "analyze_output": true  },
    "Grep":      { "gate": "allow", "analyze_output": true  },
    "Glob":      { "gate": "allow", "analyze_output": false },
    "WebSearch": { "gate": "allow", "analyze_output": true  },
    "WebFetch":  { "gate": "allow", "analyze_output": true  },
    "Write":     { "gate": "block", "analyze_output": false },
    "Edit":      { "gate": "block", "analyze_output": false },
    "Task":      { "gate": "allow", "analyze_output": false },
    "*":         { "gate": "ask",   "analyze_output": false }
  },
  "policy": {
    "credential_protection": true,
    "fatigue_cap_per_session": 3,
    "session_idle_ttl_hours": 24
  }
}
```

### Save behaviour

1. Validate against the Zod schema.
2. Write to `config.json.tmp` in the same directory.
3. `fsync`, then `rename` over `config.json`.
4. Move previous `config.json` to `config.json.bak` (single-slot
   backup, overwritten on each save).
5. `chmod 0600`.

The daemon watches the file via `fs.watch` and reloads on change.
Open Claude Code sessions get the new config on the next hook event;
no daemon restart required.

## 9. Phase Scope

Phase 1a (MVP) ships:

- Install / Uninstall flows.
- Main Menu, API Keys, Tools Policy, Security Baseline, View Current
  Configuration screens.
- Save with validation and atomic write.

Phase 1c adds the live-monitoring views from the original concept doc:

- **Events** — tail of all hook firings with decision, source, latency.
- **Pending** — currently open ask-dialogs (resolve via TUI in addition
  to the prompt-reply path).
- **Audit** — JSONL audit log viewer with filters.
- **Stats** — decision distribution, p50/p99 latency, VGE health.

Phase 2 (later) considers a read-only mode for organisation-managed
deployments where the configurator surfaces but does not edit policy.

## 10. Implementation Notes

- TUI library: `ink` (React-based), with `ink-text-input` and
  `ink-select-input` for primitives. Decision recorded in
  [ADR-0001](adr/ADR-0001-project-scope-and-language.md).
- The configurator is a thin layer over a `Config` struct shared with
  the daemon, so both read/write paths use the same Zod schema.
- All UI strings live in `src/tui/strings.ts` to make a future i18n
  pass cheap. Phase 1 is English-only.

## 11. Testing

- Snapshot tests for each screen render.
- Property tests for the validator (random Zod inputs that must reject).
- Integration test for the install/uninstall round-trip against a sandbox
  `~/.claude/`.
- Manual checklist (each release): first-time install, re-install
  preserves user hooks, dry-run prints faithful diff, uninstall reverts
  to backup, save round-trips through `config.json` byte-for-byte.
