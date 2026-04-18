# CLAUDE.md - vge-agent-guard

Project guidance for Claude Code working with the vge-agent-guard repository.

---

## Project Overview

**vge-agent-guard** — security sidecar for Claude Code. Gates tool calls via hooks, scans tool outputs through VGE, gives developers a terminal UI to configure runtime policy.

**Concept doc:** [docs/architecture/claude-code-agent-security-integration.md](docs/architecture/claude-code-agent-security-integration.md)

**Mission in one sentence:** BLOCK-default runtime policy for Claude Code with scope-drift intent gating and a full audit path, positioned against Lasso Security's advisory-only `claude-hooks`.

**Status:** Bootstrapped 2026-04-18. Language choice (Python / Rust / Go / TypeScript) not yet decided — see [docs/adr/ADR-0001-project-scope-and-language.md](docs/adr/ADR-0001-project-scope-and-language.md).

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
- `tui` — terminal UI
- `hooks` — Claude Code hook integration
- `policy` — policy engine (L1/L2, session state, approval fatigue)
- `audit` — audit trail / logging
- `vge` — VGE API client
- `install` — installer and bootstrap
- `docs` — documentation
- `ci` — CI/CD

**Examples:**

- `feat(sidecar): add L1 heuristic for Bash networking commands`
- `fix(hooks): handle ConfigChange payload when matcher is null`
- `security(policy): fail-closed on PreToolUse sidecar timeout`

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
| Sidecar modules | 600 |
| Hook scripts (Python/shell) | 300 |
| TUI components | 500 |
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

Integration tests for: Claude Code hook integration (HTTP or stdin-JSON handshake), VGE API client (against live or mocked VGE), TUI key bindings.

---

## Security First

**SQL Injection Prevention:** parameterized queries only.

**Credentials:** fail-fast at startup. No empty fallbacks.

**API keys:** never log keys, only labels. Never expose in responses.

**Sidecar filesystem:** never read `.env`, `id_rsa`, `.ssh/`, `.aws/`, `.kube/`, `credentials*`, `secrets*` — this is our L1 deny list and it applies to the sidecar itself, not just to what it blocks for Claude.

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
vge-agent-guard/
├── CLAUDE.md                 # This file
├── README.md                 # Minimal, points to docs/
├── LICENSE.md                # Copied from VGE (proprietary)
├── .gitignore
│
├── docs/
│   ├── architecture/
│   │   └── claude-code-agent-security-integration.md   # Concept doc (canonical)
│   ├── adr/
│   │   ├── template.md
│   │   └── ADR-0001-project-scope-and-language.md
│   └── prd/
│       └── PRD_V1/           # First product requirements (TBD)
│
├── src/                      # Sidecar + policy engine (language TBD)
├── tests/
├── examples/
│   └── managed-settings.template.json   # Template for end users
├── scripts/                  # Build/install/bootstrap
│
└── .claude/                  # DEV tooling for working ON this repo
    ├── hooks/                # Python/shell automation (from vigil-code scaffold)
    ├── commands/             # Slash commands
    ├── lib/                  # Memory loader/writer
    ├── memory/               # Cross-session memory (gitignored contents)
    ├── scripts/
    └── settings.json         # Hook wiring
```

**Important distinction:**

- `.claude/` is our **development environment** — productivity tooling for Claude Code sessions working ON vge-agent-guard.
- `src/` + `examples/` + `scripts/` are the **product** itself — what end users install to protect their own Claude Code sessions.

These two must not be confused. When in doubt, ask.

---

## Essential Commands

**Not yet defined** — depends on language choice (ADR-0001 pending). Placeholders:

```bash
# Python (if chosen)
uv sync                    # or: pip install -e ".[dev]"
uv run pytest              # tests
uv run ruff check .        # lint
uv run mypy src/           # typecheck

# Rust (if chosen)
cargo build
cargo test
cargo clippy

# Go (if chosen)
go build ./...
go test ./...
go vet ./...
```

---

## Architecture Decision Records (ADR)

**BEFORE making significant technical decisions:**

1. Check existing ADRs in [docs/adr/](docs/adr/)
2. If no relevant ADR exists, create one using `docs/adr/template.md`
3. ADR required for: language choice, new dependencies, architectural changes, API contract changes, hook transport choice (HTTP vs stdin-JSON), TUI library choice, storage format for session state

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

**Last Updated:** 2026-04-18
**Version:** 0.0.1 (bootstrap)
