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

**Phase 0** (PRD_0, now complete) delivers a lightweight bash hook that captures user prompts and forwards them to VGE for detection. It's universal (install once, works everywhere), requires no per-project setup, and stays out of the way of Claude Code.

**Phase 1** (this document) builds on Phase 0 to add a **full native sidecar** written in TypeScript/Rust. The sidecar adds:
- **Tool gating** — `PreToolUse` hook allows/blocks tool execution based on VGE decisions
- **Audit enforcement** — `PostToolUse` for tool-output analysis
- **Session state tracking** — detect prompt injections that evolve across multiple turns
- **L1/L2 heuristics locally** — fast pattern matching without network roundtrip
- **Configuration UI** — `vge-guard config` TUI for easy setup and management
- **Server-managed policies** — operators push rules without redeploying sidecars

Phase 1 is significantly more complex than Phase 0 but solves real gaps: tool gating, session risk scoring, and operator control.

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
| **Configuration** | Environment variables only | vge-guard TUI for settings |
| **Operator Control** | None; static rules in VGE | Server pushes policies to sidecars |
| **Performance** | 5s timeout per prompt (blocking) | Async processing, <300ms PreToolUse latency |

---

## 3. Phase 1 Scope

### 3.1 Goals

Phase 1 must:

1. **Tool gating via PreToolUse:** Intercept tool execution, query VGE/L1 for decision (ALLOW/BLOCK), gate tool based on risk.
2. **Session state machine:** Track conversation state (clean → caution → tainted) based on detection signals. Boost risk scoring for risky prompts in tainted sessions.
3. **Local L1 heuristics:** Run pattern matching locally before querying VGE. Fast path: reject obvious attacks in <10ms without network.
4. **L2 dispatch:** For borderline cases, async POST to VGE for semantic/llm-guard analysis. Non-blocking.
5. **Configuration UI:** `vge-guard config` TUI lets users enable/disable features, set thresholds, choose which tools are gatable.
6. **Server-managed policies:** Sidecar polls `/v1/policies` endpoint for rule updates. Operators can push rules without redeploying.
7. **Session lifecycle:** Hooks for SessionStart, SessionEnd to initialize/cleanup state.
8. **Audit trail:** Log all decisions (ALLOW/BLOCK/QUARANTINE) locally + to VGE for compliance.

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
    │  └─ vge-guard sidecar (TypeScript daemon)
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
vge-guard sidecar (single process, TypeScript + Node.js or Rust)
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
    ├─ Policy Engine
    │  ├─ Fetch /v1/policies periodically
    │  ├─ Parse rule templates (L1 patterns, thresholds, tool blocklist)
    │  └─ Hot-reload on update
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

**npm package: `vge-guard`** (published to npm registry)

```
vge-agent-guard/
├── package.json                                  # npm package metadata
│   └── "bin": { "vge-guard": "dist/cli.js" }   # CLI entry point
│
├── src/
│   ├── cli.ts                                    # `vge-guard install` / `config` / `daemon`
│   ├── daemon/
│   │   ├── http-server.ts                        # Listener for hook endpoints
│   │   ├── l1-engine.ts                          # Pattern matching, heuristics
│   │   ├── session-state.ts                      # State machine
│   │   ├── policy-engine.ts                      # Rule loading + hot-reload
│   │   ├── vge-client.ts                         # VGE communication
│   │   └── audit-logger.ts                       # Decision logging
│   │
│   └── tui/
│       └── config-ui.ts                          # `vge-guard config` TUI
│
├── config/
│   └── default-policies.json                     # Default L1 rules (bundled)
│
├── tests/
│   ├── l1-engine.test.ts
│   ├── session-state.test.ts
│   ├── policy-engine.test.ts
│   └── integration/
│       └── claude-code-integration.test.ts
│
├── docs/
│   ├── INSTALLATION.md                           # How to install Phase 1
│   ├── ARCHITECTURE.md                           # Deep dive on state machine
│   └── POLICY_FORMAT.md                          # Rule template syntax
│
└── .github/workflows/
    └── npm-publish.yml                           # Build + publish to npm
```

**Installation for users:**
```bash
npm install -g vge-guard
vge-guard install      # Installs hooks in ~/.claude/settings.json
vge-guard config       # TUI to configure thresholds, tool blocklist
vge-guard daemon       # Starts the sidecar (runs in background)
```

---

## 6. Phase 1 Implementation Phases (Sub-phases)

### 6.1 Phase 1a — MVP: PreToolUse Gating (2-3 weeks)

**Minimal viable product: tool blocking based on L1 + simple state.**

- [ ] HTTP sidecar skeleton (Node.js + Express or Rust)
- [ ] L1 engine: 50 regex patterns from VGE (basic SQL injection, command injection, etc.)
- [ ] Session state: clean/tainted, simple threshold-based transitions
- [ ] PreToolUse endpoint: return ALLOW/BLOCK based on L1 + state
- [ ] Config: environment variables (no TUI yet)
- [ ] Tests: unit tests for L1, integration test with Claude Code
- [ ] Acceptance: PreToolUse latency p99 < 50ms, no false positives on benign tools

### 6.2 Phase 1b — VGE Integration (2 weeks)

- [ ] VGE client: async POST to /v1/guard/input for borderline cases
- [ ] Caching: 5-min TTL for L2 results
- [ ] Policy fetch: /v1/policies endpoint + hot-reload
- [ ] Audit logging: flush decisions to /v1/audit/events
- [ ] Acceptance: operator can push rules, sidecar reloads without restart

### 6.3 Phase 1c — Polish (1-2 weeks)

- [ ] TUI: `vge-guard config` for settings
- [ ] Error handling: graceful degradation (L1 only if VGE down)
- [ ] Observability: structured logs, metrics (latency, decision rate)
- [ ] Installer: `vge-guard install` sets up ~/.claude/settings.json
- [ ] Acceptance: e2e test with real Claude Code session

---

## 7. Phase 1 Design Decisions

### 7.1 Language Choice — TypeScript (Node.js) ✅ DECIDED

**Decision:** TypeScript + Node.js via npm distribution.

**Rationale:**
1. **npm distribution** (critical advantage):
   - `npm install -g vge-guard` — single command, works everywhere
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
4. **Policy hot-reload:** operator pushes rule update, sidecar reloads within 30 seconds without restarting.
5. **Session state transitions:** clear documentation + unit tests for clean → caution → tainted flows.
6. **Tool gating:** BLOCK decision is honored (no tool execution); ALLOW lets tool run.
7. **Audit logging:** all decisions logged locally + flushed to VGE within 10 seconds.
8. **Graceful degradation:** if VGE unreachable, sidecar falls back to L1 only (does not crash).
9. **Installer:** `vge-guard install` successfully sets up both Phase 0 (hook) and Phase 1 (sidecar) in one command.
10. **Documentation:** installation, configuration, troubleshooting, policy format all documented.

---

## 9. Phase 1 Timeline (Estimate)

| Milestone | Duration | Deliverable |
|-----------|----------|-------------|
| **ADR-0001 finalized** | 1 week | Language decision (TS or Rust) |
| **Phase 1a (MVP)** | 2–3 weeks | PreToolUse gating working |
| **Phase 1b (VGE)** | 2 weeks | Policies, caching, audit logging |
| **Phase 1c (Polish)** | 1–2 weeks | TUI, installer, observability |
| **Phase 1 release** | 6–8 weeks total | `v1.0.0` tag |

---

## 10. Phase 1 vs Phase 0 Migration

### 10.1 For Users

When Phase 1 ships:

1. Run `vge-guard install` (replaces Phase 0 hook)
2. Configure via `vge-guard config` TUI
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

4. **L1 pattern update frequency:** How often does sidecar fetch `/v1/policies`?
   - Current thinking: 60-second polling; manual refresh on `vge-guard reload` command.

---

## 12. References

- [PRD_0](../PRD_0/PRD_0.md) — User Prompt Logger (Phase 0, complete)
- [Concept doc](../../architecture/claude-code-agent-security-integration.md) — full system vision
- [ADR-0001](../../adr/ADR-0001-project-scope-and-language.md) — language choice (pending)
- VGE PRD_29 — detection pipelines
- VGE architecture — /v1/guard/input, /v1/guard/output endpoints
