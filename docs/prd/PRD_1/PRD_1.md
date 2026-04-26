# PRD_1 — vge-cc-guard Phase 1 Sidecar

**Status:** Design locked, ready for execution
**Author:** Tomasz Bartel
**Created:** 2026-04-20
**Updated:** 2026-04-26 (revision 4 — design lock; L1 removed, VGE-only detection; ask-dialog and TUI configurator moved into Phase 1a; credential path protection added; transport/lifecycle locked)
**Target branch:** `main`
**Owners:** vge-cc-guard
**Related:**
- [Concept doc](../../architecture/claude-code-agent-security-integration.md)
- [CONFIG_DESIGN — TUI configurator spec](../../CONFIG_DESIGN.md)
- [ADR-0001 — TypeScript on Node.js](../../adr/ADR-0001-project-scope-and-language.md)

---

## 1. Executive Summary

**Phase 0** (delivered 2026-04-20) shipped a `UserPromptSubmit` bash hook that posts to VGE `/v1/guard/input`. It is advisory, fail-open, and was a useful first signal. Phase 1 supersedes it.

**Phase 1** (this document) delivers a **full native sidecar** written in TypeScript on Node.js, distributed as the npm package `vge-cc-guard`:

- **Replaces the Phase 0 bash hook.** Handles `UserPromptSubmit`, `PostToolUse`, `SessionStart`, `SessionEnd`. Logs prompts to VGE `/v1/guard/input` and configured tool outputs to `/v1/guard/analyze` with `source: 'tool_output'`.
- **Tool gating** via `PreToolUse`. Pure local decision based on `(tool_name → gate config) + session state + per-resource allowlist + credential path deny list`. No content detection on the critical path; the decision is a hash-map lookup and runs in single-digit milliseconds.
- **Selective tool output analysis.** Per-tool `analyze_output` flag — only tools the user marks as external-content sources have their output sent to VGE.
- **Confidence Router** over the VGE `GuardResponse`. Counts agreeing branches, routes to `HARD_TAINT` / `SOFT_TAINT` / `ESCALATE` / `ALLOW`. The router is a sidecar enforcement reducer, not a replacement for VGE's final decision.
- **Ask Dialog** for the single-branch grey zone. Uses Claude Code's supported `permissionDecision: "deny"` plus a `UserPromptSubmit` reply parser that consumes `once` / `session` / `block` / `quarantine`. No timeout. No custom UI surface.
- **Soft per-resource session allowlist.** A `session` decision adds the exact `(tool_name, resource_id)` to a session-scoped allowlist. Subsequent calls on that resource still flow through VGE for telemetry; the sidecar takes no enforcement action.
- **Credential path protection.** Hard-coded deny list for `~/.env`, `~/.ssh/`, `~/.aws/credentials`, `~/.kube/config`, `~/.gcp/`, `id_rsa*`, `*credentials*`, `*secrets*`. Default ON, toggleable in the TUI with a red warning.
- **Subagent inheritance.** Sub-agent sessions share the master session's state (allowlist, tainted state, escalation count, pending escalations) by reference. A trust decision in the master applies to its sub-agents and vice versa.
- **TUI configurator** (`vge-cc-guard config`). Ships in Phase 1a — the user must be able to configure VGE credentials and per-tool policy without editing JSON by hand.
- **Graceful VGE degradation.** If VGE is unreachable, PostToolUse analysis is logged and skipped (the tool already ran). PreToolUse never depends on VGE, so a VGE outage does not affect gating.
- **Existing VGE contracts only.** Phase 1 uses `/v1/guard/input` and `/v1/guard/analyze` plus existing typed `agent`/`tool`/`conversation`/`metadata` fields. It does **not** require `/v1/audit/events`, `/v1/policies`, or any new VGE endpoint.

What is intentionally **not** in the sidecar: local content detection, regex pattern matching, risk-score arithmetic. VGE is the only content detector. The sidecar is a routing engine, a state machine, and an audit orchestrator.

---

## 2. Phase 0 Summary (What's Done)

### 2.1 What Phase 0 Delivers

| Component | Deliverable | Status |
|-----------|-------------|--------|
| **Hook script** | `~/.claude/vg-cc/user-prompt-submit.sh` (250 lines) | ✅ Complete |
| **Installation** | Universal: one-time setup in `~/.claude/`, works for all projects | ✅ Complete |
| **User Prompt Logging** | UserPromptSubmit → POST /v1/guard/input | ✅ Complete |
| **Tool Output Analysis** | PostToolUse → POST /v1/guard/output (bonus beyond spec) | ✅ Complete |
| **Wire Format** | Typed (PRD_29) + legacy (PRD_28) auto-fallback | ✅ Complete |
| **Fail-Open** | Never blocks Claude Code, always exits 0 | ✅ Complete |
| **Documentation** | README.md, troubleshooting | ✅ Complete |
| **Testing** | Smoke tests, DRY_RUN mode | ✅ Complete |

> **Note:** Phase 0 used `/v1/guard/output` for tool output. Phase 1 corrects this to `/v1/guard/analyze` with `source: 'tool_output'` — see section 7.5.

### 2.2 Phase 0 Architecture

```
Claude Code session (any project)
    │
    ├─ UserPromptSubmit hook fires
    │  └─ ~/.claude/vg-cc/user-prompt-submit.sh
    │     └─ POST /v1/guard/input
    │
    └─ PostToolUse hook fires (bonus)
       └─ ~/.claude/vg-cc/user-prompt-submit.sh
          └─ POST /v1/guard/output  ← Phase 1 replaces with /v1/guard/analyze

VGE receives both events
    ├─ Detection branches (heuristics, semantic, llm-guard, pii)
    ├─ ClickHouse logging
    └─ Investigation tab shows all claude-code events
```

### 2.3 Phase 0 Limitations (Solved by Phase 1)

| Gap | Phase 0 Behavior | Phase 1 Solution |
|-----|------------------|-----------------|
| **Tool Gating** | No enforcement; advisory only | PreToolUse hook returns `permissionDecision: allow / deny / ask` from local config + session state |
| **Session State** | No multi-turn analysis | Track `clean / caution / tainted` across prompts; `tainted` denies risky tools by default |
| **Configuration** | Environment variables only | `vge-cc-guard config` TUI for VGE keys, per-tool policy, security baseline |
| **Operator Control** | None; static rules in VGE | Local config at `~/.vge-cc-guard/config.json`; no VGE policy endpoint in Phase 1 |
| **Performance** | 5 s timeout per prompt (blocking) | PreToolUse never blocks on VGE; UserPromptSubmit and PostToolUse are async |
| **Wrong endpoint** | PostToolUse → `/v1/guard/output` | PostToolUse → `/v1/guard/analyze` + `source: 'tool_output'` |
| **Selective analysis** | All tool outputs sent to VGE | Per-tool `analyze_output` config flag |
| **Credential exposure** | None — agent could read `.env` freely | Hard-coded credential path deny list, configurable on/off in TUI |
| **Subagent isolation** | N/A (no enforcement) | Sub-agent sessions inherit master state; one trust decision applies to both |

---

## 3. Phase 1 Scope

### 3.1 Goals

Phase 1 must:

1. **Replace the Phase 0 bash hook.** Handle `UserPromptSubmit`, `PostToolUse`, `SessionStart`, `SessionEnd` in the sidecar. Log prompts to `/v1/guard/input`. Send tool outputs to `/v1/guard/analyze` with `source: 'tool_output'` only when `analyze_output: true` for that tool.
2. **Tool gating via PreToolUse.** Return `permissionDecision: allow / deny / ask` based on `(tool_name → gate config) + session state + per-resource allowlist + credential path deny list + pending escalations`. No content detection on the critical path.
3. **Selective tool output analysis.** Per-tool `analyze_output` flag. Only tools the user marks as external-content sources go to VGE. See §7.5.
4. **Session state machine.** Track `clean → caution → tainted`. Tainted sessions deny risky tools (Bash, Write, Edit, Task) regardless of their default `gate` setting until the user runs `reset-session` or the session ends.
5. **Confidence Router.** Reduce VGE `GuardResponse` to one of `HARD_TAINT / SOFT_TAINT / ESCALATE / ALLOW` deterministically. See §7.7.
6. **Ask Dialog.** When the router returns `ESCALATE`, halt the next `PreToolUse` with `permissionDecision: deny` and a `permissionDecisionReason` that asks the user to reply `once` / `session` / `block` / `quarantine` in their next prompt. No timeout. See §7.9.
7. **Soft per-resource allowlist.** A `session` decision adds `(tool_name, resource_id)` to a session-scoped allowlist; future calls on that resource skip the dialog but still flow through VGE for telemetry. See §7.10.
8. **Credential path protection.** Hard-coded deny list for sensitive paths, applied to `Read`, `Edit`, `Write`. Configurable on/off in the TUI (default on). See §7.11.
9. **Subagent inheritance.** Sub-agent sessions share state (allowlist, tainted state, escalation count, pending escalations) with the master by reference. See §7.12.
10. **TUI configurator** in Phase 1a. `vge-cc-guard config` exposes API keys, per-tool policy, and the security-baseline toggle.
11. **Graceful degradation.** PreToolUse never depends on VGE. PostToolUse logs and skips VGE on transport error — the tool already ran, so analysis failure is non-fatal. UserPromptSubmit is async fire-and-forget. See §7.6.

### 3.2 Non-Goals

Phase 1 explicitly does **not**:

1. Replace VGE detection — VGE remains the only content detector. The sidecar runs no semantic, llm-guard, regex, or pattern-matching analysis (§7.2).
2. Implement content moderation — that stays in VGE arbiter.
3. Add custom Claude Code UI surfaces or modal dialogs. Phase 1 uses only supported Claude Code hook outputs and normal user prompts.
4. Support custom rule scripting — policies are JSON templates from local/user/project configuration.
5. Handle multi-session correlation — that's Phase 2 (session replay).
6. Implement OTel/observability — that's Phase 2.
7. Log raw tool output payloads locally — `analyze_output` means "send to VGE for analysis", not "persist raw content in the sidecar". Consistent with VGE's own `storePromptContent` / `agentContextLoggingEnabled` separation.
8. Add or depend on new VGE API endpoints. Escalation lifecycle audit is local-only in Phase 1; VGE telemetry comes through existing guard endpoints.

---

## 4. Phase 1 Architecture

### 4.1 Component Diagram

```
Claude Code session
    │
    ├─ SessionStart hook
    │  └─ shim ───► daemon
    │     └─ Initialize session_store[session_id] (state=clean,
    │        allowlist={}, pending=[], escalation_count=0)
    │
    ├─ UserPromptSubmit hook
    │  └─ shim ───► daemon
    │     ├─ If pending_escalations is non-empty → run reply parser
    │     │  (see §7.9.1). Decision tokens never reach VGE.
    │     ├─ Async POST /v1/guard/input (fire-and-forget; no blocking)
    │     └─ Return decision (block ambiguous escalation reply, else allow)
    │
    ├─ PreToolUse hook  ─────────────────────────────────  CRITICAL PATH
    │  └─ shim ───► daemon
    │     1. credential path deny list — Read/Edit/Write on protected
    │        paths → permissionDecision: "deny" (always, not configurable
    │        per-call)
    │     2. pending escalation in queue → permissionDecision: "deny"
    │        with §7.9 dialog text in permissionDecisionReason
    │     3. (tool_name, resource_id) in allowlist → permissionDecision:
    │        "allow"
    │     4. session state == tainted AND tool ∈ {Bash, Write, Edit, Task}
    │        → permissionDecision: "deny"
    │     5. config.tools[tool_name].gate → permissionDecision
    │        (allow / deny / ask)
    │     No VGE call. Latency target: < 10 ms.
    │
    ├─ PostToolUse hook
    │  └─ shim ───► daemon (response can be slow, hook is non-blocking)
    │     ├─ tool config analyze_output == false  ──► local audit event,
    │     │                                            END
    │     ├─ (tool, resource_id) in allowlist → POST /v1/guard/analyze
    │     │  with metadata.vgeAgentGuard.userAllowlisted=true. Run
    │     │  Confidence Router for local audit only. No session state
    │     │  change, no ask-dialog. END.
    │     ├─ Else: dual-pass head+tail truncate to 100 k chars (§7.6),
    │     │  POST /v1/guard/analyze. On VGE error: log and continue.
    │     └─ Feed GuardResponse into Confidence Router (§7.7):
    │        ├─ HARD_TAINT → session_state = tainted, local audit
    │        ├─ SOFT_TAINT → session_state = caution, local audit
    │        ├─ ESCALATE   → enqueue pending_escalation (resolved at next
    │        │              PreToolUse via §7.9, no timeout)
    │        └─ ALLOW      → local audit only
    │
    └─ SessionEnd hook
       └─ shim ───► daemon
          └─ Flush audit JSONL; delete session_store[session_id]
```

### 4.2 FP Reduction Pipeline (2 Layers + Allowlist Pre-filter)

After PostToolUse analysis returns a `GuardResponse`, the sidecar does not blindly taint on `score >= 40`. Instead it uses VGE branch agreement to route decisions, falling through to an ask-dialog for uncertain single-branch cases. VGE is the sole content detector — the sidecar does not run local semantic or pattern-based detection on tool output beyond what the tool config authorizes. Educational-content heuristics (URL markers, CVE regex, domain allowlists) were considered and rejected as duplicating VGE capabilities with lower precision.

```
VGE GuardResponse
    │
    ▼
┌─────────────────────────────────┐
│ Layer 1: Confidence Router       │  (deterministic, always runs)
│  Counts agreeing branches        │
│  Returns: HARD_TAINT / SOFT_     │
│  TAINT / ESCALATE / ALLOW        │
└─────────────────────────────────┘
    │
    │ (only if ESCALATE)
    ▼
┌─────────────────────────────────┐
│ Layer 2: Ask Dialog              │  (user decision, no timeout)
│  Enqueue pending_escalation      │
│  Ask at next PreToolUse          │
│  Parse user reply                │
│  Decisions: once / session /     │
│             block / quarantine   │
└─────────────────────────────────┘
```

Details in sections 7.7 and 7.9. Resource-level allowlist (populated by `session` decisions) is section 7.10.

User-facing outcomes:

| Situation | What user sees |
|-----------|----------------|
| VGE branches don't agree (≥2 required) and score < 55 | Nothing, tool output flows |
| Obvious attack (VGE hard policy, ≥2 branches agree, or single branch score ≥ 90) | Current/future risky tool calls are denied, session tainted |
| Uncertain (single branch, score 55–89) | Next tool call is denied with a decision prompt; user resolves via next prompt (no timeout) |
| Resource already allowlisted by user | Nothing visible; VGE analysis still runs and local audit records the pass-through |

**Design intent:** multi-branch corroboration handles high-confidence cases without asking; the single-branch grey zone (where cybersec educational content typically lives) goes to the user; once user trusts a specific resource, further hits on that resource don't re-ask but still flow through VGE's existing detection/logging path and the sidecar's local audit.

### 4.3 Sidecar Internal Architecture

Two processes, one Unix socket. The shim is a tiny per-call client; the daemon is a long-lived server. See §7.13 for transport rationale.

```
shim (per-hook process)                   daemon (long-lived)
─────────────────────────────             ─────────────────────────────────
src/shim/index.ts                         src/daemon/
  Reads CC hook payload from stdin        ├─ http-server.ts
  Connects to ~/.vge-cc-guard/daemon.     │   Express on Unix socket
  sock                                    │   Routes:
  Sends payload, awaits JSON reply        │     /health
  Writes reply to stdout                  │     /v1/hooks/sessionstart
  Exits 0 on success, 2 on transport      │     /v1/hooks/userprompt
  failure (fail-closed)                   │     /v1/hooks/pretool
                                          │     /v1/hooks/posttool
  If socket missing → fork() daemon       │     /v1/hooks/sessionend
  detached, retry connect with 1 s         │
  total timeout                           ├─ tool-policy.ts
                                          │   Loads ~/.vge-cc-guard/config.json
                                          │   Hot-reloads on fs.watch
                                          │
                                          ├─ session-state.ts
                                          │   In-memory map keyed by Claude
                                          │   Code session_id. Each entry:
                                          │     state: clean | caution | tainted
                                          │     allowlist: Set<(tool, res_id)>
                                          │     pending: Queue<Escalation>
                                          │     escalation_count: number
                                          │   Subagent inheritance via shared
                                          │   reference (§7.12).
                                          │   24 h idle TTL GC.
                                          │   Eager fsync to ~/.vge-cc-guard/
                                          │   sessions/<id>.json on writes
                                          │   that affect security; lazy
                                          │   write-behind for telemetry.
                                          │
                                          ├─ path-deny.ts
                                          │   Hard-coded credential path
                                          │   deny list (§7.11).
                                          │
                                          ├─ confidence-router.ts (§7.7)
                                          ├─ ask-dialog.ts (§7.9)
                                          ├─ allowlist.ts (§7.10)
                                          │
                                          ├─ vge-client.ts
                                          │   POST /v1/guard/input (fire-
                                          │   and-forget)
                                          │   POST /v1/guard/analyze with
                                          │   source: 'tool_output'
                                          │   Dual-pass head+tail truncation
                                          │   (§7.6)
                                          │   Exponential backoff: 3 retries,
                                          │   max 5 s total
                                          │
                                          └─ audit-logger.ts
                                              ~/.vge-cc-guard/audit.log (JSONL)
                                              Escalation lifecycle only; no
                                              raw tool content. Hard-coded
                                              90-day retention (§7.9.2).
```

The shim is intentionally minimal: stdin → Unix socket → stdout. It contains no policy logic. All decisions live in the daemon, so the daemon can evolve without recompiling the shim contract.

### 4.4 Claude Code Hook Contract Grounding

Phase 1 uses Claude Code hook outputs exactly as documented by Anthropic:

| Hook | Sidecar use | Claude Code output format |
|------|-------------|---------------------------|
| `UserPromptSubmit` | Log user prompt to VGE; parse escalation replies when a pending escalation exists | Top-level `decision: "block"` only when the prompt must be blocked; otherwise omit `decision`. Optional `additionalContext` may be used for informational context. |
| `PreToolUse` | Primary gating point for tools | `hookSpecificOutput.hookEventName = "PreToolUse"` and `permissionDecision` set to `allow`, `deny`, or `ask`. Top-level `decision` is deprecated for this event and MUST NOT be used. |
| `PostToolUse` | Analyze completed tool output; optionally warn Claude after execution | Top-level `decision: "block"` with `reason` can provide feedback to Claude, but the tool already ran. It is not pre-execution enforcement. `updatedMCPToolOutput` is MCP-only and is out of scope for MVP. |
| `SessionStart` / `SessionEnd` | Initialize and cleanup local session state | No decision control; side effects only. |

PreToolUse examples:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "VGE Agent Guard: session is tainted by prior tool output. Reply 'once', 'session', 'block', or 'quarantine' to resolve."
  }
}
```

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": "VGE Agent Guard: local policy allowed this tool call."
  }
}
```

`permissionDecision: "ask"` is reserved for ordinary tool-policy approval (`gate: "ask"`) where Claude Code's native permission prompt is enough. It is not used for the four-option VGE escalation vocabulary, because Claude Code's native ask prompt cannot collect `once` / `session` / `block` / `quarantine` as structured choices. Escalations use `deny` with a clear reason, then `UserPromptSubmit` parses the user's next prompt.

HTTP hooks can return decision JSON in a 2xx response, but connection failure, timeout, or non-2xx status is non-blocking in Claude Code. Phase 1 therefore registers **command-style** hooks rather than HTTP hooks (§7.13): the shim exits with code 2 on transport failure, which Claude Code honours as fail-closed for `PreToolUse`. A VGE outage is different again — the daemon stays reachable, PreToolUse never depended on VGE in the first place, and PostToolUse logs and continues.

---

## 5. Phase 1 Deliverables

**npm package: `vge-cc-guard`** (published to npm registry)

```
vge-cc-guard/
├── package.json                                # "bin": { "vge-cc-guard": "dist/cli.js" }
├── tsconfig.json
├── vitest.config.ts
│
├── src/
│   ├── cli.ts                                  # subcommand dispatch
│   ├── commands/
│   │   ├── install.ts                          # vge-cc-guard install
│   │   ├── uninstall.ts                        # vge-cc-guard uninstall
│   │   ├── config.ts                           # vge-cc-guard config (TUI)
│   │   ├── daemon.ts                           # vge-cc-guard daemon
│   │   ├── reset-session.ts                    # vge-cc-guard reset-session
│   │   └── hook.ts                             # vge-cc-guard hook <event>
│   │
│   ├── shim/
│   │   ├── index.ts                            # entry for `hook <event>`
│   │   └── lazy-start.ts                       # detached daemon spawn
│   │
│   ├── daemon/
│   │   ├── http-server.ts
│   │   ├── tool-policy.ts
│   │   ├── session-state.ts
│   │   ├── path-deny.ts                        # credential path deny list
│   │   ├── confidence-router.ts
│   │   ├── ask-dialog.ts
│   │   ├── allowlist.ts
│   │   ├── reply-parser.ts                     # once/session/block/quarantine
│   │   ├── vge-client.ts
│   │   ├── truncate.ts                         # head+tail dual-pass
│   │   └── audit-logger.ts
│   │
│   ├── shared/
│   │   ├── config-schema.ts                    # Zod schema, single source
│   │   ├── types.ts
│   │   └── ipc-protocol.ts                     # shim ↔ daemon contract
│   │
│   └── tui/
│       ├── App.tsx                             # ink root
│       ├── screens/
│       │   ├── MainMenu.tsx
│       │   ├── ApiKeys.tsx
│       │   ├── ToolsPolicy.tsx
│       │   ├── SecurityBaseline.tsx
│       │   ├── ViewConfig.tsx
│       │   └── InstallWizard.tsx
│       └── strings.ts
│
├── config/
│   └── default-tools.json                      # default tool policy template
│
├── tests/
│   ├── unit/
│   │   ├── tool-policy.test.ts
│   │   ├── session-state.test.ts
│   │   ├── confidence-router.test.ts
│   │   ├── reply-parser.test.ts
│   │   ├── path-deny.test.ts
│   │   ├── allowlist.test.ts
│   │   └── truncate.test.ts
│   └── integration/
│       ├── shim-daemon.test.ts                 # Unix socket roundtrip
│       ├── claude-code-fixtures.test.ts        # golden hook payloads
│       ├── install-uninstall.test.ts           # sandbox ~/.claude/
│       └── escalation-flow.test.ts             # end-to-end ask-dialog
│
├── docs/
│   ├── architecture/
│   ├── adr/
│   ├── prd/PRD_1/PRD_1.md
│   └── CONFIG_DESIGN.md
│
└── .github/workflows/
    ├── ci.yml                                  # lint + typecheck + test
    └── npm-publish.yml                         # tagged release
```

### 5.1 Configuration File Schema

Full `~/.vge-cc-guard/config.json` (Phase 1a defaults — restrictive on tools that ingest external content, permissive on developer-essential tools):

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

**Field semantics:**

| Field | Values | Meaning |
|-------|--------|---------|
| `tools.<name>.gate` | `"allow"` / `"block"` / `"ask"` | PreToolUse policy mapped to Claude Code `permissionDecision`. `"ask"` defers to Claude Code's native permission prompt. |
| `tools.<name>.analyze_output` | `true` / `false` | When `true`, PostToolUse output is sent to `/v1/guard/analyze` with `source: 'tool_output'`. |
| `policy.credential_protection` | `true` / `false` | When `true`, the hard-coded credential path deny list (§7.11) is enforced. Default `true`. |
| `policy.fatigue_cap_per_session` | integer | Max number of ask-dialogs per session before further `ESCALATE` outcomes auto-convert to `HARD_TAINT` (§7.9). Default `3`. |
| `policy.session_idle_ttl_hours` | integer | Background GC removes session entries idle longer than this. Default `24`. |

**`analyze_output` is not `log_output`** — it means "submit to VGE detection pipeline". The sidecar never persists raw tool content locally, consistent with VGE's own `storePromptContent` / `agentContextLoggingEnabled` separation.

**Defaults rationale.** Developer-essential tools (`Bash`, `Read`, `Grep`) default to `gate: allow + analyze_output: true` so the user is not blocked from working but VGE sees content for after-the-fact session tainting. `Glob` is path-only output and ships with `analyze_output: false` to avoid noise. `Write` and `Edit` default to `gate: block` because their semantics are "Claude is changing code" — the user should consciously enable them per project. `Task` defaults to `gate: allow` because sub-agents inherit the master's policy and their individual tool calls are independently gated. Unknown / custom MCP tools fall through to `*: ask`.

---

## 6. Phase 1 Implementation Phases

### 6.1 Phase 1a — MVP (3–4 weeks)

End state: a user runs `npm install -g vge-cc-guard`, then `vge-cc-guard install`, then `vge-cc-guard config`, then opens Claude Code and the full feature set is active.

- [ ] **Repo rename** `vge-agent-guard` → `vge-cc-guard` (manual: `gh repo rename`, update remote URL, rename local checkout, update `package.json`).
- [ ] `package.json` with `"bin": { "vge-cc-guard": "dist/cli.js" }`, TypeScript build, vitest, eslint.
- [ ] Shim: `vge-cc-guard hook <event>` reads CC payload from stdin, talks to daemon over Unix socket at `~/.vge-cc-guard/daemon.sock`, exits 2 on transport failure.
- [ ] Lazy daemon auto-start by shim when socket missing (§7.13).
- [ ] Daemon: Express HTTP over Unix socket, hot config reload via `fs.watch`.
- [ ] Tool policy resolver from `~/.vge-cc-guard/config.json` with object-form per-tool entries and `*` fallback.
- [ ] Session state machine `clean | caution | tainted`, in-memory, keyed by Claude Code `session_id`.
- [ ] Credential path deny list (§7.11) applied to `Read`, `Edit`, `Write` regardless of per-tool config.
- [ ] PreToolUse handler returning `hookSpecificOutput.permissionDecision`. Top-level `decision` never used for this event.
- [ ] PostToolUse handler — if `analyze_output: true`, dual-pass head+tail truncate (§7.6), POST to `/v1/guard/analyze` with `source: 'tool_output'`, on error log-and-continue.
- [ ] UserPromptSubmit handler — fire-and-forget POST `/v1/guard/input`. Reply parser (§7.9.1) when `pending_escalations` is non-empty.
- [ ] SessionStart / SessionEnd handlers.
- [ ] Confidence Router (§7.7).
- [ ] Ask Dialog mechanism: `permissionDecision: "deny"` with §7.9 reason text on next PreToolUse, prompt-reply parser to consume `once`/`session`/`block`/`quarantine`.
- [ ] Soft per-resource allowlist (§7.10), eager fsync on writes, `(tool_name, resource_id)` keying with canonicalisation table.
- [ ] Subagent inheritance (§7.12) — sub-agent sessions share state with master by reference.
- [ ] Local audit JSONL at `~/.vge-cc-guard/audit.log` for escalation lifecycle events (§7.9.2). 90-day retention, hard-coded.
- [ ] `vge-cc-guard install` — interactive prompt for scope (user-wide / project) and merge mode (merge / dry-run); pre-install snapshot for `uninstall`.
- [ ] `vge-cc-guard uninstall` — full revert: restore settings.json from snapshot, `rm -rf ~/.vge-cc-guard/`, with confirm prompt.
- [ ] `vge-cc-guard reset-session` — clears allowlist, pending queue, and fatigue counter for the active session.
- [ ] `vge-cc-guard config` TUI screens: API Keys, Tools Policy, Security Baseline, View Configuration (see [CONFIG_DESIGN](../../CONFIG_DESIGN.md)).
- [ ] Tests: unit (`tool-policy`, `session-state`, `confidence-router`, `reply-parser`, `path-deny`, `allowlist`, `truncate`), integration (shim ↔ daemon roundtrip, install/uninstall, golden CC fixtures, escalation flow).

### 6.2 Phase 1b — Resilience (1–2 weeks)

- [ ] VGE client: exponential backoff on transient failures, 3 retries, 5 s total ceiling.
- [ ] Per-resource VGE response cache, 5 min TTL, used only for re-analysis of the same content.
- [ ] Pino debug log at `~/.vge-cc-guard/debug.log` with rotation (50 MB per file, keep 5, 7-day TTL).
- [ ] Session-state persistence to `~/.vge-cc-guard/sessions/<id>.json`. Eager fsync on security-relevant writes (allowlist add, escalation enqueue, state transition); lazy 5 s write-behind on telemetry (last_activity, escalation_count read-only updates).
- [ ] Daemon survives 10-min VGE outage without crashing; PreToolUse latency unaffected.
- [ ] Re-attach to existing session state on daemon restart; lost in-flight VGE requests are reissued or dropped according to retry policy.
- [ ] Tests: error path coverage, cache hit/miss, truncation boundary, session persistence round-trip, daemon kill -9 mid-session followed by reconnect.

### 6.3 Phase 1c — Live Monitoring & Closed Beta Prep (2–3 weeks)

- [ ] TUI live-monitoring views: Events (tail of hook firings), Pending (ask-dialog queue with click-to-resolve in addition to prompt-reply), Audit (JSONL viewer with filters), Stats (decision histogram, p50/p99 latency, VGE health). See [CONFIG_DESIGN §9](../../CONFIG_DESIGN.md).
- [ ] `vge-cc-guard install --project` flag for project-scoped installs.
- [ ] End-to-end test: `WebFetch` → VGE flag → ask-dialog → user replies `session` → next `WebFetch` on same URL passes through allowlist with `userAllowlisted: true` metadata and local audit `enforcement_taken: none`.
- [ ] End-to-end test: tainted session denies `Bash` even when default config allows it.
- [ ] End-to-end test: credential path deny list refuses `Read("~/.aws/credentials")` regardless of per-tool config.
- [ ] Closed-beta packaging: pre-release npm tag `vge-cc-guard@0.9.0-beta.x`, internal feedback collection, bug-fix iteration before `1.0.0` GA.

---

## 7. Phase 1 Design Decisions

### 7.1 Language Choice — TypeScript (Node.js) ✅ DECIDED

**Decision:** TypeScript + Node.js via npm distribution.

**Rationale:**
1. **npm distribution** (critical advantage):
   - `npm install -g vge-cc-guard` — single command, works everywhere
   - Auto cross-platform (macOS, Linux, Windows, Docker)
   - Easy updates (`npm update -g`)
   - Aligns with VGE team's package ecosystem

2. **Consistency with VGE:**
   - VGE codebase entirely in TypeScript
   - Team expertise already present
   - Easier code sharing and maintenance

3. **Latency (50ms p99 achievable):**
   - Sidecar is separate Node.js process (isolated from VGE API)
   - Tunable GC: fixed heap size, manual GC triggers
   - Node.js flags: `--max-old-space-size=512 --expose-gc`
   - Expected latency: 20-40ms typical, <50ms p99

4. **Development speed:**
   - Fast iteration (not slower than VGE development)
   - Rich npm ecosystem (vitest, pino, express, regexp-tree)
   - Familiar testing patterns

**Alternatives rejected:**
- **Go:** Would require separate binary distribution (GitHub releases, homebrew, apt) — too complex for npm-based workflow
- **Rust:** Best performance, but 2-3x slower development; npm distribution not idiomatic
- **Python:** Latency 300-500ms — exceeds 50ms requirement

**Implementation:** Phase 1a uses TypeScript end-to-end. With local content detection removed (§7.2), the daemon's hot path is a hash-map lookup plus four boolean checks; GC latency is not on the risk register. Native modules or partial Rust ports remain a Phase 2+ option only if profiling on the audit/IPC paths surfaces a real bottleneck.

### 7.2 Detection Model — VGE-Only ✅ DECIDED

The sidecar runs **no local content detection**. There are no regex pattern files, no ReDoS-safe libraries, no risk-score arithmetic, no cached pattern hits per prompt. This was an explicit reversal of the original concept-doc design.

**Why removed:**

1. **Duplication of effort.** VGE already runs heuristics, semantic, llm-guard, content moderation, scope drift, and PII detection. A second-rate local pattern set could only be a worse copy.
2. **Maintenance burden.** Curating a pattern set across all relevant attack classes (prompt injection, command injection, credential exfil, etc.) is a project on its own. The team's leverage is in VGE detection, not in maintaining a parallel sidecar pattern catalogue.
3. **Audit trail integrity.** Routing every tool output through VGE preserves a unified detection log. Local-only decisions break that loop.

**What replaces it on the critical path:**

PreToolUse decisions come from a fixed, deterministic ordering:

1. Credential path deny list (§7.11). Always denies Read/Edit/Write on protected paths.
2. Pending escalation in queue → deny.
3. `(tool_name, resource_id)` in allowlist → allow.
4. Session state == `tainted` AND tool ∈ {Bash, Write, Edit, Task} → deny.
5. Per-tool `gate` from config → permissionDecision.

This is a hash-map lookup plus four boolean checks. It runs in microseconds; the latency floor is the shim cold start, not anything the daemon does.

**Implication for acceptance criteria.** False-positive and false-negative rates (the original §8 #2 #3) are now VGE's responsibility. The sidecar's acceptance criteria become enforcement-correctness statements: "deny means deny", "allowlist is honoured", "tainted state denies risky tools", etc. See revised §8.

### 7.3 Session State Scope

- **Scope:** per Claude Code session (not global across user's machine)
- **Lifetime:** created at SessionStart, destroyed at SessionEnd
- **Shared state:** session state enum (`clean | caution | tainted`), allowlist, pending escalations, escalation count. The sidecar tracks no risk score; the enum is the only state the router transitions.
- **Not shared:** between projects or Claude Code instances

### 7.4 Tool Policy Defaults

Configurable through `vge-cc-guard config`. The shipped defaults (§5.1) are biased toward "let the developer work without friction; let VGE see content for after-the-fact session tainting":

- `gate: allow + analyze_output: true` — Bash, Read, Grep, WebSearch, WebFetch
- `gate: allow + analyze_output: false` — Glob, Task
- `gate: block + analyze_output: false` — Write, Edit
- `gate: ask + analyze_output: false` — anything matching `*` (unknown / custom MCP)

Per-project override via `<project>/.claude/.vge-cc-guard.json` is **deferred** — Phase 1 supports user-wide config plus the explicit `--project` install scope (which controls only hook registration, not policy). A per-project policy file is a Phase 1c follow-up if there is demand.

### 7.5 Tool Output Analysis — Endpoint and Defaults ✅ DECIDED

**Endpoint:** `POST /v1/guard/analyze` with `source: 'tool_output'`.

**Why not `/v1/guard/output`:** That endpoint is semantically for `model_output` and hardcodes `source: 'model_output'` internally (VGE `guard-output.ts:27`). Using it for tool results would set the wrong `source` field. VGE `/v1/guard/analyze` already accepts and propagates `source: 'tool_output'` for contract compatibility and future source-aware policy work. Current VGE scoring and rule evaluation do not branch on `source`, so Phase 1 must not depend on source-specific VGE behavior.

**Default `analyze_output` by category** (Phase 1a — restrictive defaults, design lock 2026-04-26):

| Category | Tools | Default | Rationale |
|---|---|---|---|
| External/network | WebSearch, WebFetch | `true` | Primary vector for indirect prompt injection. |
| Code execution | Bash | `true` | Bash output frequently carries external content (`curl ... \| jq`, `gh pr view`, etc.). The cost is more VGE traffic, accepted as the safer default. |
| Filesystem read | Read, Grep | `true` | Attacker-controlled files (cloned repos, downloaded artifacts, PR diffs) can carry injections. Read of `.env` is blocked separately by §7.11. |
| Filesystem path-only | Glob | `false` | Glob returns file names, not contents. Nothing for VGE to analyse. |
| Filesystem write | Write, Edit | `false` (and `gate: block`) | Output is content Claude itself produced. The risk vector is not detection, it's the write happening at all — handled by `gate: block`. |
| Sub-agents | Task | `false` | The Task tool's "output" is the sub-agent's final message; the sub-agent's actual tool calls each go through their own hook. Inheritance handles trust propagation (§7.12). |
| Unknown / custom MCP | `*` | `false` | Unknown MCP may be a local DB, k8s, or secret manager. Enabling by default risks sending sensitive data to VGE and generating noise. User classifies explicitly via TUI. |

**`analyze_output: false` is a documented gap, not a security guarantee.** Operators with stricter requirements enable it per tool in the TUI. Defaults aim at "less-aware users get safe defaults; more-aware users dial it down to taste".

### 7.6 VGE Payload Limits and Fail-Mode

VGE enforces the following limits (from `packages/shared/src/schemas/index.ts:86`):

| Field | Limit |
|-------|-------|
| `text` | 100,000 characters |
| `tool.result.content` | 64 KB |
| `conversation` | 256 KB total |

**Sidecar behavior:**

- Put the text to be analysed in `GuardAnalyzeRequest.text` and apply **dual-pass head+tail truncation** when over 100 000 chars: keep the first 50 000 chars, insert a marker line `[truncated middle, original was N chars]`, append the last 50 000 chars. Total stays under the limit, and attacks that hide in the tail of long content are still seen by VGE. This mirrors VGE's own llm-guard dual-pass strategy ([`services/llm-guard/src/onnx_inference.py:85-202`](../../../../../Vigil-Guard-Enterprise/services/llm-guard/src/onnx_inference.py#L85-L202)).
- Include structured `tool.result.content` only when it adds value for typed logging; cap its serialized size at 64 KB independently of `text`. Do not reduce the primary detection `text` to 64 KB just because the optional typed result field has a lower limit.
- If tool output is binary (sniff first 8 bytes for known magic numbers — PNG, PDF, ZIP, etc.), send `text: "[binary content, sha256=<hex>, len=<N>]"` and omit `tool.result.content`.
- On VGE analysis error (timeout, 4xx, 5xx): **log and continue**. The tool already ran; the next tool is not blocked because of an analysis failure. Session state is not updated on error.
- This fail-mode is intentional: analysis errors must not degrade Claude Code usability.

### 7.7 Confidence Router (Layer 1)

Runs on every successful `GuardResponse` from PostToolUse analysis. Deterministic, no network calls. The router is a sidecar enforcement reducer, not a replacement for VGE's final decision.

**Hard VGE policy pre-check (evaluated before branch counting):**

```
if response.ruleAction == "BLOCK"              -> HARD_TAINT
if response.decision == "BLOCKED" and
   response.ruleAction is absent               -> HARD_TAINT
if response.failOpen == true or
   decisionFlags contains *_DEGRADED or
   decisionFlags contains API_TIMEOUT          -> SOFT_TAINT
if response.decision == "SANITIZED"            -> SOFT_TAINT
```

Rationale: VGE's `ruleAction`, `decisionFlags`, content moderation, scope drift, language blocking, length guards, and fail-open/fail-closed paths are already part of the existing API contract. The sidecar must not bypass those final policy outcomes by looking only at branch scores. `SANITIZED` is not prompt-injection proof of compromise, but it is still a caution signal for a tool-output session.

**Branch trigger thresholds:**

| Branch | Counts as "triggered" if score ≥ |
|--------|-----------------------------------|
| `heuristics` | 50 |
| `semantic` | 50 |
| `llmGuard` | 55 |

**Routing rules (evaluated top to bottom):**

```
agreed_branches = count(core prompt-injection branches where score >= branch_threshold)

if agreed_branches >= 2                      → HARD_TAINT
if agreed_branches == 1 and total_score >= 90 → HARD_TAINT  (high-score safety guard)
if agreed_branches == 1 and total_score 55..89 → ESCALATE   (layer 2)
if agreed_branches == 1 and total_score < 55  → SOFT_TAINT (caution, no block)
if agreed_branches == 0                      → ALLOW       (log only)
```

**Rationale:**

- `agreed_branches >= 2` follows the same design principle as VGE's corroborated LLM Guard veto, while using sidecar-specific thresholds for post-tool FP routing. It does not claim to reproduce VGE scoring exactly.
- The score-90 safety guard catches extreme single-branch signals (e.g., `llmGuard=95` on a clearly malicious payload) that should not be routed through user approval.
- The 55-89 single-branch band is the FP-prone zone for cybersec content, so the user decision path gets a chance before the session is treated as compromised.
- `agreed_branches == 0` means VGE did not trigger any branch above its threshold; sidecar logs and moves on.

**State transitions emitted by router:**

| Router outcome | Session state effect |
|----------------|----------------------|
| `HARD_TAINT` | → `tainted` (blocks next tool) |
| `SOFT_TAINT` | → `caution` (boosts next threshold) |
| `ESCALATE` | no change until layer 2/3 resolves |
| `ALLOW` | no change |

### 7.8 (removed — Educational Context Detector)

Previously considered as a local-heuristics layer to reduce FP on cybersec educational content (URL allowlist + CVE/CWE regex + text markers). Rejected because:

1. Outside URL host allowlist (~95% precision on known domains), the remaining signals (path markers, text keywords like "tutorial" / "example") had estimated precision of 50–70%. They would duplicate VGE's semantic branch with lower quality and create a maintenance burden (who curates the word list?).
2. VGE's semantic + llm-guard branches already have full context and should be the authority for educational-vs-malicious classification. Fixes belong in VGE, not as bolt-on heuristics in the sidecar.
3. Removing this detector leaves one explicit trust mechanism (resource allowlist, section 7.10) instead of two overlapping local FP overrides.

Kept for historical reference. Not part of MVP.

### 7.9 Ask Dialog (Layer 2)

Runs when Layer 1 returns `ESCALATE`. PostToolUse already ran — we cannot undo it. The question is whether the *next* tool call should proceed on a potentially compromised session, and whether the user trusts this specific resource going forward.

**Mechanism (MVP — uses supported Claude Code hooks, no custom UI):**

1. Sidecar enqueues the escalation in `pending_escalations` (per-session FIFO). Payload includes `(tool_name, resource_id, branches, trigger_snippet, escalation_id)`.
2. The `PostToolUse` hook may return top-level `decision: "block"` with `reason` to give Claude feedback that the completed tool output is suspicious. This does not undo the tool execution.
3. On the next `PreToolUse` hook, sidecar checks the queue. If non-empty, it short-circuits the normal gate decision and returns `hookSpecificOutput.permissionDecision: "deny"` with `permissionDecisionReason` containing the formatted dialog below.
4. Claude Code does not execute that tool call. The reason is surfaced by Claude Code according to its hook behavior. Pending escalation blocks subsequent tool calls until resolved.
5. User replies in the next prompt. Sidecar parses the reply in `UserPromptSubmit` (see 7.9.1).
6. Sidecar applies the decision, emits a local audit event (see 7.9.2), and pops or keeps the queue according to the decision. If the user accepted, they can ask Claude to continue; Phase 1 does not replay the denied tool call automatically.

**No timeout.** The sidecar keeps the pending escalation until the user resolves it, SessionEnd fires, TTL cleanup removes the session, or `reset-session` is run. There is no timer and no auto-decision on elapsed time. Rationale: automated decisions on timeout either default to `block` (degrades UX for FPs) or `allow` (silently accepts real attacks). Neither is acceptable. A pending escalation halts tool execution.

**Ambiguous reply → re-ask, not auto-block.** If the first token of the user's prompt doesn't match the decision vocabulary, `UserPromptSubmit` returns top-level `decision: "block"` with a reason that asks the user to use one of: `once` / `session` / `block` / `quarantine`. The ambiguous prompt is erased from Claude context and the escalation stays pending.

**Dialog format (used as `permissionDecisionReason` / prompt-block `reason`):**

```
VGE Agent Guard: tool output flagged by VGE. Decide before continuing.

  Tool:     WebFetch
  Resource: https://example.com/blog/xss-tutorial
  Score:    72  (single-branch: semantic=72)
  Trigger:  "...<120-char excerpt around the trigger>..."

  Why asking: VGE flagged this on a single branch (not corroborated).
  Single-branch signals are FP-prone in educational cybersec content.

  Reply:
    once        — accept this result once; ask again if this exact
                  (tool, resource) triggers again
    session     — accept + trust THIS specific resource for the rest
                  of the session. Future analyses still run and are
                  logged for audit, but sidecar takes no action on
                  them
    block       — reject this resource; keep the session tainted until
                  reset or SessionEnd
    quarantine  — accept but keep session on caution for 3 turns
```

**Approval fatigue protections:**

- Max 3 ask-dialogs per session. After cap, further `ESCALATE` outcomes auto-convert to `HARD_TAINT` with audit flag `auto_hard_tainted_due_to_fatigue_cap=true`.
- Dedup: `session` decisions add the exact `(tool_name, resource_id)` to the allowlist and suppress future prompts for that key. `once` decisions resolve only the current escalation; if the same key triggers again later, ask again. Different resources always ask separately even if same tool.
- User escape hatch: `vge-cc-guard reset-session` clears the counter, queue, and allowlist.

**Phase 2 upgrade path:** replace the prompt-reply flow with a dedicated Unix socket + TUI prompt (`vge-cc-guard prompt`) or a non-interactive `permissionDecision: "defer"` flow for SDK/`claude -p` integrations. `defer` is not an interactive-session primitive for MVP.

### 7.9.1 Reply Preprocessing

Parser runs on `UserPromptSubmit` **only when** `pending_escalations` is non-empty. Otherwise prompt flows normally to detection.

**Vocabulary:**

| Decision | Primary keyword | Aliases |
|----------|-----------------|---------|
| `once` | `once` | `o`, `allow once` |
| `session` | `session` | `s`, `allow session`, `always` |
| `block` | `block` | `b`, `no`, `deny`, `stop`, `discard` |
| `quarantine` | `quarantine` | `q`, `caution` |

Bare `allow` without modifier → ambiguous → re-ask (forces user to pick `once` or `session` explicitly).

**Pipeline:**

1. Lowercase and trim the prompt.
2. Extract first alphanumeric token (max 20 chars).
3. If token is `allow` + next token is `once`/`session` → map to the respective decision.
4. Else single-token match against vocabulary (exact, not prefix).
5. If no match, `UserPromptSubmit` blocks the prompt with top-level `decision: "block"` and a `reason` asking for one of the valid decision tokens. The unresolved prompt is not added to Claude context.
6. If match has residual text after the decision token(s), the residual is treated as the user's actual prompt and goes through normal `/v1/guard/input` detection. The decision token itself is **not** sent to VGE as user content — only as a local audit event (see 7.9.2).

**Attack-in-reply handling:** residual prompt is independently analyzed by VGE. Accepting the decision does not imply accepting the residual's content. If residual triggers a new detection, standard flow applies (new Confidence Router evaluation, potential new escalation).

**Session mismatch protection:** sidecar verifies `session_id` on the incoming hook matches the queued escalation's session. Mismatch (e.g., Claude Code restarted between dialog and reply) → queue is flushed for the new session; parser is a no-op; prompt flows normally.

### 7.9.2 Audit Trail for Escalation Decisions

Every stage of the escalation lifecycle emits a **local** audit event. The decision token itself is never sent to `/v1/guard/input` — it is only captured in the sidecar audit log.

**Event types:**

```jsonc
// Phase 1: flagged by VGE, escalation created
{
  "event_type": "tool_output_escalated",
  "escalation_id": "esc_abc123",
  "session_id": "sess_xyz",
  "tool_name": "WebFetch",
  "resource_id": "https://example.com/blog/post",
  "analysis_id": "<id from GuardResponse>",
  "branches": { "semantic": 72, "heuristics": 0, "llm_guard": 0 },
  "router_outcome": "ESCALATE"
}

// Phase 2: user decision captured
{
  "event_type": "escalation_resolved",
  "escalation_id": "esc_abc123",
  "session_id": "sess_xyz",
  "decision": "once" | "session" | "block" | "quarantine",
  "decision_source": "user",
  "resolution_delay_ms": <time between escalation and reply>
}

// Phase 3: subsequent allowlisted pass-throughs
{
  "event_type": "tool_output_analyzed",
  "session_id": "sess_xyz",
  "tool_name": "WebFetch",
  "resource_id": "https://example.com/blog/post",
  "user_allowlisted": true,
  "router_outcome": "HARD_TAINT" | "ESCALATE" | "ALLOW",
  "enforcement_taken": "none"
}
```

**Delivery:** local JSONL only in Phase 1 (`~/.vge-cc-guard/audit.log`). There is no VGE `/v1/audit/events` dependency and no synthetic audit-only POST to `/v1/guard/analyze`, because that would pollute detection analytics.

**What VGE receives through existing contracts:**

- User prompts still POST to `/v1/guard/input`.
- Tool outputs still POST to `/v1/guard/analyze` with `source: "tool_output"` when `analyze_output: true`.
- The sidecar attaches existing typed fields (`agent`, `tool`, `conversation`) and a bounded `metadata.vgeAgentGuard` block with exactly five investigation hints, all knowable at request time:

```json
{
  "metadata": {
    "platform": "claude-code",
    "vgeAgentGuard": {
      "resourceId": "https://example.com/blog/post",
      "userAllowlisted": true,
      "escalationId": "esc_abc123",
      "subagent": false,
      "parentSessionId": null
    }
  }
}
```

Field semantics:

| Field | Type | Meaning |
|---|---|---|
| `resourceId` | string | Canonicalised resource identifier (URL, file path, hash) — see §7.10 table. |
| `userAllowlisted` | boolean | `true` if the call is hitting the soft allowlist; sidecar will take no enforcement action regardless of VGE response. |
| `escalationId` | string \| null | Set when this request is reprocessing a previously-flagged resource; links cross-request investigation. |
| `subagent` | boolean | `true` if the call originates in a sub-agent session inheriting from a master. |
| `parentSessionId` | string \| null | Master session id when `subagent: true`. |

Notably **not** sent in metadata: `routerOutcome` and `enforcementTaken`. Those are derived after the VGE response is reduced by the Confidence Router, so they can only exist locally; they live in the audit JSONL only.

The metadata block is best-effort investigation help. The authoritative escalation lifecycle is the local JSONL audit log. A future PRD may promote some of these fields to a VGE-side contract, at which point this section's payload shape becomes the de-facto schema.

**Why this matters:**

- Local investigation can show full chain: `flagged → escalated → resolved=user_allow → 5 subsequent pass-throughs all ALLOW`.
- VGE Investigation can still show the underlying detection events when existing agent/tool context logging is enabled for the API key's rule set.
- Whitelisted-pass-through events remain visible locally even when enforcement is suppressed for the session.

### 7.9.3 Session Lifecycle

Claude Code provides `session_id` (UUID) in every hook payload. The sidecar uses this as the authoritative session identifier.

**Lifecycle:**

```
SessionStart hook
    → sidecar creates session_store[session_id] = {
        created_at, last_activity, state: clean,
        allowlist: Set<(tool, resource_id)>,
        pending_escalations: Queue,
        escalation_count: 0
      }

Every subsequent hook (same session_id)
    → route to session_store[session_id]
    → update last_activity

SessionEnd hook
    → flush audit log + pending queue
    → delete session_store[session_id]
```

**Edge cases:**

| Situation | Behavior |
|-----------|----------|
| SessionEnd never fires (crash, kill -9) | Background task garbage-collects entries idle for > 24h |
| Sidecar restarts mid-session | In-memory state lost; user re-asked on next trigger. Phase 1b adds `~/.vge-cc-guard/sessions/<id>.json` persistence |
| Multiple concurrent CC sessions on same machine | Each has unique `session_id`, separate allowlists, no cross-session trust leakage |
| Restart of Claude Code in same terminal | New `session_id`, fresh allowlist. Previous session's trust does not carry over |

### 7.10 Resource Allowlist (Session-Scoped, Soft)

Populated exclusively by the `session` decision in the ask dialog. Admin-side configuration (`analyze_output`, `gate`) lives in the config file and is never changed by dialog interactions.

**Key structure:** `(tool_name, resource_id)` exact match. No host-level trust, no path globs, no subdomain patterns. Different URL from same host = different entry = separate decision required.

**`resource_id` canonicalization:**

| Tool | `resource_id` |
|---|---|
| `WebFetch` | Full URL (scheme + host + path + query), fragment `#` stripped. Tracking params (`utm_*`, `fbclid`, `ref`) stripped (Phase 1c). |
| `WebSearch` | The verbatim search query string. |
| `Read` | Absolute canonical path (resolves `~`, symlinks, `..`). |
| `Glob` | `<pattern>:<cwd-absolute>`. |
| `Grep` | `<pattern>:<cwd-or-path-absolute>`. |
| `Bash` | `bash:<sha256>` where the hash input is the lowercase, whitespace-normalised command string. Showing the first 12 hex chars in dialogs. |
| `Edit` | `<absolute_path>:edit:<sha256(old_string)>`. Different diffs on the same file create separate entries. |
| `Write` | `<absolute_path>:write:<sha256(content)>`. |
| `Task` | `task:<subagent_type>:<sha256(prompt)>`. |
| MCP / custom / `*` | `<tool_name>:<sha256(canonicalised JSON input)>`. Canonicalisation sorts keys and strips volatile fields (timestamps, request IDs, session IDs). |

In dialog text the hashed identifiers are shown as `<tool>:<first-12-hex-chars>...` so they fit on a line. The full hash is in the audit JSONL.

**Behavior on match (soft allowlist — this is the critical design point):**

When a PostToolUse hits an allowlisted `(tool, resource_id)`:

1. Sidecar still POSTs to `/v1/guard/analyze` (VGE receives full content for telemetry).
2. Sidecar still runs Confidence Router (full branch analysis).
3. Local audit event is written with `user_allowlisted=true`, `router_outcome=<actual>`, `enforcement_taken=none`.
4. **No session state change** — even if router returns `HARD_TAINT`, sidecar does not taint.
5. **No ask-dialog** — user already decided for this resource.
6. Tool output flows to Claude Code normally.

Rationale: user's conscious trust decision is final for the duration of the session. But the telemetry is preserved — VGE analytics continue to see whether allowlisted resources remain benign over time, and investigation can flag compromised-CDN-style scenarios post-hoc.

**Why not skip VGE entirely:** silent trust is a blind spot. An allowlisted resource that starts returning attacks would otherwise go completely unmonitored until SessionEnd. Soft allowlist keeps the observation loop intact without re-bothering the user.

**Scope:** session-only for MVP. No project-level or user-level persistence. Justification: allowlist entries are granular (per-resource), so persistent storage would accumulate stale entries quickly and lose meaning. Session scope matches the granularity.

**Approval fatigue interaction:** allowlist check runs before escalation-cap accounting. Already trusted resources do not consume the cap. New `ESCALATE` outcomes after the cap auto-convert to `HARD_TAINT`; user must `reset-session` to resume adding entries.

**Reset:** `vge-cc-guard reset-session` clears the allowlist alongside pending queue and escalation counter.

### 7.11 Credential Path Protection

The sidecar refuses tool calls whose path argument matches the credential deny list, regardless of per-tool config or session state. This is **not** pattern-based content matching — it's a static path-glob check that runs before any other PreToolUse logic.

**Applies to:** `Read`, `Edit`, `Write`. Future tools that take a path argument (file-read MCP servers, etc.) join automatically by tool-name allowlist on the path-deny-evaluator.

**Deny list (hard-coded):**

- `~/.env`, `*/.env`, `*.env` (any depth)
- `~/.ssh/*` (anything under `.ssh/`)
- `~/.aws/credentials`, `~/.aws/config`
- `~/.kube/config`
- `~/.config/gcloud/*`, `~/.gcp/*`
- `id_rsa*`, `id_ed25519*`, `id_ecdsa*` (file basename match)
- `*credentials*`, `*secrets*` (basename match, case-insensitive)

Path resolution: tilde expansion, `..` collapsing, and symlink resolution all happen before matching, so `Read("$HOME/.aws/../.aws/credentials")` and `Read("/Users/me/.aws/credentials")` are both denied.

**Toggle:** `policy.credential_protection: true` (default). The TUI Security Baseline screen (CONFIG_DESIGN §6) is the supported way to flip it. Disabling requires explicit confirmation; the configurator displays the deny list and a red warning before committing the change.

**On match:**

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "VGE Agent Guard: <path> is on the credential protection deny list. Disable in `vge-cc-guard config` → Security Baseline if you have a specific reason."
  }
}
```

**Audit:** every match writes a `credential_path_denied` event to the JSONL with the resolved path, the toggle state, and the originating Claude Code session id.

**Why this lives in the sidecar, not VGE.** VGE has no way to know that `~/.aws/credentials` on this machine is sensitive. Path semantics are local. Hard-coding the list (rather than treating it as a pattern detector) keeps the implementation small (~30 LOC) and free of regex / pattern-matching complexity.

### 7.12 Subagent Inheritance

Claude Code spawns sub-agents through the `Task` tool. Each sub-agent runs in its own session with a unique `session_id` and its own hook events. By default they would be unrelated to the master from the sidecar's point of view.

Phase 1 makes them relate. When `SessionStart` fires for a session whose CC payload identifies it as a sub-agent of an existing session (via `parent_session_id` in the hook payload, when present), the sidecar:

1. Looks up the master session in `session_store`.
2. Sets `session_store[subagent_session_id] = sessionStateOf(master)` — a **shared reference**, not a copy.

Effect:

- The sub-agent sees the master's allowlist immediately. A `session` decision the user made earlier in the master applies to the sub-agent's tool calls on the same resource.
- If the master is `tainted`, the sub-agent starts `tainted`.
- The sub-agent's `escalation_count` is the same counter as the master's; the fatigue cap (default 3) covers the master + all sub-agents collectively.
- Pending escalations are visible to both. A reply in either session resolves the same queue.

When the master session ends, sub-agent sessions that pointed at it become orphaned. They are cleaned up by the 24 h TTL GC like any other session.

**Why shared reference, not copy.** A copy would diverge — the user could trust a resource in the master, the sub-agent would still ask. Shared reference matches the user's mental model: "I trusted this once, it's trusted everywhere in this work."

**Detection:** the CC hook payload field that identifies a sub-agent and its parent is documented behaviour for the `Task` tool. If a future Claude Code release changes the field name, the sidecar's session-bootstrap logic falls back to "treat as independent session" and logs a warning to the debug log — sub-agents become independent rather than the daemon crashing.

### 7.13 Transport & Lifecycle ✅ DECIDED

**Transport: command shim → Unix socket → daemon.** Hooks in `~/.claude/settings.json` are command-style entries pointing at `vge-cc-guard hook <event>`. The shim:

1. Reads the Claude Code hook payload from stdin.
2. Connects to `~/.vge-cc-guard/daemon.sock`.
3. Sends the payload, awaits the JSON reply, writes it to stdout.
4. Exits 0 on success, 2 on transport failure.

Exit code 2 propagates to Claude Code as fail-closed for `PreToolUse` (Anthropic-documented behaviour). PostToolUse and UserPromptSubmit are already non-critical, so transport failure there only loses telemetry.

**Why not direct HTTP hooks?** Claude Code's HTTP hook failures are documented as **non-blocking** — a dead daemon would silently allow every tool call. Command-style hooks let us choose the failure mode via exit code, which is the only way to make `PreToolUse` truly fail-closed.

**Why not bare command hooks (no daemon)?** Each hook would need to spin up a Node.js process from scratch (~150–300 ms cold start). On a busy session that blows the latency budget. The shim pays a much smaller cold-start (no large dependency tree to load) and the daemon does the heavy work in a single long-lived process.

**Lifecycle: lazy auto-start, no service registration.**

- The first hook of a session finds no socket. The shim `fork`s the daemon detached, waits up to 1 s for the socket to appear, then proceeds.
- The daemon stays alive across the user's shell session and across multiple Claude Code sessions.
- The daemon shuts down naturally when the user logs out (parent process tree dies). There is no launchd plist, no systemd unit, no Windows service — Phase 1 ships zero platform-specific service code.
- Phase 1c may add an opt-in `--service` flag to `vge-cc-guard install` for power users who want the daemon to outlive their shell, but this is not in MVP.

**State persistence (hybrid):**

- **Eager fsync** on writes that affect security decisions: allowlist add, pending escalation enqueue/dequeue, state transitions (`clean → caution → tainted`), credential-path-protection toggle.
- **Lazy write-behind** (5 s coalesce) for telemetry: `last_activity`, idempotent counter reads, debug-only fields.
- File: `~/.vge-cc-guard/sessions/<session_id>.json`. On daemon restart, files are reloaded into the in-memory store; sessions older than `policy.session_idle_ttl_hours` are GC'd at load time.

This gets us crash-tolerance for the bits that matter (a `kill -9` between user's `session` decision and the next tool call still honours the trust) without spending fsync on every keystroke-equivalent.

---

## 8. Phase 1 Acceptance Criteria

Numbered for cross-reference. False-positive and false-negative rate criteria from the previous revision are removed: those are now VGE's responsibility, since the sidecar runs no local content detection (§7.2).

1. **PreToolUse latency:** p99 < 50 ms end-to-end (Claude Code → shim → daemon → response). Achievable target with no critical-path VGE call. Measured with fixtures, not in production.
2. **PreToolUse decision ordering:** strictly applies the §4.1 step list in order. Test fixtures exercise each priority level (credential deny > pending escalation > allowlist > tainted-state > config gate).
3. **Tool gating:** `PreToolUse` returns supported `hookSpecificOutput.permissionDecision` values. Top-level `decision` is never used for `PreToolUse`. `deny` prevents tool execution; `allow` lets the tool run; `ask` is used only for ordinary tool-policy approval.
4. **Credential path protection:** any `Read`/`Edit`/`Write` whose resolved path matches the §7.11 deny list returns `permissionDecision: "deny"` regardless of per-tool config or session state, when `policy.credential_protection: true`. Audit event written.
5. **Subagent inheritance:** sub-agent sessions share state by reference with the master (§7.12). A `session` decision in the master is honoured by sub-agent calls on the same resource without re-asking.
6. **Session state transitions:** `clean → caution → tainted` deterministic from Confidence Router outcomes (§7.7). Tainted sessions deny `Bash`/`Write`/`Edit`/`Task` regardless of per-tool `gate`.
7. **VGE endpoint correctness:** PostToolUse analysis uses `/v1/guard/analyze` with `source: 'tool_output'`. `/v1/guard/output` is never called for tool results.
8. **Payload truncation:** dual-pass head+tail truncation for `text > 100 000 chars` (§7.6). Optional `tool.result.content` capped at 64 KB serialised, independent of `text`. Binary outputs sent as hash placeholder. No 400 errors from oversized payloads.
9. **Analysis fail-mode:** VGE error on PostToolUse analysis → log-and-continue. No tool blocked, no daemon crash, no session-state mutation on error.
10. **VGE outage tolerance:** daemon survives 10-minute VGE outage without crashing. PreToolUse latency is unaffected by VGE availability.
11. **Confidence Router correctness:** no single-branch trigger under score 90 produces `HARD_TAINT`; ≥2 branches agreeing always produces `HARD_TAINT`. Hard VGE policy (`ruleAction == BLOCK`) overrides branch counting. Unit tests cover boundary cases (54/55, 89/90, single vs multi-branch).
12. **Ask dialog protocol:** pending escalation denies the next `PreToolUse` with `permissionDecision: "deny"` and §7.9 reason text. User reply parsed for `once`/`session`/`block`/`quarantine` and aliases (§7.9.1). Ambiguous replies block the prompt and re-ask. No timeout — pending escalation remains until resolved, `reset-session`, or `SessionEnd`.
13. **Reply preprocessing correctness:** decision token never reaches `/v1/guard/input`. Residual prompt after the decision token is independently analysed. Session-id mismatch voids queued escalation safely.
14. **Resource allowlist semantics:** allowlist key is `(tool_name, resource_id)` with §7.10 canonicalisation. `session` decision adds to allowlist; `once` does not. Allowlist is session-scoped only.
15. **Soft allowlist pass-through:** allowlisted `(tool, resource_id)` still triggers VGE analysis and Confidence Router for local audit, but produces no enforcement action. Audit events carry `user_allowlisted: true` and `enforcement_taken: none`. Session state does not transition on allowlisted pass-throughs.
16. **Audit trail completeness:** every escalation lifecycle stage (flagged → resolved → subsequent allowlisted pass-through) writes a JSONL event sharing one `escalation_id`. No new VGE audit endpoint is called.
17. **Audit retention:** JSONL log at `~/.vge-cc-guard/audit.log`, hard-coded 90-day retention, daily rotation file `audit.log.YYYY-MM-DD`. No size-based rotation in Phase 1.
18. **Approval fatigue cap:** after `policy.fatigue_cap_per_session` dialogs (default 3), further `ESCALATE` outcomes auto-convert to `HARD_TAINT` with `auto_hard_tainted_due_to_fatigue_cap: true`. `reset-session` clears counter, queue, and allowlist.
19. **Session lifecycle:** `session_id` from CC hooks is the authoritative key. `SessionStart` creates state, `SessionEnd` flushes and deletes. 24 h idle TTL GC for orphaned sessions. Concurrent sessions don't share allowlists across master tree boundaries.
20. **Transport & lifecycle (§7.13):** shim exits 2 on socket failure, `PreToolUse` is fail-closed via that exit code. Daemon lazy-starts on first hook of a session. Daemon shutdown (kill -9) followed by next-hook reconnect succeeds and restores allowlist + tainted state from `~/.vge-cc-guard/sessions/<id>.json`.
21. **Installer:** `vge-cc-guard install` interactively offers (a) merge vs dry-run, (b) user-wide vs project scope. Existing user hooks are preserved on merge. Pre-install snapshot taken once. `--apply` and `--dry-run` and `--scope` flags supported for non-interactive use.
22. **Uninstaller:** `vge-cc-guard uninstall` restores `~/.claude/settings.json` from the pre-install snapshot and deletes `~/.vge-cc-guard/`. Confirmation prompt with explicit warning. Idempotent (running twice is safe).
23. **Documentation:** README quickstart, installation flow, troubleshooting, dialog vocabulary, configuration reference all current and consistent with PRD_1.

---

## 9. Phase 1 Timeline

| Milestone | Duration | Deliverable |
|---|---|---|
| **Phase 1a (MVP)** | 3–4 weeks | Full sidecar feature set: shim+daemon, PreToolUse gating with credential path protection, PostToolUse analysis with Confidence Router, ask-dialog with `once`/`session`/`block`/`quarantine`, soft per-resource allowlist, subagent inheritance, audit JSONL, install/uninstall, TUI configurator (API Keys / Tools / Security Baseline / View). |
| **Phase 1b (Resilience)** | 1–2 weeks | VGE retry/backoff, response caching, debug log rotation, session-state persistence, error-path coverage. |
| **Phase 1c (Live Monitoring & Beta Prep)** | 2–3 weeks | TUI live-monitoring views (Events / Pending / Audit / Stats), `--project` install scope, end-to-end test suite, closed-beta release `0.9.0-beta.x`. |
| **Closed beta** | 2–3 weeks | Internal production environment, bug-fix iteration. |
| **`vge-cc-guard@1.0.0`** | ~7–10 weeks total | npm tagged release. |

---

## 10. Phase 1 vs Phase 0 Migration

### 10.1 For Users

When Phase 1 ships:

1. Run `vge-cc-guard install` (replaces Phase 0 hook)
2. Configure via `vge-cc-guard config` TUI
3. Tools are now gated; decisions logged; external tool outputs analyzed in VGE

**No breaking change:** Phase 0 hook continues to work indefinitely for users who don't upgrade.

### 10.2 For VGE

No changes needed on VGE side. Phase 1 sidecar:
- POSTs user prompts to `/v1/guard/input` (same as Phase 0)
- POSTs tool outputs to `/v1/guard/analyze` with `source: 'tool_output'` (corrected from Phase 0's `/v1/guard/output`)
- Uses existing typed `agent`, `tool`, `conversation`, and `metadata` fields for VGE-side detection context
- Stores escalation lifecycle locally in `~/.vge-cc-guard/audit.log`; no VGE audit endpoint is called in Phase 1

---

## 11. Resolved Design Questions

All open questions from previous revisions have been resolved during the 2026-04-26 design lock. They are recorded here for traceability.

1. **Session state across Claude Code restarts** → resolved by §7.13. Eager fsync on security-relevant writes; sessions survive daemon restart but not Claude Code restart (different `session_id`).
2. **VGE API key distribution** → resolved by §5.1 + CONFIG_DESIGN §4. Config file is the primary source; environment variables are a fallback for CI / Docker.
3. **Truncation strategy for structured tool output** → resolved by §7.6: dual-pass head+tail (50 k + marker + 50 k), no structure-aware parsing.
4. **Per-project `analyze_output` override** → deferred to a Phase 1c follow-up. Phase 1 supports user-wide policy plus per-project hook installation scope (`--project`); per-project policy file is not part of Phase 1.
5. **VGE metadata enrichment** → resolved by §7.9.2: five fields (`resourceId`, `userAllowlisted`, `escalationId`, `subagent`, `parentSessionId`). `routerOutcome` and `enforcementTaken` stay in local audit JSONL only because they cannot exist at request time.
6. **Ask-dialog channel upgrade** → MVP uses `PreToolUse.permissionDecision="deny"` plus `UserPromptSubmit` reply parsing. Phase 1c adds the TUI Pending view as an alternative resolution surface. Non-interactive `permissionDecision="defer"` for SDK / `claude -p` is deferred to Phase 2.
7. **Resource canonicalisation for WebFetch query params** → resolved by §7.10: strict match for MVP, with well-known tracking params (`utm_*`, `fbclid`, `ref`) stripped in Phase 1c. Full URL with fragment-stripped query is the MVP key.
8. **L1 heuristics** (introduced in this revision) → resolved by §7.2: dropped entirely. Sidecar is a router + state machine + audit orchestrator; VGE is the only content detector.
9. **Credential path protection** (introduced in this revision) → resolved by §7.11: hard-coded deny list, configurable on/off in TUI, default on.
10. **Subagent inheritance model** (introduced in this revision) → resolved by §7.12: shared reference, sub-agents see master state.
11. **Transport** (introduced in this revision) → resolved by §7.13: command shim → Unix socket → daemon, lazy auto-start.

---

## 12. References

- [Concept doc](../../architecture/claude-code-agent-security-integration.md) — original system vision (revision pointer to this PRD added 2026-04-26).
- [CONFIG_DESIGN.md](../../CONFIG_DESIGN.md) — canonical TUI configurator specification.
- [ADR-0001](../../adr/ADR-0001-project-scope-and-language.md) — language choice (TypeScript, accepted).
- Anthropic Claude Code Hooks reference: https://code.claude.com/docs/en/hooks
- VGE `guard-output.ts:27` — `source: 'model_output'` hardcoded; confirms why we use `/v1/guard/analyze` for tool output.
- VGE `docs/api/endpoints.md:258` — `/v1/guard/analyze` source field semantics.
- VGE `packages/shared/src/schemas/index.ts:86,143` — payload limits and source field schema.
- VGE `detection-pipeline.ts:260` — `agentContextLoggingEnabled` pattern (analyze vs. log separation).
- VGE `decision-pipeline-helpers.ts:382` — `storePromptContent` pattern.
- VGE `services/llm-guard/src/onnx_inference.py:85-202` — dual-pass head+tail inference (PRD_27); model for our truncation strategy.

---

## 13. Execution Plan

The plan below is the single source of truth for the build sequence. Each step has an explicit predecessor; nothing in a later step depends on something not yet committed. When this section says "we can start", it means the design is locked and the next person to pick up the keyboard does not need to ask another question.

### Step 0 — Repo rename (manual, ~10 min)

Cannot be done from inside a Claude Code session; the user runs:

```bash
gh repo rename vge-cc-guard                          # GitHub-side rename
git remote set-url origin git@github.com:Vigil-Guard/vge-cc-guard.git
mv ~/Development/vge-agent-guard ~/Development/vge-cc-guard
cd ~/Development/vge-cc-guard
git mv vg-cc/hooks vg-cc-legacy/hooks                # archive Phase 0 artefacts
```

After this step: `pwd` returns `.../vge-cc-guard`, `git remote -v` points at the renamed origin, and the local checkout is the canonical repo path.

### Step 1 — Project scaffold (1 day)

- `package.json` with `"name": "vge-cc-guard"`, `"bin": { "vge-cc-guard": "dist/cli.js" }`, Node 18+ engines.
- `tsconfig.json` (strict, ES2022, `outDir: dist`).
- ESLint + Prettier configs aligned with CLAUDE.md style rules.
- Vitest config, with `tests/unit/` and `tests/integration/`.
- `src/cli.ts` skeleton dispatching subcommands by argv.
- CI workflow `.github/workflows/ci.yml`: install, lint, typecheck, test on push and PR.
- `.gitignore` covering `dist/`, `node_modules/`, `~/.vge-cc-guard/` (paranoia in case someone runs `cp -r ~/ .`).

### Step 2 — Shared schema and IPC contract (1–2 days)

- `src/shared/config-schema.ts` — Zod schema for the full §5.1 file. Single source for daemon, TUI, and tests.
- `src/shared/types.ts` — domain types (`SessionState`, `Allowlist`, `Escalation`, etc.).
- `src/shared/ipc-protocol.ts` — request/response shapes for shim ↔ daemon, mirroring Claude Code hook events.

### Step 3 — Daemon core (3–4 days)

In dependency order so each module can be unit-tested before the next is written:

1. `src/daemon/tool-policy.ts` — load/validate config, `fs.watch` reload, `(tool_name) → resolved policy` accessor.
2. `src/daemon/path-deny.ts` — credential path resolver + matcher (§7.11).
3. `src/daemon/session-state.ts` — in-memory store, subagent shared-reference logic, eager fsync on security writes, lazy write-behind on telemetry.
4. `src/daemon/allowlist.ts` — `(tool_name, resource_id)` set with §7.10 canonicalisation.
5. `src/daemon/confidence-router.ts` — VGE GuardResponse → `HARD_TAINT / SOFT_TAINT / ESCALATE / ALLOW` (§7.7).
6. `src/daemon/reply-parser.ts` — `once / session / block / quarantine` and aliases (§7.9.1).
7. `src/daemon/ask-dialog.ts` — pending-escalation queue, dialog text formatter, fatigue cap.
8. `src/daemon/truncate.ts` — dual-pass head+tail (§7.6).
9. `src/daemon/vge-client.ts` — `/v1/guard/input` and `/v1/guard/analyze` clients with retry/backoff.
10. `src/daemon/audit-logger.ts` — JSONL writer with daily rotation.
11. `src/daemon/http-server.ts` — Express on Unix socket, hook routes wiring all of the above.

Each module has a sibling vitest file in `tests/unit/`. We do not move on from a module until its test file is green.

### Step 4 — Shim (1 day)

- `src/shim/index.ts` — stdin parse, Unix socket connect, await reply, stdout write, exit 0/2.
- `src/shim/lazy-start.ts` — detached `fork` of the daemon, 1 s socket-readiness wait.
- Integration test `tests/integration/shim-daemon.test.ts` round-trips a SessionStart payload end-to-end.

### Step 5 — TUI configurator (3–4 days)

Following [CONFIG_DESIGN](../../CONFIG_DESIGN.md):

- `src/tui/screens/MainMenu.tsx`
- `src/tui/screens/InstallWizard.tsx` (interactive `vge-cc-guard install`)
- `src/tui/screens/ApiKeys.tsx` (with `Test Connection`)
- `src/tui/screens/ToolsPolicy.tsx`
- `src/tui/screens/SecurityBaseline.tsx`
- `src/tui/screens/ViewConfig.tsx`
- `src/tui/strings.ts`

Snapshot tests for each screen render. Manual checklist for keyboard navigation.

### Step 6 — Install / Uninstall / Reset commands (1–2 days)

- `src/commands/install.ts` — interactive mode + `--apply --scope=…` non-interactive flags. Pre-install snapshot once. Idempotent re-run.
- `src/commands/uninstall.ts` — confirmation prompt, restore snapshot, `rm -rf ~/.vge-cc-guard/`.
- `src/commands/reset-session.ts` — clear allowlist, pending queue, fatigue counter for the active session id.
- `src/commands/daemon.ts` — foreground daemon for development.
- Integration test `tests/integration/install-uninstall.test.ts` against a sandbox `~/.claude/`.

### Step 7 — End-to-end fixtures (2 days)

- `tests/integration/claude-code-fixtures.test.ts` — golden Claude Code hook payloads (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `SessionEnd`) replayed through the shim, asserting the daemon's reply matches expected.
- `tests/integration/escalation-flow.test.ts` — end-to-end sequence: PostToolUse → VGE flag (mocked) → next PreToolUse denied → user replies `session` → following PreToolUse on same resource passes through allowlist with `userAllowlisted: true`.

### Step 8 — Phase 1b resilience pass (1–2 weeks)

- Pino debug log with rotation.
- VGE retry/backoff and 5 min response cache.
- Session-state persistence files at `~/.vge-cc-guard/sessions/<id>.json`, fsync semantics from §7.13.
- Daemon kill -9 → restart → state recovery test.

### Step 9 — Phase 1c live-monitoring TUI views (2–3 weeks)

CONFIG_DESIGN §9 Phase 1c additions: Events, Pending, Audit, Stats screens.

### Step 10 — Closed beta package (2–3 weeks)

- Pre-release tag `vge-cc-guard@0.9.0-beta.1` published to npm with `--tag beta`.
- Internal install on a non-customer production environment.
- Bug-fix iterations until acceptance criteria §8 are all green.
- Release `vge-cc-guard@1.0.0` with the `latest` tag.

### Stop conditions for the human in the loop

The plan above should run to completion without re-opening design decisions. If during execution a question arises that is not answered by §1–§13, that is a signal to stop, document the gap, and update the PRD before writing more code. The intent of the 2026-04-26 design lock is that this should not happen for in-scope work.
