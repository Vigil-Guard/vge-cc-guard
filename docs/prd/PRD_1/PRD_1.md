# PRD_1 — Full Sidecar (Phase 0 + Phase 1)

**Status:** In Planning (Phase 0 complete, Phase 1 design in progress)  
**Author:** Tomasz Bartel  
**Created:** 2026-04-20  
**Target branch:** `main`  
**Owners:** vge-agent-guard  
**Related:**
- [PRD_0 — User Prompt Logger (Phase 0)](../PRD_0/PRD_0.md)
- [Concept doc](../../architecture/claude-code-agent-security-integration.md)
- [ADR-0001 Language Choice](../../adr/ADR-0001-project-scope-and-language.md)

---

## 1. Executive Summary

**Phase 0 (now part of Phase 1 sidecar)** delivers prompt/output logging via Claude Code hooks. Captures user prompts and tool responses, forwards them to VGE for detection. Now implemented in TypeScript sidecar instead of separate bash hook.

**Phase 1** (this document) delivers a **full native sidecar** written in TypeScript/Node.js. The sidecar:
- **Replaces Phase 0 bash hook** — handles `UserPromptSubmit` and `PostToolUse` hooks, logs to VGE
- **Tool gating** — intercepts `PreToolUse` hook, allows/blocks tool execution based on L1 + session state
- **Session state tracking** — detects prompt injections evolving across multiple turns (clean → caution → tainted)
- **L1 heuristics locally** — fast pattern matching (<50ms) without waiting for VGE
- **Configuration UI** — `vge-cc-guard config` TUI for easy setup
- **Graceful VGE failover** — falls back to L1-only decisions if VGE unreachable

Phase 1 consolidates Phase 0 and adds tool gating + session awareness.

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
| **Documentation** | README.md, PRD_0.md, troubleshooting | ✅ Complete |
| **Testing** | Smoke tests, DRY_RUN mode | ✅ Complete |

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
          └─ POST /v1/guard/output

VGE receives both events
    ├─ Detection branches (heuristics, semantic, llm-guard, pii)
    ├─ ClickHouse logging
    └─ Investigation tab shows all claude-code events
```

### 2.3 Phase 0 Limitations (Solved by Phase 1)

| Gap | Phase 0 Behavior | Phase 1 Solution |
|-----|------------------|-----------------|
| **Tool Gating** | No enforcement; advisory only | PreToolUse hook allows/blocks execution |
| **Session State** | No multi-turn analysis | Track "clean/caution/tainted" state across prompts |
| **Local L1** | All analysis in VGE | L1 heuristics run locally for latency |
| **Configuration** | Environment variables only | vge-cc-guard TUI for settings |
| **Operator Control** | None; static rules in VGE | Server pushes policies to sidecars |
| **Performance** | 5s timeout per prompt (blocking) | Async processing, <300ms PreToolUse latency |

---

## 3. Phase 1 Scope

### 3.1 Goals

Phase 1 must:

1. **Replace Phase 0 bash hook:** Handle `UserPromptSubmit` and `PostToolUse` hooks in sidecar, log to `/v1/guard/input` and `/v1/guard/output` (same format as original hook).
2. **Tool gating via PreToolUse:** Intercept tool execution, run L1 check + check session state, return ALLOW/BLOCK before tool executes.
3. **Session state machine:** Track conversation state (clean → caution → tainted) based on detection signals. Boost risk scoring for risky prompts in tainted sessions.
4. **Local L1 heuristics:** Run pattern matching locally. Fast path: <10ms decision for obvious attacks without network.
5. **VGE fallback:** For borderline L1 cases, async POST to VGE for semantic/llm-guard analysis (non-blocking).
6. **Configuration UI:** `vge-cc-guard config` TUI lets users enable/disable features, set thresholds, choose which tools are gatable.
7. **Graceful degradation:** If VGE unreachable, sidecar falls back to L1-only decisions (no blocking of Claude Code).

### 3.2 Non-Goals

Phase 1 explicitly does **not**:

1. Replace VGE detection — L1 is fast heuristics only; semantic/llm-guard remain in VGE.
2. Implement content moderation — that stays in VGE arbiter.
3. Provide user-facing approval dialogs — this is server-enforced only.
4. Support custom rule scripting — policies are JSON templates from server.
5. Handle multi-session correlation — that's Phase 2 (session replay).
6. Implement OTel/observability — that's Phase 2.

---

## 4. Phase 1 Architecture

### 4.1 Component Diagram

```
Claude Code session
    │
    ├─ SessionStart
    │  └─ vge-cc-guard sidecar (TypeScript daemon)
    │     └─ Initialize session state (clean)
    │
    ├─ UserPromptSubmit
    │  └─ POST to sidecar (local)
    │     ├─ Run L1 heuristics (fast path)
    │     ├─ If suspicious: async POST /v1/guard/input (VGE)
    │     └─ Update session state
    │
    ├─ PreToolUse
    │  └─ POST to sidecar (local) — **CRITICAL PATH**
    │     ├─ Fast decision (<10ms typical):
    │     │  ├─ Check cached L1 result for current prompt
    │     │  ├─ Check session state (tainted? boost threshold)
    │     │  └─ Return ALLOW / BLOCK / CAUTION
    │     │
    │     ├─ If BLOCK: log decision, return {"decision": "BLOCK"}
    │     │  └─ Claude Code does NOT execute the tool
    │     │
    │     ├─ If CAUTION: log, return {"decision": "ALLOW"}
    │     │  └─ Tool executes, but sidecar monitors for injection in response
    │     │
    │     └─ If ALLOW: log, return {"decision": "ALLOW"}
    │
    ├─ PostToolUse
    │  └─ Async analysis (non-blocking)
    │     ├─ Run L1 heuristics on tool output
    │     ├─ If injection detected: update session state → TAINTED
    │     └─ Log for audit
    │
    └─ SessionEnd
       └─ Flush audit log, cleanup state
```

### 4.2 Sidecar Internal Architecture

```
vge-cc-guard sidecar (single process, TypeScript + Node.js or Rust)
    │
    ├─ HTTP listener (localhost:9090, Unix socket)
    │  ├─ /health — readiness probe
    │  ├─ /v1/hooks/presession — SessionStart → init state
    │  ├─ /v1/hooks/userprompt — UserPromptSubmit → L1 + VGE
    │  ├─ /v1/hooks/pretool — PreToolUse → **GATING DECISION**
    │  ├─ /v1/hooks/posttool — PostToolUse → audit
    │  └─ /v1/hooks/sessionend — SessionEnd → cleanup
    │
    ├─ L1 Engine
    │  ├─ RegEx patterns (ReDoS-safe, from policies)
    │  ├─ Token analysis (prompt injection signatures)
    │  └─ Cached results (per session + conversation)
    │
    ├─ Session State Machine
    │  ├─ State: clean | caution | tainted
    │  ├─ Risk score: 0–100
    │  ├─ Per-session thresholds (from config)
    │  └─ Transitions: clean →(suspicious prompt) caution →(injection detected) tainted
    │
    ├─ VGE Client
    │  ├─ Async POST /v1/guard/input for borderline prompts
    │  ├─ Cached L2 results (5 min TTL)
    │  └─ Exponential backoff on failure
    │
    └─ Audit Logger
       ├─ Local JSON log (decisions, timestamps, risk scores)
       └─ Async flush to VGE /v1/audit/events
```

---

## 5. Phase 1 Deliverables

**npm package: `vge-cc-guard`** (published to npm registry)

```
vge-agent-guard/
├── package.json                                  # npm package metadata
│   └── "bin": { "vge-cc-guard": "dist/cli.js" }   # CLI entry point
│
├── src/
│   ├── cli.ts                                    # `vge-cc-guard install` / `config` / `daemon`
│   ├── daemon/
│   │   ├── http-server.ts                        # Listener for hook endpoints
│   │   ├── l1-engine.ts                          # Pattern matching, heuristics
│   │   ├── session-state.ts                      # State machine
│   │   ├── vge-client.ts                         # VGE communication
│   │   └── audit-logger.ts                       # Decision logging
│   │
│   └── tui/
│       └── config-ui.ts                          # `vge-cc-guard config` TUI
│
├── config/
│   └── default-policies.json                     # Default L1 rules (bundled)
│
├── tests/
│   ├── l1-engine.test.ts
│   ├── session-state.test.ts
│   └── integration/
│       └── claude-code-integration.test.ts
│
├── docs/
│   ├── INSTALLATION.md                           # How to install Phase 1
│   └── ARCHITECTURE.md                           # Deep dive on state machine
│
└── .github/workflows/
    └── npm-publish.yml                           # Build + publish to npm
```

**Installation for users:**
```bash
npm install -g vge-cc-guard
vge-cc-guard install      # Installs hooks in ~/.claude/settings.json
vge-cc-guard config       # TUI to configure tool policies
vge-cc-guard daemon       # Starts the sidecar (runs in background)
```

---

## 6. Phase 1 Implementation Phases (Sub-phases)

### 6.1 Phase 1a — MVP: Full Sidecar with Tool Gating (3-4 weeks)

**Minimal viable product: Phase 0 logging + PreToolUse gating.**

- [ ] HTTP sidecar (Node.js + Express)
- [ ] UserPromptSubmit hook handler → POST `/v1/guard/input` (Phase 0 func)
- [ ] PostToolUse hook handler → POST `/v1/guard/output` (Phase 0 func)
- [ ] L1 engine: 50 regex patterns (SQL injection, command injection, etc.)
- [ ] Session state machine: clean → caution → tainted
- [ ] PreToolUse hook handler → return ALLOW/BLOCK (gating decision)
  - Check L1 + session state
  - Boost threshold if session tainted
- [ ] Config: environment variables (no TUI yet)
- [ ] Tests: unit tests for L1, session state, integration test with Claude Code
- [ ] Acceptance: PreToolUse latency p99 < 50ms, UserPromptSubmit async non-blocking, no false positives

### 6.2 Phase 1b — Resilience & Observability (1-2 weeks)

- [ ] Error handling: VGE unreachable → fallback to L1-only decisions (no BLOCK timeout)
- [ ] Caching: 5-min TTL for VGE L2 results (for borderline L1 cases)
- [ ] Local debug logging: structured JSON logs (phase, decision, latency, scores)
  - Log rotation: max 50MB per file, keep 5 last files
- [ ] Connection retry: exponential backoff for VGE POST (3 retries, max 5s total)
- [ ] Tests: error path testing, cache hit/miss scenarios
- [ ] Acceptance: sidecar survives 10-minute VGE outage without crashing, all decisions logged locally

### 6.3 Phase 1c — Polish (1-2 weeks)

- [ ] TUI: `vge-cc-guard config` for settings
- [ ] Error handling: graceful degradation (L1 only if VGE down)
- [ ] Local debug logging: structured logs for troubleshooting (JSON to file)
  - Log rotation: max 50MB per file, keep 5 last files, auto-delete old logs
- [ ] Installer: `vge-cc-guard install` sets up ~/.claude/settings.json
- [ ] Acceptance: e2e test with real Claude Code session

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

**Implementation:** Start Phase 1a with TypeScript. If GC latency proves problematic, can optimize with native modules (node-regex, re2) or later rewrite L1 engine in Rust with FFI.

### 7.2 L1 Heuristics (Safe Patterns Only)

- Use ReDoS-safe regex library (`safe-regex` npm or Rust equivalent).
- Patterns are allowlisted by VGE security team (no user-supplied regexes).
- Local caching to avoid recalculating for repeated prompts.
- L1 is **advisory** — false positives are acceptable (VGE is the ground truth).

### 7.3 Session State Scope

- **Scope:** per Claude Code session (not global across user's machine)
- **Lifetime:** created at SessionStart, destroyed at SessionEnd
- **Shared state:** conversation messages (for context), risk scores, state transitions
- **Not shared:** between projects or Claude Code instances

### 7.4 Tool Blocklist

- **Configurable:** operators define which tools are "gatable" (e.g., Bash, code-execution).
- **Default:** only Bash and similar high-risk tools. Read, Write are exempt.
- **Override:** per-project in `~/.claude/settings.json` (e.g., "allow all tools").

---

## 8. Phase 1 Acceptance Criteria

1. **PreToolUse latency:** p99 < 50ms (local decision without VGE roundtrip).
2. **False-positive rate:** < 2% on benign prompts (measured against Pangea dataset).
3. **False-negative rate:** < 15% on injection attempts (within L1 capability; L2 catches the rest).
4. **Session state transitions:** clear documentation + unit tests for clean → caution → tainted flows.
5. **Tool gating:** BLOCK decision is honored (no tool execution); ALLOW lets tool run.
6. **Audit logging:** all decisions logged locally + flushed to VGE within 10 seconds.
7. **Graceful degradation:** if VGE unreachable, sidecar falls back to L1 only (does not crash).
8. **Installer:** `vge-cc-guard install` successfully sets up both Phase 0 (hook) and Phase 1 (sidecar) in one command.
9. **Documentation:** installation, configuration, troubleshooting all documented.

---

## 9. Phase 1 Timeline (Estimate)

| Milestone | Duration | Deliverable |
|-----------|----------|-------------|
| **Phase 1a (MVP)** | 3–4 weeks | Phase 0 logging + PreToolUse gating + session state |
| **Phase 1b (Resilience)** | 1–2 weeks | Error handling, caching, log rotation, retry logic |
| **Phase 1c (Polish)** | 1–2 weeks | TUI, installer, E2E test |
| **Phase 1 release** | 5–8 weeks total | `v1.0.0` tag |

---

## 10. Phase 1 vs Phase 0 Migration

### 10.1 For Users

When Phase 1 ships:

1. Run `vge-cc-guard install` (replaces Phase 0 hook)
2. Configure via `vge-cc-guard config` TUI
3. Tools are now gated; decisions logged

**No breaking change:** Phase 0 hook continues to work indefinitely for users who don't upgrade.

### 10.2 For VGE

No changes needed on VGE side. Phase 1 sidecar:
- Still POSTs to `/v1/guard/input` and `/v1/guard/output` (same format as Phase 0)
- Adds new `/v1/policies` endpoint for rule distribution
- Adds optional `/v1/audit/events` for audit log ingestion

---

## 11. Open Questions (Design TBD)

1. **Tool allowlist vs. blocklist:** Should phase 1 default to "block all" or "allow all except Bash"?
   - Current thinking: allowlist high-risk tools (Bash, Eval), exempt others.

2. **Session state across Claude Code restarts:** Should state persist (risky) or reset on restart (safe)?
   - Current thinking: reset on restart (SessionEnd hook cleans up).

3. **VGE API key distribution:** Should sidecar use same key as Phase 0, or separate sidecar-only key?
   - Current thinking: share `~/.claude/.env` key; Phase 1 installer migrates Phase 0 credentials.

---

## 12. References

- [PRD_0](../PRD_0/PRD_0.md) — User Prompt Logger (Phase 0, complete)
- [Concept doc](../../architecture/claude-code-agent-security-integration.md) — full system vision
- [ADR-0001](../../adr/ADR-0001-project-scope-and-language.md) — language choice (pending)
- VGE PRD_29 — detection pipelines
- VGE architecture — /v1/guard/input, /v1/guard/output endpoints
