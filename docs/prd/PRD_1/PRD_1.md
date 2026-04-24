# PRD_1 — Full Sidecar (Phase 0 + Phase 1)

**Status:** In Planning (Phase 0 complete, Phase 1 design in progress)  
**Author:** Tomasz Bartel  
**Created:** 2026-04-20  
**Updated:** 2026-04-24 (revision 2 — pipeline simplification)  
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
- **Tool output analysis** — configurable per-tool: sends tool output to VGE `/v1/guard/analyze` with `source: 'tool_output'` (not all tools, only explicitly classified external-content tools)
- **2-layer FP reduction pipeline** — Confidence Router (branch-agreement logic mirroring VGE's corroboration rules) + Ask Dialog for uncertain cases. No local content detection beyond config scope. Per-resource session allowlist (soft, audit-preserving) lets users grant trust to specific resources without silencing telemetry.
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
| **Tool Gating** | No enforcement; advisory only | PreToolUse hook allows/blocks execution |
| **Session State** | No multi-turn analysis | Track "clean/caution/tainted" state across prompts |
| **Local L1** | All analysis in VGE | L1 heuristics run locally for latency |
| **Configuration** | Environment variables only | vge-cc-guard TUI for settings |
| **Operator Control** | None; static rules in VGE | Server pushes policies to sidecars |
| **Performance** | 5s timeout per prompt (blocking) | Async processing, <300ms PreToolUse latency |
| **Wrong endpoint** | PostToolUse → /v1/guard/output | PostToolUse → /v1/guard/analyze + source='tool_output' |
| **Selective analysis** | All tool outputs sent to VGE | Per-tool `analyze_output` config flag |

---

## 3. Phase 1 Scope

### 3.1 Goals

Phase 1 must:

1. **Replace Phase 0 bash hook:** Handle `UserPromptSubmit` and `PostToolUse` hooks in sidecar, log to `/v1/guard/input` and (where configured) `/v1/guard/analyze` with `source: 'tool_output'`.
2. **Tool gating via PreToolUse:** Intercept tool execution, run L1 check + check session state, return ALLOW/BLOCK before tool executes.
3. **Selective tool output analysis:** Per-tool `analyze_output` flag in config. Only tools explicitly classified as external-content sources send output to VGE. See section 7.5.
4. **Session state machine:** Track conversation state (clean → caution → tainted) based on detection signals. Boost risk scoring for risky prompts in tainted sessions.
5. **Local L1 heuristics:** Run pattern matching locally. Fast path: <10ms decision for obvious attacks without network.
6. **VGE fallback:** For borderline L1 cases, async POST to VGE for semantic/llm-guard analysis (non-blocking).
7. **Configuration UI:** `vge-cc-guard config` TUI lets users enable/disable features, set thresholds, choose which tools are gatable and which send output to VGE.
8. **Graceful degradation:** If VGE unreachable, sidecar falls back to L1-only decisions (no blocking of Claude Code). On VGE analysis error: log and continue — never block on analysis failure.

### 3.2 Non-Goals

Phase 1 explicitly does **not**:

1. Replace VGE detection — L1 is fast heuristics only; semantic/llm-guard remain in VGE.
2. Implement content moderation — that stays in VGE arbiter.
3. Provide user-facing approval dialogs — this is server-enforced only.
4. Support custom rule scripting — policies are JSON templates from server.
5. Handle multi-session correlation — that's Phase 2 (session replay).
6. Implement OTel/observability — that's Phase 2.
7. Log raw tool output payloads — `analyze_output` means "send to VGE for analysis", not "persist raw content". Consistent with VGE's own `storePromptContent` / `agentContextLoggingEnabled` separation.

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
    │     ├─ Async POST /v1/guard/input (VGE)
    │     └─ Update session state
    │
    ├─ PreToolUse
    │  └─ POST to sidecar (local) — CRITICAL PATH
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
    │  └─ Async processing (non-blocking)
    │     ├─ Step 1: Check tool config — analyze_output?
    │     │  ├─ false → metadata-only audit event (tool_name,
    │     │  │         session_id, timestamp; no content, no detection)
    │     │  │         END
    │     │  └─ true  → continue to Step 2
    │     │
    │     ├─ Step 2: Check session allowlist — (tool, resource_id) trusted?
    │     │  ├─ YES → still POST /v1/guard/analyze for audit
    │     │  │        run Confidence Router for audit
    │     │  │        LOG with user_allowlisted=true,
    │     │  │        enforcement_taken=none
    │     │  │        NO session state change, NO ask-dialog
    │     │  │        END
    │     │  └─ NO  → continue to Step 3
    │     │
    │     ├─ Step 3: Truncate to 64KB, POST /v1/guard/analyze
    │     │          (source: tool_output)
    │     │          on error: log_and_continue (never block)
    │     │
    │     └─ Step 4: Feed VGE result into 2-layer pipeline (see 4.2)
    │        ├─ HARD_TAINT → update session state → TAINTED, audit
    │        ├─ SOFT_TAINT → update session state → CAUTION, audit
    │        ├─ ALLOW      → audit only
    │        └─ ESCALATE   → enqueue pending_escalation
    │                        (asked at next PreToolUse, no timeout)
    │
    └─ SessionEnd
       └─ Flush audit log, pending queue, allowlist; delete session state
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
| Obvious attack (≥2 branches agree, or single branch score ≥ 90) | Hard block, session tainted |
| Uncertain (single branch, score 55–89) | Ask dialog with flagged snippet, user decides (no timeout) |
| Resource already allowlisted by user | Nothing visible; audit still captures VGE analysis (soft allowlist) |

**Design intent:** multi-branch corroboration handles high-confidence cases without asking; the single-branch grey zone (where cybersec educational content typically lives) goes to the user; once user trusts a specific resource, further hits on that resource don't re-ask but still log to VGE for audit and FP analytics.

### 4.3 Sidecar Internal Architecture

```
vge-cc-guard sidecar (single process, TypeScript + Node.js)
    │
    ├─ HTTP listener (localhost:9090, Unix socket)
    │  ├─ /health — readiness probe
    │  ├─ /v1/hooks/presession — SessionStart → init state
    │  ├─ /v1/hooks/userprompt — UserPromptSubmit → L1 + VGE
    │  ├─ /v1/hooks/pretool — PreToolUse → GATING DECISION
    │  ├─ /v1/hooks/posttool — PostToolUse → selective analysis + audit
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
    ├─ Tool Policy Engine
    │  ├─ Per-tool config: { gate, analyze_output }
    │  ├─ Default classifications (see section 7.5)
    │  └─ Wildcard fallback: "*" entry
    │
    ├─ FP Reduction Pipeline
    │  ├─ Confidence Router (section 7.7)
    │  ├─ Ask Dialog + pending_escalation queue (section 7.9)
    │  └─ Resource Allowlist (per (tool, resource_id), section 7.10)
    │
    ├─ Session Store (in-memory, keyed by session_id from CC hooks)
    │  ├─ state: clean | caution | tainted
    │  ├─ allowlist: Set<(tool, resource_id)>
    │  ├─ pending_escalations: Queue
    │  ├─ escalation_count (approval fatigue cap)
    │  └─ TTL cleanup: 24h idle → garbage collect
    │
    ├─ VGE Client
    │  ├─ Async POST /v1/guard/input for user prompts
    │  ├─ Async POST /v1/guard/analyze (source='tool_output') for tool outputs
    │  ├─ Payload truncation: text ≤ 100k chars, tool result ≤ 64KB
    │  ├─ Cached L2 results (5 min TTL)
    │  └─ Exponential backoff on failure (3 retries, max 5s total)
    │
    └─ Audit Logger
       ├─ Local JSON log (decisions, timestamps, risk scores)
       ├─ Does NOT log raw tool output content
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
│   │   ├── tool-policy.ts                        # Per-tool gate + analyze_output resolution
│   │   ├── vge-client.ts                         # VGE communication
│   │   └── audit-logger.ts                       # Decision logging (no raw content)
│   │
│   └── tui/
│       └── config-ui.ts                          # `vge-cc-guard config` TUI
│
├── config/
│   └── default-policies.json                     # Default tool classifications + L1 rules
│
├── tests/
│   ├── l1-engine.test.ts
│   ├── session-state.test.ts
│   ├── tool-policy.test.ts
│   └── integration/
│       └── claude-code-integration.test.ts
│
├── docs/
│   ├── INSTALLATION.md
│   └── ARCHITECTURE.md
│
└── .github/workflows/
    └── npm-publish.yml
```

### 5.1 Per-Tool Config Schema

Each tool entry in `~/.vge-cc-guard/config.json`:

```json
{
  "tools": {
    "WebSearch":  { "gate": "allow", "analyze_output": true  },
    "WebFetch":   { "gate": "allow", "analyze_output": true  },
    "Bash":       { "gate": "block", "analyze_output": false },
    "Write":      { "gate": "block", "analyze_output": false },
    "Edit":       { "gate": "block", "analyze_output": false },
    "Read":       { "gate": "allow", "analyze_output": false },
    "Glob":       { "gate": "allow", "analyze_output": false },
    "Grep":       { "gate": "allow", "analyze_output": false },
    "*":          { "gate": "ask",   "analyze_output": false }
  }
}
```

**Field semantics:**

| Field | Values | Meaning |
|-------|--------|---------|
| `gate` | `"allow"` \| `"block"` \| `"ask"` | PreToolUse decision |
| `analyze_output` | `true` \| `false` | Send PostToolUse output to `/v1/guard/analyze` |

**`analyze_output` is not `log_output`** — it means "submit to VGE detection pipeline". Raw content is never persisted by the sidecar, consistent with VGE's own `storePromptContent` / `agentContextLoggingEnabled` separation.

---

## 6. Phase 1 Implementation Phases (Sub-phases)

### 6.1 Phase 1a — MVP: Full Sidecar with Tool Gating (3-4 weeks)

**Minimal viable product: Phase 0 logging + PreToolUse gating + selective PostToolUse analysis.**

- [ ] HTTP sidecar (Node.js + Express)
- [ ] UserPromptSubmit hook handler → POST `/v1/guard/input`
- [ ] PostToolUse hook handler → POST `/v1/guard/analyze` (`source: 'tool_output'`) only when `analyze_output: true`
- [ ] Payload truncation before VGE calls (text ≤ 100k chars, tool result ≤ 64KB)
- [ ] `on_analysis_error: continue` — VGE failure never blocks tool execution
- [ ] L1 engine: 50 regex patterns (SQL injection, command injection, etc.)
- [ ] Session state machine: clean → caution → tainted
- [ ] PreToolUse hook handler → return ALLOW/BLOCK (gating decision)
  - Check L1 + session state
  - Boost threshold if session tainted
- [ ] **Confidence Router (Layer 1)** — replaces blanket `score >= 40 → taint`; uses branch agreement rules from section 7.7
- [ ] Per-tool config with `gate` + `analyze_output` (object format)
- [ ] Config: JSON file at `~/.vge-cc-guard/config.json` (no TUI yet)
- [ ] Tests: unit tests for L1, session state, tool-policy, confidence-router, integration test with Claude Code
- [ ] Acceptance: PreToolUse latency p99 < 50ms, UserPromptSubmit async non-blocking, no false positives

### 6.2 Phase 1b — Resilience & Observability (1-2 weeks)

- [ ] Error handling: VGE unreachable → fallback to L1-only decisions (no BLOCK timeout)
- [ ] Caching: 5-min TTL for VGE L2 results (for borderline L1 cases)
- [ ] Local debug logging: structured JSON logs (phase, decision, latency, scores) — no raw content
  - Log rotation: max 50MB per file, keep 5 last files, auto-delete logs older than 7 days
- [ ] Connection retry: exponential backoff for VGE POST (3 retries, max 5s total)
- [ ] Session state persistence to `~/.vge-cc-guard/sessions/<id>.json` (survives sidecar restart within session TTL)
- [ ] Tests: error path testing, cache hit/miss, truncation boundary scenarios, session persistence roundtrip
- [ ] Acceptance: sidecar survives 10-minute VGE outage without crashing, all decisions logged locally; session state survives sidecar restart

### 6.3 Phase 1c — Polish (1-2 weeks)

- [ ] TUI: `vge-cc-guard config` for settings including per-tool `analyze_output` toggle
- [ ] **Ask Dialog (Layer 2)** — pending_escalation queue, PreToolUse `decision: "ask"` channel, prompt-reply parser per sections 7.9 and 7.9.1
- [ ] **Resource Allowlist** — per (tool, resource_id), soft pass-through with full audit, session-scoped per section 7.10
- [ ] **Audit Trail** — escalation lifecycle events to VGE `/v1/audit/events` or local fallback, per section 7.9.2
- [ ] Approval fatigue caps (3/session), dedup by (tool, resource_id), `reset-session` command
- [ ] Installer: `vge-cc-guard install` sets up `~/.claude/settings.json`
- [ ] Acceptance: e2e test with real Claude Code session: WebFetch → VGE analyze → ask-dialog → `session` decision → next WebFetch on same URL goes through soft allowlist with audit event

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
- **Default:** Bash, Write, Edit blocked. Read, Glob, Grep allowed.
- **Override:** per-project in `~/.claude/settings.json` or `<project>/.claude/.env`.

### 7.5 Tool Output Analysis — Endpoint and Defaults ✅ DECIDED

**Endpoint:** `POST /v1/guard/analyze` with `source: 'tool_output'`.

**Why not `/v1/guard/output`:** That endpoint is semantically for `model_output` and hardcodes `source: 'model_output'` internally (VGE `guard-output.ts:27`). Using it for tool results would set the wrong `source` field. VGE explicitly reserves `source` for future source-aware policy routing (`docs/api/endpoints.md:258`, `packages/shared/src/schemas/index.ts:143`), so incorrect mapping now creates technical debt.

**Default `analyze_output` by category:**

| Category | Tools | `analyze_output` default | Rationale |
|----------|-------|--------------------------|-----------|
| External/network | WebSearch, WebFetch, mcp_browser | `true` | Primary vector for prompt injection via external content |
| Filesystem read | Read, Glob, Grep | `false` | **Conscious gap** — attacker-controlled files (cloned repos, downloaded artifacts, PR content) can also carry injections. Excluded from MVP defaults for noise reduction, not because they're safe. |
| Code execution | Bash, Python | `false` | **Conscious gap** — shell output can carry external content. Excluded from defaults; operators with stricter requirements should enable. |
| Filesystem write | Write, Edit | `false` | Output is content Claude wrote, not external input |
| Unknown / custom MCP | `*` | `false` | Unknown MCP may be a local DB, k8s, or secret manager. Enabling by default risks sending sensitive data to VGE and generating noise. Classify explicitly. |

**`analyze_output: false` is a documented gap, not a security guarantee.** Operators who need full coverage should enable it per tool. The default is a signal/noise tradeoff for MVP.

### 7.6 VGE Payload Limits and Fail-Mode

VGE enforces the following limits (from `packages/shared/src/schemas/index.ts:86`):

| Field | Limit |
|-------|-------|
| `text` | 100,000 characters |
| `tool.result.content` | 64 KB |
| `conversation` | 256 KB total |

**Sidecar behavior:**
- Truncate tool output to 64KB before sending to `/v1/guard/analyze`. Log truncation event.
- If truncated content cannot represent injection signal meaningfully (e.g., binary data), send hash-only placeholder and skip content field.
- On VGE analysis error (timeout, 4xx, 5xx): `log_and_continue` — the tool that already ran is not retroactively blocked, and the next tool is not blocked because of an analysis failure. Session state is not updated on error.
- This fail-mode is intentional: analysis errors must not degrade Claude Code usability.

### 7.7 Confidence Router (Layer 1)

Runs on every `GuardResponse` from PostToolUse analysis. Deterministic, no network calls.

**Branch trigger thresholds:**

| Branch | Counts as "triggered" if score ≥ |
|--------|-----------------------------------|
| `heuristics` | 50 |
| `semantic` | 50 |
| `llmGuard` | 55 |

**Routing rules (evaluated top to bottom):**

```
agreed_branches = count(branches where score >= branch_threshold)

if agreed_branches >= 2                      → HARD_TAINT
if agreed_branches == 1 and total_score >= 90 → HARD_TAINT  (high-score safety guard)
if agreed_branches == 1 and total_score 55..89 → ESCALATE   (layer 2)
if agreed_branches == 1 and total_score < 55  → SOFT_TAINT (caution, no block)
if agreed_branches == 0                      → ALLOW       (log only)
```

**Rationale:**

- `agreed_branches >= 2` mirrors VGE's `LLM_GUARD_VETO.requires_corroboration=true` rule. Multi-branch agreement is the strongest signal; no FP mitigation needed.
- The score-90 safety guard catches extreme single-branch signals (e.g., `llmGuard=95` on a clearly malicious payload) that even educational markers shouldn't rescue.
- The 55–89 single-branch band is exactly the FP-prone zone for cybersec content — educational markers get a chance in layer 2, user gets a chance in layer 3.
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
3. Removing Layer 2 leaves one trust mechanism (resource allowlist, section 7.10) instead of two overlapping ones.

Kept for historical reference. Not part of MVP.

### 7.9 Ask Dialog (Layer 2)

Runs when Layer 1 returns `ESCALATE`. PostToolUse already ran — we cannot undo it. The question is whether the *next* tool call should proceed on a potentially compromised session, and whether the user trusts this specific resource going forward.

**Mechanism (MVP — uses Claude Code hook):**

1. Sidecar enqueues the escalation in `pending_escalations` (per-session FIFO). Payload includes `(tool_name, resource_id, branches, trigger_snippet, escalation_id)`.
2. On next `PreToolUse` hook: sidecar checks the queue. If non-empty, it short-circuits the normal gate decision and returns `{"decision": "ask", "reason": <formatted dialog>}`.
3. Claude Code displays `reason` to the user and pauses. Pending escalation blocks *every* subsequent PreToolUse until resolved.
4. User replies in the next prompt. Sidecar parses the reply (see 7.9.1).
5. Sidecar applies the decision, emits audit event (see 7.9.2), pops the queue. The blocked PreToolUse either proceeds or is rejected based on the decision.

**No timeout.** The sidecar waits indefinitely for the user to reply. There is no timer and no auto-decision on elapsed time. Rationale: automated decisions on timeout either default to `block` (degrades UX for FPs) or `allow` (silently accepts real attacks). Neither is acceptable. A pending escalation halts the agent.

**Ambiguous reply → re-ask, not auto-block.** If the first token of the user's prompt doesn't match the decision vocabulary, sidecar re-emits the same `decision: "ask"` with an added line `⚠ unrecognized reply — use one of: once / session / block / quarantine`. Repeats indefinitely.

**Dialog format (the `reason` string):**

```
⚠ Tool output flagged by VGE — needs your decision before continuing

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
    block       — discard the result
    quarantine  — accept but keep session on caution for 3 turns
```

**Approval fatigue protections:**

- Max 3 ask-dialogs per session. After cap, further `ESCALATE` outcomes auto-convert to `HARD_TAINT` with audit flag `auto_hard_tainted_due_to_fatigue_cap=true`.
- Dedup: if the same `(tool_name, resource_id)` already had a dialog in this session, reuse the previous decision without asking. Different resources always ask separately even if same tool.
- User escape hatch: `vge-cc-guard reset-session` clears the counter, queue, and allowlist.

**Phase 2 upgrade path:** replace the Claude Code hook channel with a dedicated Unix socket + TUI prompt (`vge-cc-guard prompt`). Better UX (separate terminal, structured input, inline diff of trigger context) but requires users to keep the TUI open. Out of scope for Phase 1.

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
5. No match → ambiguous → re-ask.
6. If match has residual text after the decision token(s), the residual is treated as the user's actual prompt and goes through normal `/v1/guard/input` detection. The decision token itself is **not** sent to VGE as user content — only as an audit event (see 7.9.2).

**Attack-in-reply handling:** residual prompt is independently analyzed by VGE. Accepting the decision does not imply accepting the residual's content. If residual triggers a new detection, standard flow applies (new Confidence Router evaluation, potential new escalation).

**Session mismatch protection:** sidecar verifies `session_id` on the incoming hook matches the queued escalation's session. Mismatch (e.g., Claude Code restarted between dialog and reply) → queue is flushed for the new session; parser is a no-op; prompt flows normally.

### 7.9.2 Audit Trail for Escalation Decisions

Every stage of the escalation lifecycle emits an audit event. The decision token itself is never sent to `/v1/guard/input` — it is only captured in audit.

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

**Delivery:** sidecar posts these to VGE `/v1/audit/events` (new endpoint, to be specified with VGE team). Fallback: if audit endpoint unavailable in MVP, events go to local JSON log only (`~/.vge-cc-guard/audit.log`) and are flushed on SessionEnd.

**Why this matters:**

- Investigation UI can show full chain: `flagged → escalated → resolved=user_allow → 5 subsequent pass-throughs all ALLOW` → clear story for audit
- Analytics: per-resource escalation resolution rates feed back into VGE FP/FN tuning. Resources with consistent `decision=once/session` across users are candidates for VGE semantic model review
- Whitelisted-pass-through events are the safety net: if a trusted resource suddenly produces `HARD_TAINT` outcomes, investigation sees it even though the user session wasn't blocked

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

| Tool | resource_id |
|------|-------------|
| `WebFetch` | Full URL (scheme + host + path + query), fragment `#` stripped |
| `WebSearch` | The search query string |
| `Read` | Absolute canonical file path |
| `Glob` | Pattern + cwd |
| `Grep` | Pattern + absolute path |
| MCP / custom | SHA-256 hash of canonicalized JSON input (volatile fields like timestamps excluded) |

**Behavior on match (soft allowlist — this is the critical design point):**

When a PostToolUse hits an allowlisted `(tool, resource_id)`:

1. Sidecar still POSTs to `/v1/guard/analyze` (VGE receives full content for telemetry).
2. Sidecar still runs Confidence Router (full branch analysis).
3. Audit event is written with `user_allowlisted=true`, `router_outcome=<actual>`, `enforcement_taken=none`.
4. **No session state change** — even if router returns `HARD_TAINT`, sidecar does not taint.
5. **No ask-dialog** — user already decided for this resource.
6. Tool output flows to Claude Code normally.

Rationale: user's conscious trust decision is final for the duration of the session. But the telemetry is preserved — VGE analytics continue to see whether allowlisted resources remain benign over time, and investigation can flag compromised-CDN-style scenarios post-hoc.

**Why not skip VGE entirely:** silent trust is a blind spot. An allowlisted resource that starts returning attacks would otherwise go completely unmonitored until SessionEnd. Soft allowlist keeps the observation loop intact without re-bothering the user.

**Scope:** session-only for MVP. No project-level or user-level persistence. Justification: allowlist entries are granular (per-resource), so persistent storage would accumulate stale entries quickly and lose meaning. Session scope matches the granularity.

**Approval fatigue interaction:** allowlist check runs **after** the escalation cap check. If cap reached, further escalations auto-`HARD_TAINT` and never get the chance to add to allowlist. User must `reset-session` to resume adding entries.

**Reset:** `vge-cc-guard reset-session` clears the allowlist alongside pending queue and escalation counter.

---

## 8. Phase 1 Acceptance Criteria

1. **PreToolUse latency:** p99 < 50ms (local decision without VGE roundtrip).
2. **False-positive rate:** < 2% on benign prompts (measured against Pangea dataset).
3. **False-negative rate:** < 15% on injection attempts (within L1 capability; L2 catches the rest).
4. **Session state transitions:** clear documentation + unit tests for clean → caution → tainted flows.
5. **Tool gating:** BLOCK decision is honored (no tool execution); ALLOW lets tool run.
6. **Audit logging:** all decisions logged locally + flushed to VGE within 10 seconds.
7. **Graceful degradation:** if VGE unreachable, sidecar falls back to L1 only (does not crash).
8. **VGE endpoint correctness:** PostToolUse analysis uses `/v1/guard/analyze` with `source: 'tool_output'`. `/v1/guard/output` is never called for tool results.
9. **Payload limits:** tool output truncated to 64KB before sending; truncation logged. No 400 errors from oversized payloads.
10. **Analysis fail-mode:** VGE error on PostToolUse analysis → `log_and_continue`; no tool blocked, no crash.
11. **Unknown tool default:** unrecognized tools have `gate: ask`, `analyze_output: false` unless explicitly configured.
12. **Confidence Router correctness:** no single-branch trigger under score 90 produces `HARD_TAINT`; ≥2 branches agreeing always produces `HARD_TAINT`. Unit tests cover boundary cases (54/55, 89/90, single vs multi-branch).
13. **Ask dialog protocol:** `ask` return reaches user with full context (branches, trigger snippet, reason); user reply parsed for `once`/`session`/`block`/`quarantine` (aliases supported); ambiguous replies trigger re-ask, not auto-block; no timeout — sidecar waits indefinitely.
14. **Reply preprocessing correctness:** decision token never reaches `/v1/guard/input`; residual prompt is independently analyzed; attack-in-reply produces new detection cycle; session_id mismatch voids queued escalation safely.
15. **Resource allowlist semantics:** allowlist key is `(tool_name, resource_id)` with canonicalized resource. Different URL on same host = different entry. `session` decision adds to allowlist; `once` does not. Allowlist is session-scoped only.
16. **Soft allowlist pass-through:** allowlisted (tool, resource_id) still triggers VGE analysis and Confidence Router for audit, but produces no enforcement action. Audit events flag `user_allowlisted=true`. Session state does not transition on allowlisted pass-throughs.
17. **Audit trail completeness:** every escalation lifecycle stage (flagged, resolved, subsequent allowlisted pass-through) produces an audit event. Events contain escalation_id linking the full chain. Investigation UI can reconstruct the story.
18. **Approval fatigue cap:** after 3 dialogs in a session, further `ESCALATE` outcomes auto-convert to `HARD_TAINT` with `auto_hard_tainted_due_to_fatigue_cap=true` flag. `reset-session` clears counter, queue, and allowlist.
19. **Session lifecycle:** `session_id` from CC hooks is the authoritative key. SessionStart creates state, SessionEnd flushes and deletes. 24h idle TTL garbage-collects orphaned sessions. Concurrent sessions don't share allowlists.
20. **Installer:** `vge-cc-guard install` successfully sets up both Phase 0 (hook) and Phase 1 (sidecar) in one command.
21. **Documentation:** installation, configuration, troubleshooting, pipeline behavior, dialog vocabulary all documented.

---

## 9. Phase 1 Timeline (Estimate)

| Milestone | Duration | Deliverable |
|-----------|----------|-------------|
| **Phase 1a (MVP)** | 3–4 weeks | Phase 0 logging + PreToolUse gating + session state + selective PostToolUse analysis + Confidence Router (Layer 1) |
| **Phase 1b (Resilience)** | 1–2 weeks | Error handling, caching, log rotation, retry logic, session state persistence |
| **Phase 1c (Polish)** | 2–3 weeks | TUI, installer, Ask Dialog (Layer 2), Resource Allowlist, Audit Trail, E2E test |
| **Phase 1 release** | 5–8 weeks total | `v1.0.0` tag |

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
- Adds new `/v1/policies` endpoint for rule distribution (future)
- Adds optional `/v1/audit/events` for audit log ingestion (future)

---

## 11. Open Questions (Design TBD)

1. **Session state across Claude Code restarts:** Should state persist (risky) or reset on restart (safe)?
   - Current thinking: reset on restart (SessionEnd hook cleans up).

2. **VGE API key distribution:** Should sidecar use same key as Phase 0, or separate sidecar-only key?
   - Current thinking: share `~/.claude/.env` key; Phase 1 installer migrates Phase 0 credentials.

3. **Truncation strategy for structured tool output:** WebFetch may return JSON/HTML; truncating at byte boundary may produce invalid JSON. Should sidecar attempt to preserve structure, or always truncate at character boundary and let VGE handle it?
   - Current thinking: truncate at character boundary, add `"[truncated]"` suffix. VGE already handles partial content.

4. **Per-project `analyze_output` override:** Should project-level config be able to add tools to `analyze_output: true` beyond the user-level defaults?
   - Current thinking: yes, via `<project>/.claude/.env` or a project-level `vge-cc-guard.json`. Design in Phase 1b.

5. **Audit endpoint on VGE:** section 7.9.2 assumes `/v1/audit/events` exists. If VGE doesn't yet have this endpoint, sidecar falls back to local JSON log only. Needs coordination with VGE team — either extend `events_v2` schema with escalation fields, or add a dedicated `agent_escalation_decisions` table.
   - Current thinking: local-log-only for Phase 1c MVP; VGE endpoint in Phase 2 after schema decision.

6. **Ask-dialog channel upgrade:** MVP uses Claude Code `decision: "ask"` hook with prompt-reply parsing. Phase 2 option: Unix socket + dedicated TUI window for richer interaction.
   - Current thinking: MVP channel is good enough for Phase 1c; evaluate TUI upgrade after real-user feedback.

7. **Resource canonicalization for WebFetch — query params:** should `?ref=github` and bare URL count as the same resource or different? Strict approach (as currently spec'd) treats them as different.
   - Current thinking: strict match for MVP. Strip well-known tracking params (`utm_*`, `fbclid`, `ref`) as a pragmatic normalization in Phase 1c. Full URL including fragment-stripped query is the MVP key.

---

## 12. References

- [PRD_0](../PRD_0/PRD_0.md) — User Prompt Logger (Phase 0, complete)
- [Concept doc](../../architecture/claude-code-agent-security-integration.md) — full system vision
- [ADR-0001](../../adr/ADR-0001-project-scope-and-language.md) — language choice (TypeScript, decided)
- VGE `guard-output.ts:27` — source: 'model_output' hardcoded, confirms wrong endpoint for tool results
- VGE `docs/api/endpoints.md:258` — /v1/guard/analyze source field semantics
- VGE `packages/shared/src/schemas/index.ts:86,143` — payload limits and source field schema
- VGE `detection-pipeline.ts:260` — agentContextLoggingEnabled pattern (analyze vs. log separation)
- VGE `decision-pipeline-helpers.ts:382` — storePromptContent pattern
- VGE `decision-pipeline-helpers.test.ts:462` — raw snapshot protection tests
