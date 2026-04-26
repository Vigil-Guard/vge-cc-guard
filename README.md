# vge-cc-guard — Claude Code Sidecar for VGE

BLOCK-default runtime policy for Claude Code, backed by VGE detection. Tool gating with credential path protection, per-resource session allowlist, full local audit trail, and a TUI configurator. Distributed as an npm package.

> **Status:** Phase 1 design locked 2026-04-26. See [PRD_1](docs/prd/PRD_1/PRD_1.md) for the locked specification and the build sequence in §13.

---

## What it does

- **Replaces the Phase 0 bash hook.** A native TypeScript sidecar handles `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `SessionStart`, `SessionEnd` for Claude Code.
- **Gates tool execution** at `PreToolUse` with `permissionDecision: allow / deny / ask` based on a deterministic priority list (credential path deny list → pending escalation → allowlist → tainted-state guard → per-tool config). Decision is local; no VGE round-trip on the critical path.
- **Sends configured tool outputs** to VGE `/v1/guard/analyze` with `source: 'tool_output'`. The Confidence Router reduces the response to `HARD_TAINT / SOFT_TAINT / ESCALATE / ALLOW`.
- **Asks for a decision** when VGE flags a single-branch, FP-prone signal. Returns `permissionDecision: deny` on the next `PreToolUse` with a prompt asking the user to reply `once`, `session`, `block`, or `quarantine`. No timeout. The reply is parsed in `UserPromptSubmit`.
- **Soft per-resource allowlist.** A `session` decision adds the exact `(tool_name, resource_id)` pair to a session-scoped allowlist. Future calls on that resource skip the dialog; VGE still receives the analysis request for telemetry.
- **Credential path protection.** Hard-coded deny list for `~/.env`, `~/.ssh/`, `~/.aws/credentials`, `~/.kube/config`, `~/.gcp/`, `id_rsa*`, `*credentials*`, `*secrets*`. Configurable on/off in the TUI; default ON.
- **Subagent inheritance.** Sub-agents spawned via the `Task` tool share session state with the master by reference — trust decisions and tainted state propagate both ways.
- **TUI configurator** (`vge-cc-guard config`) for VGE keys, per-tool policy, and security baseline. The TUI is the supported editing surface; manual JSON editing works but isn't recommended.

What is intentionally **not** in the sidecar: local pattern matching, regex content scanning, risk scores. VGE is the only content detector. The sidecar is a routing engine, a state machine, and an audit orchestrator.

---

## Prerequisites

- Node.js 18+
- A reachable VGE instance (`vg_live_…` or `vg_test_…` API key)

---

## Install

```bash
npm install -g vge-cc-guard
vge-cc-guard install     # interactive: scope (user-wide / project), merge mode (merge / dry-run)
vge-cc-guard config      # interactive TUI: API keys + per-tool policy
```

`install` writes hook entries to `~/.claude/settings.json` (or `<project>/.claude/settings.json` for `--project` scope), preserving any existing user hooks via merge. The original file is snapshotted to `~/.vge-cc-guard/.pre-install-settings.backup` so `vge-cc-guard uninstall` can revert cleanly.

`config` opens the TUI for first-time setup. You can also fall back to env vars (`VGE_API_KEY`, `VGE_API_URL`) for CI/Docker scenarios where no human runs the configurator.

### Verify

```bash
ls ~/.vge-cc-guard/                    # config.json, daemon.sock (after first hook), audit.log, sessions/
cat ~/.claude/settings.json            # should contain vge-cc-guard hook entries
vge-cc-guard config                    # status bar reads "ok" when api_key_input is set
```

In Claude Code: open a session, the daemon lazy-starts on the first hook. Decision events appear in `~/.vge-cc-guard/audit.log` (JSONL).

---

## Configuration

Single source of truth: `~/.vge-cc-guard/config.json` (mode `0600`). Default Phase 1a contents:

```json
{
  "version": "1.0.0",
  "vge": {
    "api_url": "https://api.vigilguard",
    "api_key_input": "vg_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "api_key_output": null
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

### Per-tool fields

| Field | Values | Meaning |
|---|---|---|
| `gate` | `allow` / `block` / `ask` | PreToolUse policy mapped to Claude Code `permissionDecision`. `ask` defers to Claude Code's native permission prompt. |
| `analyze_output` | `true` / `false` | When `true`, PostToolUse output goes to VGE `/v1/guard/analyze` for content analysis. Never persisted locally. |

### Defaults rationale

Developer-essential tools (`Bash`, `Read`, `Grep`) ship with `gate: allow + analyze_output: true` — you can work without friction, but VGE sees content for after-the-fact session tainting. `Glob` is path-only; nothing to analyse. `Write`/`Edit` ship with `gate: block` because they change code; flip to `allow` per project once you trust your workflow. `Task` stays `allow + analyze_output: false` because sub-agents inherit the master's policy (their individual tool calls each go through their own hook).

See [PRD_1 §7.5](docs/prd/PRD_1/PRD_1.md) for full rationale.

---

## How it works

```
Claude Code session
    │
    ├─ SessionStart  ─►  shim ─► daemon                 init session state
    ├─ UserPromptSubmit ─► shim ─► daemon               async POST /v1/guard/input
    │                                                   parse escalation reply if pending
    │
    ├─ PreToolUse  ───►  shim ─► daemon  (CRITICAL)
    │                       1. credential path deny  ─► deny
    │                       2. pending escalation    ─► deny + dialog
    │                       3. allowlist hit          ─► allow
    │                       4. tainted + risky tool   ─► deny
    │                       5. config.tools[T].gate   ─► allow / deny / ask
    │
    ├─ PostToolUse  ──►  shim ─► daemon  (non-blocking)
    │                       analyze_output=true?
    │                       allowlist hit?  ─► VGE for telemetry only
    │                       else: dual-pass head+tail truncate, POST /v1/guard/analyze
    │                       Confidence Router reduces response to HARD_TAINT / SOFT_TAINT
    │                                                              / ESCALATE / ALLOW
    │                       update session state, audit JSONL
    │
    └─ SessionEnd  ───►  shim ─► daemon                 flush audit, drop session
```

### Escalation flow (the FP-prone single-branch case)

1. PostToolUse on `WebFetch("https://example.com/xss-tutorial")`. VGE flags semantic=72 (single branch, score 55–89).
2. Confidence Router → `ESCALATE`. Sidecar enqueues `pending_escalation`. Tool output already flowed to Claude.
3. On the next PreToolUse, sidecar returns `permissionDecision: "deny"` with `permissionDecisionReason` carrying the dialog (resource, score, branch, instruction to reply `once / session / block / quarantine`).
4. User's next prompt starts with one of those tokens. `UserPromptSubmit` reply parser captures the decision; the token never reaches VGE as content.
5. `session` adds `(WebFetch, https://example.com/xss-tutorial)` to the allowlist. Subsequent fetches of that URL pass the dialog but still flow to VGE for telemetry; audit JSONL records `enforcement_taken: none, user_allowlisted: true`.

---

## Commands

```bash
vge-cc-guard install       # register hooks in Claude Code settings (interactive)
vge-cc-guard install --apply --scope=user        # non-interactive, user-wide
vge-cc-guard install --apply --scope=project     # current directory
vge-cc-guard install --dry-run                   # print diff, don't write

vge-cc-guard config        # TUI configurator
vge-cc-guard daemon        # foreground daemon (development)
vge-cc-guard reset-session # clear allowlist + pending + fatigue counter
vge-cc-guard hook <event>  # hook subcommand invoked by Claude Code (don't call manually)

vge-cc-guard uninstall     # restore settings.json from snapshot, delete ~/.vge-cc-guard/
```

---

## Files and locations

| Path | Purpose |
|---|---|
| `~/.vge-cc-guard/config.json` | Single source of configuration (mode `0600`). |
| `~/.vge-cc-guard/daemon.sock` | Unix socket for shim ↔ daemon IPC. |
| `~/.vge-cc-guard/audit.log` | JSONL escalation lifecycle. 90-day retention, daily rotation. |
| `~/.vge-cc-guard/debug.log` | Pino structured log. 50 MB rotation, keep 5, 7-day retention. |
| `~/.vge-cc-guard/sessions/<id>.json` | Per-session persistence (allowlist, pending, state). |
| `~/.vge-cc-guard/.pre-install-settings.backup` | Snapshot of `~/.claude/settings.json` taken on first install. |
| `~/.claude/settings.json` | Claude Code settings. `vge-cc-guard install` adds command-style hook entries here. |

---

## Troubleshooting

| Symptom | Where to look |
|---|---|
| Tool always blocked | `vge-cc-guard config` → Tools Policy. `Bash`/`Write`/`Edit` defaults vary; check the per-tool `gate`. |
| `Read` denied with credential-path message | `config` → Security Baseline. Toggle off only if you really need it. |
| No events in VGE | `config` → API Keys → `[Test Connection]`. Then check `~/.vge-cc-guard/debug.log`. |
| Daemon won't start | `vge-cc-guard daemon` in foreground; reads stderr directly. Check Node version (18+). |
| Session stuck in `tainted` | `vge-cc-guard reset-session` clears state for the active CC session. |
| Pending escalation not resolving | First word of your next prompt must be `once` / `session` / `block` / `quarantine` (or alias). Ambiguous replies are blocked and re-asked. |

---

## Phase scope

| Phase | Duration | Ships |
|---|---|---|
| **1a** (MVP) | 3–4 weeks | Full sidecar feature set: shim+daemon, PreToolUse gating with credential path protection, Confidence Router, ask-dialog, soft allowlist, subagent inheritance, audit JSONL, install/uninstall, TUI configurator (4 screens). |
| **1b** (Resilience) | 1–2 weeks | VGE retry/backoff, response cache, debug log rotation, session-state persistence. |
| **1c** (Live monitoring + beta) | 2–3 weeks | TUI live views (Events / Pending / Audit / Stats), `--project` scope, end-to-end test suite, closed-beta `0.9.0-beta.x`. |
| **`1.0.0`** | ~7–10 weeks | npm tagged release. |

See [PRD_1 §13](docs/prd/PRD_1/PRD_1.md) for the step-by-step build sequence.

---

## Roadmap (Phase 2+)

- `PermissionRequest`, `PermissionDenied`, `ConfigChange` hook handling (currently deferred per [concept doc](docs/architecture/claude-code-agent-security-integration.md)).
- Per-project policy file (Phase 1 supports per-project hook installation, not per-project policy).
- Server-managed deployment with read-only TUI mode.
- OTel mapping for VGE Investigation UI.
- Session replay view in the TUI.
- Other agents (Cursor, Copilot) — same shim+daemon model where hooks exist.

---

**Specification:** [docs/prd/PRD_1/PRD_1.md](docs/prd/PRD_1/PRD_1.md)
**TUI design:** [docs/CONFIG_DESIGN.md](docs/CONFIG_DESIGN.md)
**Concept doc:** [docs/architecture/claude-code-agent-security-integration.md](docs/architecture/claude-code-agent-security-integration.md)
**Language ADR:** [docs/adr/ADR-0001-project-scope-and-language.md](docs/adr/ADR-0001-project-scope-and-language.md)
