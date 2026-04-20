# vge-cc-guard — Prompt Injection Detection Sidecar for Claude Code

Native TypeScript sidecar for Claude Code that logs prompts/responses to VGE and gates tool execution based on injection risk. **Tool gating + session state tracking + local L1 heuristics.**

**Install once** → works in all Claude Code projects. One command: `npm install -g vge-cc-guard`

---

## What It Does

**Phase 1 (MVP):**
- ✅ **Logs prompts & responses** → POST `/v1/guard/input` (UserPromptSubmit) + `/v1/guard/output` (PostToolUse) to VGE
- ✅ **Gates tool execution** → `PreToolUse` hook → return ALLOW/BLOCK based on L1 check + session state
- ✅ **Session state tracking** → clean → caution → tainted (boosts risk threshold if session compromised)
- ✅ **L1 heuristics locally** → fast pattern matching (<50ms) for obvious attacks
- ✅ **Graceful VGE failover** → if VGE unreachable, falls back to L1-only (never blocks Claude Code)
- ✅ **Local debug logging** → JSON logs with log rotation (50MB max per file, keep 5 last)
- ✅ **TUI configurator** → `vge-cc-guard config` for API keys and tool policies

**What it does NOT do:** 
- No custom rule scripting
- No session correlation (Phase 2)
- No observability/metrics (VGE already logs everything)

---

## Architecture

```
Claude Code session
    │
    ├─ UserPromptSubmit hook
    │  └─ vge-cc-guard sidecar (daemon)
    │     ├─ Extract prompt + agent info
    │     ├─ POST /v1/guard/input (VGE logging)
    │     └─ Update session state
    │
    ├─ PostToolUse hook
    │  └─ vge-cc-guard sidecar
    │     ├─ Extract tool response + context
    │     ├─ POST /v1/guard/output (VGE analysis)
    │     └─ Update session state
    │
    └─ PreToolUse hook (SYNC gating)
       └─ vge-cc-guard sidecar
          ├─ Run L1 heuristics (50ms)
          ├─ Check session state (tainted → boost threshold)
          └─ Return {"decision": "ALLOW" | "BLOCK"}
             └─ Claude Code gates tool execution

Session State Machine
    clean (score: 0-39)
      ↓ (suspicious prompt detected)
    caution (score: 40-79, threshold boosted)
      ↓ (injection confirmed)
    tainted (score: 80+, all thresholds boosted)
```

---

## Prerequisites

- **Node.js** 18+ (for sidecar daemon)
- **npm** (or yarn/pnpm)
- VGE running and accessible over HTTPS
- API key: `vg_live_...` or `vg_test_...`

---

## Installation

**Three steps. One-time setup; works everywhere.**

### Step 1 — Install npm package

```bash
npm install -g vge-cc-guard
```

### Step 2 — Initialize sidecar

```bash
vge-cc-guard install
```

This registers the sidecar hooks in `~/.claude/settings.json`:
- `UserPromptSubmit` → sidecar HTTP endpoint
- `PostToolUse` → sidecar HTTP endpoint
- `PreToolUse` → sidecar HTTP endpoint (gating decision)

Starts daemon in background (port 9090, Unix socket).

### Step 3 — Configure credentials

```bash
mkdir -p ~/.vge-cc-guard
cat > ~/.vge-cc-guard/config.json <<'JSON'
{
  "version": "1.0.0",
  "vge": {
    "api_url": "https://api.vigilguard",
    "api_key_input": "vg_test_YOUR_KEY_HERE",
    "api_key_output": null
  },
  "tools": {
    "Bash": "block",
    "Write": "block",
    "Edit": "block",
    "Read": "allow",
    "Glob": "allow",
    "Grep": "allow"
  },
  "policy": {
    "vge_block_handling": "auto-block",
    "unknown_tool_default": "ask"
  }
}
JSON
chmod 600 ~/.vge-cc-guard/config.json
```

Or use interactive TUI:

```bash
vge-cc-guard config
```

**Credential precedence (highest wins):**
1. Shell `export VGE_API_KEY=...`
2. `$CLAUDE_PROJECT_DIR/.claude/.env` — project-specific override
3. `~/.vge-cc-guard/config.json` — user default
4. `~/.claude/.env` — fallback (legacy)

### Step 4 — (Optional) Per-Project Override

If a project needs different credentials (test vs prod):

```bash
mkdir -p <project>/.claude
cat > <project>/.claude/.env <<'ENV'
VGE_API_URL=https://api.vigilguard
VGE_API_KEY=vg_live_DIFFERENT_KEY_FOR_PROD
ENV
chmod 600 <project>/.claude/.env
```

### Step 5 — Verify Installation

**Check sidecar health:**
```bash
curl http://localhost:9090/health
# Expected: {"status":"healthy","version":"1.0.0"}
```

**Test with dry-run:**
```bash
VGE_DRY_RUN=1 vge-cc-guard test
```

**Check logs:**
```bash
tail -f ~/.vge-cc-guard/debug.log
```

**Verify in VGE:**
```sql
SELECT timestamp, agent_framework, agent_hook_event, decision, threat_score
FROM vigil.events_v2
WHERE agent_framework = 'claude-code'
ORDER BY timestamp DESC
LIMIT 10;
```

Or in Web UI: **Investigation → filter `framework = claude-code`**

---

## How It Works

### Event Flow (UserPromptSubmit + PreToolUse Gating)

```
User submits prompt in Claude Code
    │
    ├─ CC fires UserPromptSubmit hook
    │  └─ Sidecar receives: {prompt, session_id, prompt_id, agent_context}
    │     ├─ L1 check (50ms)
    │     ├─ Update session state (clean/caution/tainted)
    │     └─ Async POST /v1/guard/input (non-blocking)
    │
    ├─ User requests tool execution (e.g., Bash)
    │  └─ CC fires PreToolUse hook (synchronous)
    │     └─ Sidecar returns {"decision": "ALLOW" | "BLOCK"}
    │        ├─ If session is TAINTED: boost threshold (lower tolerance)
    │        ├─ If ALLOW: CC executes tool
    │        └─ If BLOCK: CC shows "Tool blocked: injection detected"
    │
    └─ Tool completes
       └─ CC fires PostToolUse hook
          └─ Sidecar receives: {tool_response, tool_name, tool_id}
             ├─ L1 check on output
             ├─ Update session state
             └─ Async POST /v1/guard/output (non-blocking)
```

### Session State Boost Example

```
Prompt 1: "hello, how are you?"
  L1 score: 10 (safe)
  Session: clean
  Decision: ALLOW

Prompt 2: "'; DROP TABLE users; --"
  L1 score: 95 (SQL injection)
  Session → TAINTED
  Decision: BLOCK ✅

Prompt 3: "read /etc/passwd"
  L1 score: 35 (normally safe)
  Session: TAINTED (from Prompt 2)
  Score × tainted_boost (1.5): 35 × 1.5 = 52.5
  Threshold: 40 → BLOCK ✅ (even though L1 < threshold)
```

Without session tracking: Prompt 3 would ALLOW.
With session tracking: Prompt 3 is BLOCKED because session is compromised.

---

## Configuration

### API Keys

| Field | Required | Default | Purpose |
|-------|----------|---------|---------|
| `vge.api_url` | no | `https://api.vigilguard` | VGE endpoint |
| `vge.api_key_input` | ✅ yes | — | Bearer token for UserPromptSubmit |
| `vge.api_key_output` | no | (uses input key) | Separate token for tool responses |

### Tool Policies

Configure per-tool action:

| Action | Behavior |
|--------|----------|
| `"allow"` | Tool always executes (no L1 check) |
| `"block"` | Tool always blocked (gated) |
| `"ask"` | Show popup to user (timeout: 30s default) |

Built-in tool categories:
- **High-risk:** Bash, Write, Edit, Agent, Python
- **Medium-risk:** Task, Read
- **Low-risk:** Glob, Grep, WebFetch, WebSearch
- **Unknown:** Custom MCP tools (default: `"ask"`)

---

## Local Debug Logging

Logs written to `~/.vge-cc-guard/debug.log`:

```json
{
  "timestamp": "2026-04-20T15:32:45.123Z",
  "hook_event": "PreToolUse",
  "tool_name": "Bash",
  "l1_score": 75,
  "session_state": "caution",
  "final_decision": "BLOCK",
  "latency_ms": 42
}
```

**Log Rotation:**
- Max 50MB per file
- Keep 5 last files
- Auto-delete logs older than 7 days

---

## Commands

```bash
# Install sidecar hooks + start daemon
vge-cc-guard install

# Interactive configuration TUI
vge-cc-guard config

# Start daemon (runs on port 9090)
vge-cc-guard daemon

# Check sidecar health
vge-cc-guard health

# View recent logs
vge-cc-guard logs [lines]

# Uninstall
vge-cc-guard uninstall
```

---

## Troubleshooting

| Symptom | Check |
|---------|-------|
| Tool always blocked | Check `tools` policy in config; verify L1 patterns not over-aggressive |
| No events in VGE | Check `vge.api_key_input` format; run `vge-cc-guard test`; check sidecar logs |
| Sidecar crashes | Check `~/.vge-cc-guard/debug.log` for errors; ensure Node.js 18+ installed |
| High latency on PreToolUse | L1 engine too slow; check sidecar resource usage; consider reducing pattern count |
| Session state stuck in TAINTED | Manual reset: `vge-cc-guard reset-session` or restart Claude Code |

---

## Uninstall

```bash
# Remove hooks from settings
vge-cc-guard uninstall

# Remove daemon + logs
rm -rf ~/.vge-cc-guard

# Remove npm package
npm uninstall -g vge-cc-guard
```

---

## Timeline

| Phase | Duration | What |
|-------|----------|------|
| **1a** | 3–4 weeks | UserPromptSubmit + PostToolUse logging + PreToolUse gating + L1 engine + session state |
| **1b** | 1–2 weeks | Error handling, caching, log rotation, retry logic |
| **1c** | 1–2 weeks | TUI configurator, installer, E2E tests |
| **Release** | ~8 weeks | `v1.0.0` |

---

## Roadmap (Phase 2+)

- [ ] OTel observability (latency histograms, decision counters)
- [ ] Multi-session correlation (replay detection)
- [ ] Custom rule templates (community-curated patterns)
- [ ] Webhook notifications (Slack on BLOCK)
- [ ] Session persistence (survived restarts)
- [ ] Web UI (alternative to TUI)

---

**Docs:** [PRD_1.md](docs/prd/PRD_1/PRD_1.md) | **Architecture:** [docs/architecture/](docs/architecture/)

**VGE:** [api.vigilguard](https://api.vigilguard) | **GitHub:** [Vigil-Guard/vge-cc-guard](https://github.com/Vigil-Guard/vge-cc-guard)
