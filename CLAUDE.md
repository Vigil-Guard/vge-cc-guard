# CLAUDE.md - vge-cc-guard

Project guidance for Claude Code working with the vge-cc-guard repository.

> **Note on the repo name.** The directory is currently `vge-agent-guard` for historical reasons. The product, npm package, CLI binary, and repo are all being renamed to `vge-cc-guard` as the first execution step (see [PRD_1 §13 Execution Plan](docs/prd/PRD_1/PRD_1.md)). All new code, docs, and configs should use `vge-cc-guard`.

---

## Project Overview

**vge-cc-guard** — security sidecar for Claude Code. Gates tool calls via hooks, scans tool outputs through VGE, gives developers a terminal UI to configure runtime policy.

**Concept doc:** [docs/architecture/claude-code-agent-security-integration.md](docs/architecture/claude-code-agent-security-integration.md)

**Mission in one sentence:** BLOCK-default runtime policy for Claude Code with scope-drift intent gating and a full audit path, positioned against Lasso Security's advisory-only `claude-hooks`.

**Status:** Phase 1 design locked 2026-04-26. TypeScript on Node.js, npm package `vge-cc-guard`, full sidecar with TUI configurator. See [PRD_1](docs/prd/PRD_1/PRD_1.md) and [ADR-0001](docs/adr/ADR-0001-project-scope-and-language.md).

---

## Cross-Repository Context

This project integrates tightly with **Vigil Guard Enterprise (VGE)**.

**VGE repo location:** `/Users/tomaszbartel/Development/Vigil-Guard-Enterprise`

**Key VGE endpoints consumed:**

- `POST /v1/guard/analyze` — primary detection endpoint (`source = tool_output | user_input | model_output`)
- `POST /v1/guard/input` — user intent scanning
- `POST /v1/guard/output` — model output scanning
- `GET /v1/license/status` — license validation

**Key VGE schemas to respect (do not re-invent):**

- `GuardResponse` — `packages/shared/src/schemas/index.ts:94`
- `ScopeDriftSignal` — `packages/shared/src/types/scope-drift.ts`
- `DetectionLogEntry` — `services/logging-worker/src/types.ts:110`

**Session state mapping (VGE response → sidecar state):**
See [docs/architecture/claude-code-agent-security-integration.md](docs/architecture/claude-code-agent-security-integration.md) section "Session State Reduction".

**VGE constraints relevant to this project:**

- `scopeDrift` per-level actions today are `ALLOW / BLOCK` only (DB CHECK constraint in PRD_25_v2). Do not assume `LOG / SANITIZE` support for scope-drift actions even though the general rule engine supports them.
- `source` field is accepted and documented as **future-use** in the API contract (VGE commit `7b70acce`, 2026-04-18). Not consumed by the arbiter yet. Phase 0 of the integration plan wires this up — track Phase 0 status before designing source-aware logic.
- Detection audit trail today lives in the `events_v2` ClickHouse table via the logging-worker pipeline. There is no separate per-request mirror into `audit_logs`; the legacy `logDetectionRequest` helper was removed as dead code (VGE commit `b70afcbd`, 2026-04-18). When designing agent-session audit, **do not revive it** — design around agent/session metadata on top of `events_v2` or a new purpose-built mirror.
- `PostToolUse` output rewrite only works for MCP tools in Claude Code. MCP is **out of scope** for this project (see concept doc).
- `llm-guard` uses dual-pass head+tail inference (PRD_27) for long inputs — `services/llm-guard/src/onnx_inference.py:85-202`.

**When VGE state changes:** This cross-ref section describes VGE as of 2026-04-18. Before acting on facts here, verify against current VGE `git log` — these internals can drift.

**When to consult VGE docs vs. this repo:**

- VGE API contract: `/Users/tomaszbartel/Development/Vigil-Guard-Enterprise/docs/api/endpoints.md`
- VGE architecture: `/Users/tomaszbartel/Development/Vigil-Guard-Enterprise/docs/architecture/`
- Arbiter decision logic: `/Users/tomaszbartel/Development/Vigil-Guard-Enterprise/docs/runbooks/arbiter-decision-logic.md`
- NATS communication: `/Users/tomaszbartel/Development/Vigil-Guard-Enterprise/docs/architecture/nats-communication.md`
- This project's architecture and policy: `docs/architecture/` in this repo

**Related VGE agents available when working here:**

VGE's `.claude/agents/` directory exposes technology experts (docker, express, nats, clickhouse, python, security, testing). When a task requires deep VGE internals, reference those agents by name in prompts — the model knows how to invoke them.

---

## Golden Rules for Code Generation

> **Goal:** Generated code must look like it was written by an experienced developer, not by a language model.

### 1. Code Over Comments

Don't add comments if code is self-explanatory. Comments only when: design decision is not obvious, there's a trade-off, or something looks "weird" but has justification.

### 2. Specific Names, Not Generic

Forbidden names: `data`, `result`, `handler`, `process`, `manager`, `utils`, `helper`. Prefer names that reflect intent, not type.

### 3. Small Functions, Single Responsibility

Function should do one thing and fit in 20–40 lines. If you start using "and / or / while also" → split it.

### 4. No Academic Perfection

Code doesn't need to be maximally generic. Prefer simpler code, local decisions, over excessive abstraction.

### 5. Consistency Over "Best Practice"

Adapt to repo style. If the project uses exceptions, use exceptions. If it uses error codes, don't introduce exceptions. Don't refactor the entire project style incidentally.

### 6. Realistic Error Handling, Not Complete

Handle real errors, not all theoretical cases. No "defensive overcoding". One sensible try, rest bubbles up.

### 7. No AI-Style Symmetry

Not all functions need identical structure, line count, or style. Humans write unevenly — and that's OK.

### 8. Logic First, Validation Later

Core logic first, then validation/guards. Avoid situations where validation dominates over logic.

### 9. No Unnecessary TODO/FIXME

If something is "for later", either remove it or solve it now. TODO comments reveal mass generation.

### 10. Code Written As If Someone Reads It Tomorrow

Every line makes sense and can be defended. Zero "because that's how generation worked".

### 11. Tests: Practical, Not Complete

Test key paths and real edge cases. Don't test getters, obvious things, or "everything for sport".

### 12. No Excessive Documentation

Docstring only for public API or non-trivial function. No "This function does...".

### 13. Prefer Readability Over Cleverness

If something is clever but hard to understand → it's a bad decision.

### 14. Code Can't Look "Too Clean"

Minor asymmetry, irregular formatting (within linter limits), local mental shortcuts are acceptable. AI writes too evenly — humans don't.

### 15. When In Doubt — Choose What a Senior Would Choose

Simpler. Less magical. Easier to debug. Easier to delete.

---

## Core Principles

### KISS

Simplest solution that works. One function = one responsibility. If it's hard to explain, it's too complex.

### YAGNI

Only implement what's needed NOW. No speculative features. Delete unused code immediately — don't comment it out.

### SOLID

- **S**ingle Responsibility
- **O**pen/Closed
- **L**iskov Substitution
- **I**nterface Segregation
- **D**ependency Inversion

---

## Critical Rules

### English Only (CRITICAL)

**MANDATORY:** All content MUST be in English — source code, comments, documentation, commit messages, PR descriptions, log messages, error messages, configuration files.

**Exceptions (Polish allowed):**

- Test datasets with Polish samples
- Variables explicitly handling Polish (e.g., `polishStopWords`)
- Detection patterns for Polish prompt injections

### ZERO AI Attribution (CRITICAL)

**ABSOLUTE PROHIBITION** on placing any AI attribution in ANY file.

**Forbidden patterns:**

```
Generated with [Claude Code]
Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Claude Opus
Created by Claude/GPT/Copilot/AI
AI-generated code
// Written by AI assistant
<!-- Generated by Copilot -->
```

**Applies to ALL files:** source, docs, configs, commit messages, PR descriptions, comments.

**If accidentally added:** `git commit --amend` for the last commit, `git rebase -i` for older commits, force push after confirmation.

### Conventional Commits (Mandatory)

All commits MUST follow format:

```
<type>(<scope>): <description>
```

**Types:** `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `security`

**Scopes** (project-specific, will grow):

- `sidecar` — sidecar daemon
- `shim` — per-call hook shim (talks to daemon over Unix socket)
- `tui` — terminal UI configurator
- `hooks` — Claude Code hook integration / settings.json wiring
- `policy` — tool policy, session state, allowlist, ask-dialog
- `audit` — audit trail / logging
- `vge` — VGE API client
- `install` — installer and bootstrap
- `docs` — documentation
- `ci` — CI/CD

**Examples:**

- `feat(policy): wire credential path deny list into Read/Edit/Write`
- `fix(shim): exit 2 when daemon Unix socket is missing`
- `security(policy): fail-closed on PreToolUse shim transport failure`

---

## Git Workflow

When asked to commit and push, use a concise conventional commit message and just do it — don't ask for confirmation unless there's something unusual. No AI attribution in commits. Ever.

---

## Communication Style

When the user wants to discuss or brainstorm, do NOT run tools or start executing. Ask clarifying questions first. Only execute when given a clear action request.

---

## Bug Fixing

Provide complete fixes — don't stop at the first layer. Check for related failure modes, edge cases, and downstream effects before declaring the fix done.

---

## Checkpoint Protocol

### ALWAYS ask user before:

- Any architectural decision
- Adding/removing dependencies
- Deleting or significantly refactoring code
- Modifying configuration files
- Creating new directories or major files
- Any action that cannot be easily undone

### Summarize progress:

- After completing each logical unit of work
- Before moving to next task
- When encountering blockers or decisions

### Quick Reference

| Action | Ask First? |
|---|---|
| Read files | No |
| Small edits (<10 lines) | No |
| New functions/classes | Yes |
| New dependencies | Yes |
| Delete code | Yes |
| Architectural changes | Yes |
| Configuration changes | Yes |

---

## File Size Limits

| Type | Max Lines |
|---|---|
| Daemon modules (`src/daemon/*.ts`) | 600 |
| Shim (`src/shim/*.ts`) | 300 — must stay tiny, this is the hot per-call path |
| TUI components (`src/tui/*.ts`) | 500 |
| General modules | 800 |

If you're approaching the limit, split. Don't invent a "utils" module — find an intent-based name.

---

## Testing (TDD)

1. Write test BEFORE code
2. Test must FAIL initially
3. Implement minimal solution
4. Test must PASS
5. Refactor if needed

Coverage target: **80% minimum** for new code.

Integration tests for: shim ↔ daemon roundtrip over Unix socket, Claude Code hook payload handling end-to-end (golden fixtures from real CC sessions), VGE API client against a mocked `/v1/guard/input` and `/v1/guard/analyze`, TUI key bindings, install/uninstall flow against a sandbox `~/.claude/`.

---

## Security First

**SQL Injection Prevention:** parameterized queries only.

**Credentials:** fail-fast at startup. No empty fallbacks.

**API keys:** never log keys, only labels. Never expose in responses.

**Credential path protection (sidecar runtime).** The sidecar refuses tool calls that target the following paths regardless of per-tool config — this is a hard, hard-coded deny list, not pattern matching. It applies to `Read`, `Edit`, and `Write` (and any future tool that takes a path argument):

- `~/.env`, `*/.env`, `*.env`
- `~/.ssh/*` (any file under `.ssh/`)
- `~/.aws/credentials`, `~/.aws/config`
- `~/.kube/config`
- `~/.config/gcloud/*`, `~/.gcp/*`
- Files matching `id_rsa*`, `id_ed25519*`, `id_ecdsa*`
- Files matching `*credentials*`, `*secrets*` at any depth

The protection is a configurable toggle in the TUI (`policy.credential_protection`, default `true`). Disabling it requires a conscious flip in the configurator with a red warning. See [PRD_1 §7.11](docs/prd/PRD_1/PRD_1.md).

**Hook inputs:** always parse as JSON, never `eval` or shell-interpolate user-controlled fields from Claude Code hook payloads.

---

## Error Handling (3-State)

| Action | When | Example |
|---|---|---|
| `retry` | Transient failures | Network timeout, rate limit, file lock |
| `escalate` | Needs user decision | Permission denied, conflicting edits, tests failing after 3 attempts |
| `fail` | Unrecoverable | Critical file missing, security violation |

---

## Task Completion Checklist

- [ ] Code written and tested
- [ ] Tests passing
- [ ] Lint clean
- [ ] Documentation updated (if API changed)
- [ ] No security vulnerabilities
- [ ] No hardcoded secrets
- [ ] Conventional Commits format
- [ ] **No AI attribution** anywhere
- [ ] **All content in English**

---

## Repository Structure

```
vge-cc-guard/                 # repo will be renamed from vge-agent-guard
├── CLAUDE.md                 # This file
├── README.md                 # Install + quickstart, points to docs/
├── CHANGELOG.md              # User-facing change log
├── LICENSE.md                # Copied from VGE (proprietary)
├── .gitignore
├── package.json              # npm package manifest, "bin": { "vge-cc-guard": "dist/cli.js" }
├── tsconfig.json
│
├── docs/
│   ├── CONFIG_DESIGN.md                                # Canonical TUI configurator spec
│   ├── architecture/
│   │   └── claude-code-agent-security-integration.md   # Concept doc
│   ├── adr/
│   │   ├── template.md
│   │   └── ADR-0001-project-scope-and-language.md      # Accepted: TypeScript
│   └── prd/
│       └── PRD_1/
│           └── PRD_1.md                                # Phase 1 spec (single source of truth)
│
├── src/                      # TypeScript sources (PRD_1 §5)
│   ├── cli.ts                # Entry point: install, config, daemon, hook, reset-session
│   ├── shim/                 # Per-call hook shim (Unix socket client, fail-closed)
│   ├── daemon/
│   │   ├── http-server.ts
│   │   ├── session-state.ts
│   │   ├── tool-policy.ts
│   │   ├── path-deny.ts      # Credential path protection (CLAUDE.md)
│   │   ├── confidence-router.ts
│   │   ├── ask-dialog.ts
│   │   ├── allowlist.ts
│   │   ├── vge-client.ts
│   │   └── audit-logger.ts
│   └── tui/
│       └── config-ui.ts
│
├── config/
│   └── default-tools.json    # Default tool policies shipped with the package
│
├── tests/
│   ├── unit/
│   └── integration/
│
├── examples/
│   ├── managed-settings.template.json
│   └── prompt-logger-v0/     # Phase 0 bash hook (kept for legacy reference)
│
├── vg-cc/                    # Phase 0 hook (legacy, superseded by Phase 1 sidecar)
│   └── hooks/
│       └── user-prompt-submit.sh
│
└── .claude/                  # DEV tooling for working ON this repo
    ├── hooks/
    ├── commands/
    ├── lib/
    ├── memory/
    ├── scripts/
    └── settings.json
```

**Important distinction:**

- `.claude/` is our **development environment** — productivity tooling for Claude Code sessions working ON vge-cc-guard.
- `src/` + `examples/` + `scripts/` are the **product** itself — what end users install to protect their own Claude Code sessions.

These two must not be confused. When in doubt, ask.

---

## Essential Commands

```bash
pnpm install               # install dependencies
pnpm build                 # tsc → dist/
pnpm test                  # vitest
pnpm lint                  # eslint
pnpm typecheck             # tsc --noEmit

# Manual local install during development
pnpm build && npm link
vge-cc-guard install --dry-run   # preview hook changes
vge-cc-guard daemon              # run daemon in foreground (DEBUG=vge-cc-guard:*)
```

---

## Architecture Decision Records (ADR)

**BEFORE making significant technical decisions:**

1. Check existing ADRs in [docs/adr/](docs/adr/)
2. If no relevant ADR exists, create one using `docs/adr/template.md`
3. ADR required for: language choice, new dependencies, architectural changes, API contract changes, hook transport changes (current: shim → Unix socket → daemon), TUI library changes, storage format for session state, any addition of local content detection (current decision: VGE-only)

**ADR naming:** `ADR-XXXX-short-description.md` (4-digit sequential number, starting at 0001)

---

## Trunk-Based Development

- `main` is always deployable (protected once CI is set up)
- Feature branches max 3 days
- All changes via PR with minimum 1 approval (once team expands)
- Squash merge preferred
- No force push to `main` or `release/*`

---

## Pre-commit Checklist

- [ ] Code compiles / runs
- [ ] Tests pass
- [ ] Lint clean
- [ ] No secrets in code
- [ ] Commit message follows Conventional Commits
- [ ] **No AI attribution**
- [ ] **All content in English**

---

**Last Updated:** 2026-04-26
**Version:** 0.1.0 (Phase 1 design locked)
