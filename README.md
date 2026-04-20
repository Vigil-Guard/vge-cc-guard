# vg-cc — VGE logger for Claude Code

Hooks Claude Code prompts and tool responses into Vigil Guard Enterprise (VGE) for detection logging. **Universal installation** — install once in `~/.claude/`, works everywhere automatically.

**Phase 0 (current):**
- Logs every user prompt via `/v1/guard/input` — one row per prompt in VGE `events_v2`
- Logs every tool response via `/v1/guard/output` — for output injection detection
- Captures framework, session, prompt ID, hook event, tool context, and conversation digest
- Results: VGE Investigation tab shows all events (framework = `claude-code`)

**What it does NOT do:** no enforcement, no tool gating, no BLOCK. Fire-and-forget advisory only.

**Safety:** always exits 0 (fail-open). Network errors, invalid credentials, or VGE downtime never blocks Claude Code.

---

## Architecture

```
┌─────────────────┐
│  Claude Code    │  Runs in any project directory
└────────┬────────┘
         │ (CC sets CLAUDE_PROJECT_DIR automatically)
         ▼
┌─────────────────────────────────────────┐
│  ~/.claude/vg-cc/user-prompt-submit.sh  │  ← UNIVERSAL hook (ONE copy)
│  ~/.claude/settings.json                │  ← UNIVERSAL registration
└────────────────┬────────────────────────┘
                 │ Loads project-specific .env
                 ▼
        ┌────────────────────┐
        │ $CLAUDE_PROJECT_DIR│  ← From CC environment
        │/.claude/.env       │     (e.g., ~/Development/test/.claude/.env)
        │                    │
        │ VGE_API_URL        │
        │ VGE_API_KEY        │
        └────────┬───────────┘
                 │
                 ▼
        ┌────────────────────┐
        │  VGE API           │
        │  /v1/guard/input   │  ← User prompts
        │  /v1/guard/output  │  ← Tool responses
        └────────────────────┘
                 │
                 ▼
        ┌────────────────────┐
        │  VGE Database      │
        │  events_v2         │
        │  (Investigation UI)│
        └────────────────────┘
```

---

## Prerequisites

- `bash` ≥ 3.2 (macOS) or ≥ 4.0 (Linux)
- `jq` — JSON parsing
- `curl` — HTTP client

```bash
# macOS
brew install jq

# Debian/Ubuntu
sudo apt-get install -y jq curl
```

- VGE running and accessible over HTTPS
- API key: `vg_live_...` or `vg_test_...`

---

## Installation (Universal)

**Three steps.** One-time setup; works in all projects forever.

### Step 1 — Install hook script globally

```bash
mkdir -p ~/.claude/vg-cc
cp vg-cc/hooks/user-prompt-submit.sh ~/.claude/vg-cc/
chmod +x ~/.claude/vg-cc/user-prompt-submit.sh
```

This is the **only copy** you'll ever need. It applies to all projects.

### Step 2 — Register hook in user-level settings

Edit `~/.claude/settings.json` (create if missing):

```bash
cat > ~/.claude/settings.json <<'JSON'
{
  "hooks": {
    "UserPromptSubmit": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "$HOME/.claude/vg-cc/user-prompt-submit.sh" }] }
    ],
    "PostToolUse": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "$HOME/.claude/vg-cc/user-prompt-submit.sh" }] }
    ]
  }
}
JSON
```

**If `~/.claude/settings.json` already exists** with other content, merge only the `hooks` section:

```bash
jq '.hooks.UserPromptSubmit = [{"matcher": "", "hooks": [{"type": "command", "command": "$HOME/.claude/vg-cc/user-prompt-submit.sh"}]}] | .hooks.PostToolUse = [{"matcher": "", "hooks": [{"type": "command", "command": "$HOME/.claude/vg-cc/user-prompt-submit.sh"}]}]' ~/.claude/settings.json > /tmp/settings.tmp && mv /tmp/settings.tmp ~/.claude/settings.json
```

Verify the merge:

```bash
jq '.hooks | keys' ~/.claude/settings.json
# Should show: ["PostToolUse", "UserPromptSubmit"]
```

### Step 3 — Configure credentials per project

```json
{
  "permissions": { "allow": ["Bash(git status:*)"] },
  "hooks": {
    "PreToolUse": [
      { "type": "command", "command": "/usr/local/bin/my-lint.sh" }
    ]
  }
}
```

After merge:

```json
{
  "permissions": { "allow": ["Bash(git status:*)"] },
  "hooks": {
    "PreToolUse": [
      { "type": "command", "command": "/usr/local/bin/my-lint.sh" }
    ],
    "UserPromptSubmit": [
      { "type": "command", "command": "$HOME/.claude/vg-cc/user-prompt-submit.sh" }
    ]
  }
}
```

**Case C — target file already has `UserPromptSubmit` entries** (Lasso `claude-hooks`, custom tooling, other VGE hooks). Append, do not replace. Hooks run in array order:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "type": "command", "command": "/path/to/your/existing-hook.sh" },
      { "type": "command", "command": "$HOME/.claude/vg-cc/user-prompt-submit.sh" }
    ]
  }
}
```

Put the VGE hook last so your existing hooks run untouched.

**Validate the merged JSON before reloading CC:**

```bash
jq empty ~/.claude/settings.json && echo "JSON OK"
```

If `jq empty` errors, restore from `.bak` and try again.

### Step 3 — Configure credentials (user-level, shared by all projects)

The hook works **everywhere automatically** once you configure user-level credentials:

```bash
mkdir -p ~/.claude
cat > ~/.claude/.env <<'ENV'
VGE_API_URL=https://api.vigilguard
VGE_API_KEY=vg_test_YOUR_KEY_HERE
VGE_TIMEOUT_SECONDS=5
ENV
chmod 600 ~/.claude/.env
```

**That's it.** From now on, every project you open in Claude Code will use these credentials. No per-project configuration needed.

**Credential precedence (highest wins):**
1. Shell `export VGE_API_KEY=...` — overrides all files
2. `$CLAUDE_PROJECT_DIR/.claude/.env` — project-specific override (optional, see Advanced section below)
3. `~/.claude/.env` — user fallback (universal, used by all projects)

### Step 4 — (Optional) Per-Project Override

If a specific project needs **different credentials** (e.g., prod API key), create a project-specific `.env`:

```bash
mkdir -p <project>/.claude
cat > <project>/.claude/.env <<'ENV'
VGE_API_URL=https://api.vigilguard
VGE_API_KEY=vg_live_DIFFERENT_KEY_FOR_PROD
ENV
chmod 600 <project>/.claude/.env
```

The hook will use **this** key for that project, and fall back to `~/.claude/.env` for all others.

**For version control:**
```bash
# Ignore real credentials
echo '.claude/.env' >> <project>/.gitignore

# (Optional) Commit template with placeholders
cat > <project>/.claude/.env.example <<'ENV'
VGE_API_URL=https://api.vigilguard
VGE_API_KEY=vg_live_YOUR_KEY_HERE
ENV
git add <project>/.claude/.env.example
git commit -m "docs: add .env template for vg-cc"
```

**Env file rules** (no shell expansion):
- One `KEY=value` per line
- Keys: `^[A-Z_][A-Z0-9_]*$`
- Values: literal (no `$VAR`, no `$(cmd)`, no backticks)
- Quotes (`"..."` or `'...'`) are stripped
- `#` at column 0 = comment

**Environment variables:**

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `VGE_API_KEY` | ✅ yes | — | Bearer token `vg_live_*` or `vg_test_*` |
| `VGE_API_URL` | no | `https://api.vigilguard` | VGE endpoint |
| `VGE_TIMEOUT_SECONDS` | no | `5` | Request timeout (max 10) |
| `VGE_WIRE_FORMAT` | no | `auto` | `auto` / `typed` / `legacy` |
| `VGE_LOG_FILE` | no | `/tmp/vge-prompt-logger.log` | Debug log path |
| `VGE_DRY_RUN` | no | `0` | `1` = dry-run (no HTTP) |

### Step 5 — Verify Installation (One-time)

**Test with dry-run (no network):**

```bash
# Test from any project directory
export CLAUDE_PROJECT_DIR=$PWD
echo '{"session_id":"verify","prompt_id":"p-verify","hook_event_name":"UserPromptSubmit","prompt":"test","transcript_path":""}' \
  | VGE_DRY_RUN=1 ~/.claude/vg-cc/user-prompt-submit.sh

# Check log
tail -f /tmp/vge-prompt-logger.log
# Expected: DRY_RUN status + payload with key redacted as "vg_***"
```

**Test live (with VGE):**

```bash
# Reload Claude Code or restart the app
# Open any project in Claude Code
# Submit a prompt in the chat

# Check log (should show status=200)
tail -f /tmp/vge-prompt-logger.log
# Expected: INFO status=200 event=UserPromptSubmit session=...
```

**Verify in VGE:**

```sql
SELECT 
  timestamp, 
  agent_framework, 
  agent_hook_event,
  decision, 
  threat_score 
FROM vigil.events_v2
WHERE agent_framework = 'claude-code'
ORDER BY timestamp DESC
LIMIT 10;
```

Or in Web UI: **Investigation → filter `framework = claude-code`**

---

## How It Works

### Event Flow

```
User opens Claude Code in project/
        │
        ├─ CC sets CLAUDE_PROJECT_DIR=project/
        │
        ├─ User submits prompt
        │
        └─ CC fires UserPromptSubmit hook
           │
           ├─ Executes: ~/.claude/vg-cc/user-prompt-submit.sh
           │
           ├─ Loads project/.claude/.env (VGE credentials)
           │
           ├─ Builds JSON payload with:
           │  - prompt text
           │  - agent framework (claude-code)
           │  - session ID (from CC)
           │  - conversation digest (last 10 messages)
           │
           ├─ POSTs to /v1/guard/input
           │
           └─ Logs result (status=200, timestamp, event, session)
              │
              └─ Data appears in VGE Investigation tab
```

### Tool Output Analysis (PostToolUse)

When Claude Code executes a tool (Read, Bash, etc.), the hook also fires after tool completion:

```
Tool execution completes
        │
        └─ CC fires PostToolUse hook
           │
           ├─ Executes: ~/.claude/vg-cc/user-prompt-submit.sh
           │
           ├─ Extracts:
           │  - tool response (output)
           │  - tool name + metadata
           │  - original user prompt (for context)
           │  - session ID
           │
           ├─ Builds payload for /v1/guard/output
           │
           └─ POSTs tool output for injection detection
              └─ Detects if tool response contains prompt injection attempts
```

**Note:** PostToolUse analyzes the **tool response**, not the tool's action. For example:
- `Read` tool: analyzes file contents (not the read operation itself)
- `Bash` tool: analyzes command output/stderr (not the command execution)
- Tool response is extracted from `.tool_response` field in the hook input

### Multiple Projects (Same Machine)

Imagine you have two projects:

```
~/.claude/vg-cc/user-prompt-submit.sh      ← ONE hook, shared by all projects

~/Development/test/.claude/.env            ← Test API key (test VGE instance)
  VGE_API_KEY=vg_test_...

~/Development/prod/.claude/.env            ← Prod API key (production VGE)
  VGE_API_KEY=vg_live_...
```

**How it works:**
1. Open `~/Development/test` in CC → hook loads `test/.claude/.env` → events go to test VGE
2. Open `~/Development/prod` in CC → hook loads `prod/.claude/.env` → events go to prod VGE
3. Hook script is the same for both — only credentials differ

This is the **universal design** — one installation, many projects.

### Persistence (Session Resets)

All files are on disk and **persist across CC restarts**:

```
~/.claude/vg-cc/user-prompt-submit.sh  ← Persists (one-time install)
~/.claude/settings.json                 ← Persists (one-time registration)
~/Development/test/.claude/.env         ← Persists (per-project)
```

**No re-installation needed** — close CC, restart, open any project, hook fires automatically.

---

## Coexistence

vg-cc is **deliberately additive**:

- Registers only `UserPromptSubmit` and `PostToolUse` events
- Defers all other CC hook events for future phases
- Does NOT modify: CLAUDE.md, `.claude/skills/`, `.claude/commands/`, `.claude/agents/`, `.mcp.json`, `permissions`, git state, or shell config
- Safe alongside Lasso, custom linters, multi-MCP, project skills, and other CC configuration

---

## Uninstall

```bash
# Remove hook from all projects
rm -rf ~/.claude/vg-cc

# Remove hook registration from user settings
jq 'del(.hooks.UserPromptSubmit, .hooks.PostToolUse)' ~/.claude/settings.json > /tmp/settings.tmp && mv /tmp/settings.tmp ~/.claude/settings.json

# (Optional) Remove user-level fallback env
rm ~/.claude/.env

# Note: Project-specific ~/.claude/.env files in each project are left untouched
#       (they're gitignored, so harmless if left)
```

No other files are modified. The hook writes only to `$VGE_LOG_FILE` (default `/tmp/vge-prompt-logger.log`).

---

## Troubleshooting

| Symptom | Check |
|---------|-------|
| No events appear in VGE | `tail ~/VGE_LOG_FILE path` — look for non-200 status, `connection refused`, or missing key warning |
| `WARN VGE_API_KEY missing` | `.env` not loaded — check `chmod 600 ~/.claude/.env` and `KEY=value` syntax; try `VGE_API_KEY=vg_... ~/.claude/vg-cc/user-prompt-submit.sh <<< '{}'` as a one-off |
| HTTP `401` | Key revoked or wrong environment; verify in VGE Web UI → API Keys |
| HTTP `400` | Pre-PRD_29 VGE build — try `VGE_WIRE_FORMAT=legacy` in `.env` |
| HTTP `000` | Connectivity failure (DNS, TLS, timeout) — check `VGE_API_URL` and network |
| Self-signed cert (local dev stack) | Export `CURL_CA_BUNDLE=""` in the dev shell only — never in production; or add the local CA to your system trust store |
| Claude Code feels sluggish | Set `VGE_TIMEOUT_SECONDS=2` in `.env`; the hook is fail-open so network latency cannot actually block CC, but the 5 s default is the worst-case wait per prompt |
| Want to see what would be sent without posting | `VGE_DRY_RUN=1` in `.env` |
| PostToolUse events firing twice | Check `~/.claude/settings.json` — PostToolUse should be registered ONLY at user level, not in `project/.claude/settings.json`; remove project-level hook registration if present |
| PostToolUse `output` field is empty | Verify hook was updated to v1.1+ (reads `.tool_response` not `.prompt`); if upgrading from earlier version, re-copy: `cp vg-cc/hooks/user-prompt-submit.sh ~/.claude/vg-cc/` |

**Log file contents** — the script logs timestamp, hook event, HTTP status, session ID, and truncation flag. It never logs prompt text, API keys, or transcript paths.

---

## Compatibility matrix

| VGE build | Behavior |
|-----------|----------|
| Pre-PRD_28 | `prompt` reaches detection branches; `metadata` stored as `clientMetadata`; no `agentContext` enrichment |
| PRD_28 (alias path) | `metadata.session_id` / `prompt_id` lifted into `arbiter_json.agentContext` |
| Post-PRD_29 (typed) | `agent.*` is the primary source; flat columns `agent_session_id`, `agent_framework`, `hook_event` populate; SIEM CEF carries them |

No migration needed on your side when VGE upgrades — the script emits both wire formats and VGE picks whichever is authoritative for the running build.

---

## Roadmap to Phase 1

Phase 0 (current):
- ✅ UserPromptSubmit → `/v1/guard/input` (full detection, logging)
- ⏸ Audit events deferred pending VGE pipeline updates to avoid false BLOCKs

Phase 1:
- Audit events (PreToolUse, PostToolUse, SessionStart, SessionEnd, Stop, etc.) routed to refined `/v1/guard/analyze` pipeline or dedicated `/v1/guard/audit` endpoint
- Optional tool gating via PostToolUse (ALLOW/BLOCK decision gates tool execution)
- Session-level state tracking and risk scoring
- Full sidecar integration with CC's built-in event hooks

When Phase 1 ships:
- Merge the sidecar's hook line into your `settings.json` (one-line change alongside vg-cc's UserPromptSubmit).
- The VGE wire format is identical — no server-side change.

Users in constrained environments (CI runners, shared dev boxes, no local sidecar) can keep vg-cc indefinitely.
