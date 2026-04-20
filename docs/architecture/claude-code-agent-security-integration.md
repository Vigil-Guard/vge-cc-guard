# Claude Code Agent Security Integration Concept

Date: 2026-04-18 (v2, post-audit)

## Executive Summary

The primary control point for agent protection is not the user's prompt. It is the boundary where the agent reads untrusted external content, executes tools, or changes its own permissions. For Claude Code specifically, Anthropic already exposes that boundary through hooks, managed settings, and OTel telemetry.

This document describes a realistic, deployable integration that combines:

1. Claude Code managed settings and permissions as the hard baseline.
2. Claude Code hooks (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `PermissionDenied`, `ConfigChange`, `SessionEnd`) as runtime decision points.
3. A local `vge-agent-guard` sidecar as the policy engine, managed through a terminal UI (TUI).
4. VGE as the detection and audit plane behind the sidecar.

The product is positioned against one real direct competitor (Lasso Security `claude-hooks`, advisory-only). The differentiators are: BLOCK by default, `scopeDrift` for intent control, a full audit path, and a first-class TUI for configuration.

## Scope

**In scope (Phase 1 and 2):**

- Claude Code on local developer workstations.
- Hooks for Bash, Read, Edit, Write, WebFetch, Grep, Task (subagents), UserPromptSubmit, ConfigChange.
- Local sidecar with TUI configuration.
- VGE as text-risk / scope-drift / audit backend.

**Out of scope (future, not in this document):**

- MCP gateway, MCP proxy, MCP wrappers, or replacement of third-party MCP servers.
  MCP integration is explicitly deferred. If the project needs an MCP control
  plane later, it will come through a partnership or external vendor, not
  through this integration.
- Cursor, Copilot, or other coding agents (Claude Code only for now).
- Remote/cloud-hosted agents.
- Browser extension scenarios (handled by the existing browser-side VGE path).

Removing MCP from scope simplifies the architecture significantly and lets the
first release focus on what Claude Code already supports natively.

## Threat Model

Realistic threats for a local coding agent:

- Indirect prompt injection from fetched web pages, documentation, tickets, emails, retrieved docs, and large pasted logs or terminal output.
- Excessive tool surface: unrestricted shell networking, arbitrary file writes, unrestricted subagent spawning.
- Weak separation between trusted user intent and untrusted content that entered the session through a tool.
- No usable audit trail of what the agent saw, what it did, and why the platform allowed it.

This aligns with OWASP LLM06 (Excessive Agency), Anthropic's published guidance for Claude Code, and OpenAI's warning that filtering alone does not catch fully-developed prompt-injection attacks.

## Current VGE Capabilities (Verified)

The audit confirmed the following capabilities are already in place:

- `/v1/guard/analyze` accepts `source = user_input | tool_output | model_output`
  ([`packages/shared/src/schemas/index.ts:22`](../../packages/shared/src/schemas/index.ts#L22)).
- `llm-guard` runs **dual-pass head+tail** inference for long inputs (PRD_27,
  [`services/llm-guard/src/onnx_inference.py:85-202`](../../services/llm-guard/src/onnx_inference.py#L85-L202)),
  specifically for tail-resident attacks in agentic flows.
- `scopeDrift` returns `ON_SCOPE / NEAR_SCOPE / OFF_SCOPE` with drift score
  and probabilities ([`packages/shared/src/types/scope-drift.ts`](../../packages/shared/src/types/scope-drift.ts)).
- Rule engine supports `ALLOW / BLOCK / LOG / SANITIZE` as global actions
  ([`packages/shared/src/schemas/index.ts:182`](../../packages/shared/src/schemas/index.ts#L182)).
- Arbiter emits `decisionFlags` including `FAILOPEN_MISSING_LLM`,
  `FAILOPEN_ALL_BRANCHES_DEGRADED`, `SCOPE_DRIFT_DEGRADED` — the sidecar can
  base fail-mode policy on these.
- Logging worker persists detection events in ClickHouse with flexible JSON
  payload columns (`arbiter_json`, `branch_results_json`, `pii_classification_json`
  at [`services/logging-worker/src/clickhouse-client.ts:65-71`](../../services/logging-worker/src/clickhouse-client.ts#L65-L71)).

## Current Gaps (Verified)

1. **`source` field is accepted but not consumed.** The value reaches the
   `DetectionRequest` at
   [`detection-pipeline.ts:296`](../../apps/api/src/services/detection-pipeline.ts#L296)
   but no worker branches on it. Source-aware thresholds require one-time
   arbiter wiring — this is P0, not P1 as originally framed.

2. **`logDetectionRequest` is ready but not wired.** The audit function at
   [`audit-logger.ts:293`](../../apps/api/src/services/audit-logger.ts#L293)
   was added 2026-04-15 (commit `701b1432`) with full tests. It simply needs
   to be called from the guard controllers after a decision. Trivial wire-up,
   P0.

3. **scopeDrift per-level actions are binary today.** The DB check constraint
   narrows `scope_drift_action_near_scope` / `off_scope` to `ALLOW | BLOCK`
   only. The comment in `types/scope-drift.ts` that promises `LOG / SANITIZE`
   is inaccurate and will be corrected. The sidecar can still map
   `NEAR_SCOPE → ask` locally without relying on the DB action field.

4. **No agent-level metadata schema.** Fields the sidecar will want to send
   (`session_id`, `prompt_id`, `tool_name`, `tool_use_id`, `hook_event`,
   `permission_mode`, `agent_type`, `destination_domain`) do not exist in
   the VGE DetectionRequest. They can be added to `metadata` today and
   promoted to indexed columns later. No schema migration required for
   Phase 1 — the flex JSON payload columns already persist arbitrary
   structure.

5. **Platform rules (`VALID_PLATFORMS`) are not relevant here.** That
   mechanism is scoped to the browser extension use case. The core detection
   pipeline is vendor-agnostic and accepts `metadata.platform` as a free
   string without the UI-side allowlist gating it. No change needed.

## Claude Code Integration Surface

Verified against `https://code.claude.com/docs/en/`:

- Hook events: `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`,
  `PostToolUse`, `PermissionDenied`, `ConfigChange`, `SessionEnd`,
  `SessionStart`.
- `PreToolUse` can return `allow | deny | ask | defer`, modify tool input
  via `updatedInput`, and inject `additionalContext`. Denial (exit code 2)
  **overrides** bypassPermissions / allow rules — documented explicitly.
- `PostToolUse` can inject `additionalContext` and set `decision: "block"`
  to prompt Claude with a `reason`. Important limits:
  - `updatedMCPToolOutput` only affects MCP tools and has no effect on
    Bash, Write, Read, WebFetch, Edit. Since MCP is out of scope in this
    document, this capability is not used.
  - `decision: "block"` is feedback after the tool already executed — not
    pre-execution enforcement. The only hard block is in `PreToolUse`.
- Managed settings: `allowManagedHooksOnly`, `allowManagedPermissionRulesOnly`,
  `allowManagedMcpServersOnly`, `disableBypassPermissionsMode`,
  `disableAutoMode`.
- HTTP hooks exist — Claude Code can call a local endpoint directly. This
  is used for the sidecar transport.
- OTel: `prompt.id`, `session.id`, `tool_use_id`, `decision_source`,
  `claude_code.tool_result` event. These map directly onto the agent
  metadata fields VGE needs.

## Architecture

```
  Claude Code
      │
      │  HTTP hooks (PreToolUse, PostToolUse, UserPromptSubmit,
      │   PermissionDenied, ConfigChange, SessionEnd)
      ▼
  ┌────────────────────────────────┐
  │   vge-agent-guard (local)      │
  │                                │
  │   L1: fast local heuristics    │  < 10 ms
  │   L2: VGE /v1/guard/analyze    │  when L1 uncertain
  │                                │
  │   session state: clean /       │
  │     caution / tainted          │
  │                                │
  │   TUI for configuration        │
  │   (vge-cc-guard command)          │
  └────────────────────────────────┘
      │
      │  REST + NATS
      ▼
  ┌────────────────────────────────┐
  │   VGE API + workers            │
  │   (text risk, scopeDrift,      │
  │    rule engine, ClickHouse)    │
  └────────────────────────────────┘
      │
      ▼
  OTel collector + SIEM
```

The sidecar is the **only** moving part on the user's machine. VGE runs in
its normal deployment (local Docker or SaaS) and is reached through its
existing API.

## Hook-to-Sidecar Mapping

| Hook | Purpose | Decision authority |
|---|---|---|
| `UserPromptSubmit` | Log initial intent. Optional scope extraction. Block obviously prohibited prompts. | Advisory |
| `PreToolUse` | Primary gate. Allow / deny / ask based on tool name, arguments, session state. | **Enforcement** |
| `PermissionRequest` | Convert weak user prompts into session-scoped allowances (see Approval UX). | Enforcement |
| `PostToolUse` | Scan tool output as `source = tool_output`. On risk, inject `additionalContext` warning and tighten session state. | Advisory only (tool already ran) |
| `PermissionDenied` | Risk signal; recorded in audit trail. | Signal only |
| `ConfigChange` | Block local weakening of hooks, permissions, or skills during an active session. | Enforcement |
| `SessionEnd` | Flush audit buffer, persist session summary. | N/A |

## Session State Reduction (from VGE output)

The sidecar reduces any VGE response for `tool_output` into one of three states:

**`clean`** — `decision = ALLOWED`, `threatLevel = LOW`, `llmGuard.verdict = SAFE` (when present), semantic branch does not lean attack-like, no `FAILOPEN_*` / `_DEGRADED` flag.

**`caution`** — `decision = SANITIZED`, or `threatLevel = MEDIUM`, or semantic `attackSimilarity > safeSimilarity`, or `scopeDrift.level = NEAR_SCOPE`, or any `FAILOPEN_*` / `_DEGRADED` flag.

**`tainted`** — `decision = BLOCKED`, or `threatLevel in {HIGH, CRITICAL}`, or `llmGuard.verdict = ATTACK DETECTED`, or `scopeDrift.level = OFF_SCOPE` for the proposed next action.

Action policy per state:

| State | Read / inspect | Shell / write / network / subagent |
|---|---|---|
| `clean` | allow | ask by default |
| `caution` | allow read-only | ask |
| `tainted` | narrow read-only only | deny outbound net, deny secret reads, deny repo writes, deny broad shell |

## Latency Budget (L1 / L2)

PreToolUse is on the critical path of every tool call. A pure
sidecar → VGE `/v1/guard/analyze` round trip would be too slow for
interactive use. The sidecar uses a two-tier decision path:

**L1 — local heuristic (budget: < 10 ms)**
- Tool name allow/deny lists.
- URL domain allow/deny.
- File path patterns (secrets, `.env`, credentials, SSH keys).
- Bash command prefix patterns (`curl`, `wget`, `nc`, `ssh`, `scp`).
- Current session state (`clean / caution / tainted`).

L1 alone resolves the majority of `PreToolUse` calls. When L1 is decisive,
the hook returns without calling VGE.

**L2 — VGE `/v1/guard/analyze` (budget: ≤ 300 ms)**
- Triggered when L1 returns "uncertain" or when content needs text analysis.
- Used predominantly for `PostToolUse` (not time-critical for the user),
  `UserPromptSubmit`, and ambiguous `PreToolUse` cases.
- Result is cached per-session for the same content hash.

This keeps the 99th-percentile `PreToolUse` latency well under 50 ms in
practice.

## Fail-Mode Policy

Every hook specifies behaviour when its dependency is unavailable.

| Hook | Sidecar down | VGE down | Timeout |
|---|---|---|---|
| `PreToolUse` | fail-closed (deny with clear message) | L1 only, escalate to `ask` on ambiguity | fail-closed |
| `PostToolUse` | fail-open (log only) | fail-open | fail-open |
| `UserPromptSubmit` | fail-open | fail-open | fail-open |
| `ConfigChange` | fail-closed (block change) | fail-closed | fail-closed |

Fail-closed on `PreToolUse` is conservative but correct — the alternative
silently bypasses the control plane. A clear user-facing message mitigates
UX pain.

Fail-open on `PostToolUse` is safe because the tool has already executed —
the worst case is delayed detection, not a missed block.

## Approval Fatigue Mitigation

`ask` returned for every tool call is a UX disaster and will kill adoption.
The sidecar provides three mitigations:

1. **Session-scoped allowances.** An `ask → allow` for `Read` of a
   directory grants `Read` on children for the rest of the session.
   Scoped to tool + argument pattern.
2. **Batch approval.** When the agent plans `N` similar actions (e.g. ten
   file reads), the sidecar aggregates them into one prompt.
3. **Cooldown.** After an `ask`, repeats of the same action within `T`
   seconds auto-approve silently.

All three are configurable through the TUI. Defaults:
session-scope ON, batch ON, cooldown 30 s.

## Sidecar Configuration: Terminal UI

The sidecar is configured through a local TUI — a live terminal dashboard,
not a web console. Philosophy: feel like `k9s`, `lazygit`, `htop` — one
command, split-pane, keyboard-driven, live-updating.

Command: `vge-cc-guard`

```
┌─ vge-agent-guard ── session: local ── status: clean ─────────────────┐
│                                                                      │
│  [1] Rules       [2] Events     [3] Approvals    [4] Audit           │
│  [5] Policy      [6] Session    [7] Stats        [q] Quit            │
│                                                                      │
│  live events (last 20) ──────────────────────────────────────────    │
│  14:22:03  PreToolUse   Bash("pnpm test")           → allow  L1      │
│  14:22:04  PreToolUse   Read(".env")                → DENY   L1      │
│  14:22:07  PreToolUse   WebFetch(docs.anthro…)      → allow  L1      │
│  14:22:09  PostToolUse  WebFetch ← 14 kB           caution   L2      │
│  14:22:09                ↳ scope_drift=NEAR_SCOPE                    │
│  14:22:09                ↳ llmGuard=SAFE  semantic=0.31              │
│  14:22:14  PreToolUse   Edit(…/src/api.ts)          → ask            │
│                                                                      │
│  session state: caution (since 14:22:09)                             │
│  VGE: reachable (p50 42ms, p99 180ms)                                │
└──────────────────────────────────────────────────────────────────────┘
```

Views:

- **Rules** — allow/deny/ask patterns per tool. Live editor with syntax
  validation. Changes take effect on save.
- **Events** — tail of all hook firings with decision, tier (L1/L2), and
  latency. Enter to expand VGE response.
- **Approvals** — pending `ask` decisions + history of granted allowances.
- **Audit** — session summary, denied actions, off-scope transitions.
  Exportable to file or shipped to VGE logging worker.
- **Policy** — session state transitions, fail-mode defaults, latency
  budgets, approval-fatigue toggles.
- **Session** — current Claude Code session id, prompt id, active scope
  definition.
- **Stats** — decision distribution, L1/L2 split, p50/p99 latency, cache
  hit rate, VGE availability.

Configuration file: `~/.config/vge-cc-guard/config.toml`. Simple, commentable,
and text-editor-friendly. The TUI is a live face onto the same file — edits
made in either place are reflected live in the other.

No HTTP admin API. No browser-based dashboard. The TUI plus the config file
are the entire configuration surface.

For server-managed deployments, the same config file is provisioned by
Claude Code managed settings (`server-managed-settings`) and the TUI runs
in read-only mode.

## Installation and Bootstrap

Two supported paths.

**Individual developer**

```
$ brew install vge-agent-guard          # or: pnpm dlx @vigilguard/agent-guard init
$ vge-cc-guard init                        # writes managed settings + hook config
$ vge-cc-guard                             # open TUI
```

`vge-cc-guard init` writes:

- `~/.claude/settings.json` — hooks registered, permission rules set,
  `allowManagedHooksOnly = true`.
- `~/.config/vge-cc-guard/config.toml` — sidecar config.
- Starts the sidecar as a background service (launchd / systemd).

**Organization rollout**

Managed settings distributed by the organization override local settings.
`vge-cc-guard` runs in read-only TUI mode, users cannot weaken policy.
ConfigChange hook blocks local attempts to override.

## Competitive Positioning

| Product | Claude Code | Action | Shape |
|---|---|---|---|
| Lasso `claude-hooks` | yes | WARN only | PostToolUse OSS |
| Anthropic built-in (Auto Mode classifier, IPI probe) | yes | ADVISORY | baseline |
| Pangea / CrowdStrike AIDR | no | gate | API gateway |
| Prompt Security | no | gate | MCP gateway |
| WitnessAI | no | gate | MCP / identity |
| Lakera Guard, Model Armor, NeMo Guardrails | no | filter | API / framework |

The only direct competitor on shape is Lasso. Lasso warns, it does not
block. VGE differentiates on four axes:

1. **BLOCK by default** through `PreToolUse`, not post-hoc warnings.
2. **`scopeDrift`** — intent-level gating, not just content classification.
3. **Full audit path** via existing VGE logging worker + ClickHouse.
4. **TUI** — one command, no browser, no web dashboard, no admin API.

## Rollout Plan

### Phase 0 — VGE wire-up (weeks 1–2)

1. Call `logDetectionRequest` from the guard controllers (one line per
   controller, infrastructure already exists).
2. Consume `source` in the arbiter: stricter thresholds and scope-drift
   handling when `source = tool_output`.
3. Add agent metadata passthrough: accept `session_id`, `prompt_id`,
   `tool_name`, `tool_use_id`, `hook_event`, `agent_type`,
   `destination_domain` inside the existing `metadata` object. Persist to
   the flex JSON columns in ClickHouse. No schema migration.
4. Correct the comment in `types/scope-drift.ts` about 4-action support.

No Claude Code code is touched in this phase.

### Phase 1 — sidecar MVP (weeks 3–6)

1. `vge-agent-guard` local daemon with L1/L2 decision path.
2. `vge-cc-guard` TUI: Rules, Events, Approvals, Audit, Policy, Session, Stats.
3. Managed-settings template that locks hooks, permissions, and
   `disableBypassPermissionsMode`.
4. `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `PermissionDenied`,
   `ConfigChange`, `SessionEnd` wired to the sidecar.
5. Approval-fatigue mitigations enabled by default.
6. Installer (`vge-cc-guard init`) for macOS and Linux.

### Phase 2 — production polish (weeks 7–10)

1. Server-managed policy rollout, read-only TUI mode.
2. OTel → VGE payload mapping for investigation UI.
3. Session replay view in the TUI.
4. Organisation-level audit rollups in VGE dashboards.

### Phase 3 — expansion (future, not committed here)

- Other agents (Cursor, Copilot) — same L1/L2 model if they expose hooks.
- MCP integration — **out of scope now**, likely through a partnership or
  external vendor.
- Remote / cloud-hosted agents.

## Anti-Patterns We Explicitly Avoid

- Building only a user-prompt scanner (misses indirect injection entirely).
- Using Bash allow/deny patterns alone for URL filtering (URL and command
  filtering are orthogonal).
- Trusting third-party MCP servers — deferred by scope.
- Flooding the user with `ask` prompts — mitigated by the approval-fatigue
  policy.
- Browser-based config UI — replaced by the TUI.
- Big custom proxy infrastructure in the first release.

## What This Integration Does Not Solve

- It does not eliminate indirect prompt injection. No filter can. It reduces
  exposure and adds an audit path.
- It does not protect against an agent that genuinely wants to misbehave —
  that is an alignment problem, not a firewall problem.
- It does not cover MCP, Cursor, Copilot, or remote agents in this release.

OpenAI's guidance is explicit: *"these fully developed attacks are not
usually caught by such systems."* The value is defence in depth: hard
permissions + hook-level gating + scope-drift intent check + an audit
plane that survives the session.

## Grounding

- Anthropic Claude Code Hooks: https://code.claude.com/docs/en/hooks
- Anthropic Claude Code Permissions: https://code.claude.com/docs/en/permissions
- Anthropic Claude Code Monitoring: https://code.claude.com/docs/en/monitoring-usage
- Anthropic Claude Code Server-managed settings: https://code.claude.com/docs/en/server-managed-settings
- Anthropic Claude Code Security: https://code.claude.com/docs/en/security
- OWASP LLM06 Excessive Agency: https://genai.owasp.org/llmrisk/llm062025-excessive-agency/
- OpenAI Designing agents to resist prompt injection: https://openai.com/index/designing-agents-to-resist-prompt-injection/
- Lasso Security `claude-hooks`: https://github.com/lasso-security/claude-hooks
- Google Model Armor: https://cloud.google.com/security/products/model-armor
- Lakera Guard: https://www.lakera.ai/lakera-guard
- Pangea / CrowdStrike AIDR: https://pangea.cloud/docs/ai-guard
- NVIDIA NeMo Guardrails: https://docs.nvidia.com/nemo/guardrails/latest/index.html
- WASP benchmark: https://arxiv.org/abs/2504.18575
- MUZZLE red-teaming framework: https://arxiv.org/abs/2602.09222

## Changelog

**v2 (2026-04-18)**
- MCP integration moved out of scope.
- Added L1/L2 latency budget.
- Added fail-mode matrix.
- Added approval-fatigue section.
- Replaced HTTP admin surface with TUI (`vge-cc-guard`).
- Consolidated rollout into Phase 0 (VGE wire-up) + Phase 1 (sidecar MVP) + Phase 2 (polish).
- Corrected: `logDetectionRequest` status (ready, not wired), scopeDrift action domain (binary today), PostToolUse non-MCP limits, platform-rules irrelevance.
- Confirmed competitive landscape: Lasso is the only direct shape competitor.

**v1 (2026-04-16)** — initial concept.
