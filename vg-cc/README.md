# vg-cc — VGE logger for Claude Code

Drops one `UserPromptSubmit` hook into Claude Code that forwards every user prompt to Vigil Guard Enterprise (VGE) for detection logging.

- **Phase 0 (current):** logs every user prompt via `/v1/guard/input` — one row per prompt in VGE `events_v2` with session/prompt IDs, framework `claude-code`, and full detection result (heuristics + semantic + llm-guard + PII).
- **What it does not do:** no enforcement, no tool gating, no session state, no BLOCK. Fire-and-forget advisory only.
- **Audit events deferred:** tool calls, session lifecycle (PreToolUse, PostToolUse, SessionStart, etc.) are deferred to Phase 1 pending VGE pipeline refinement. Current `/v1/guard/analyze` routing causes false BLOCK decisions on benign audit events and adds unnecessary load.
- **Safety:** always exits 0. A crashed, unreachable, or rate-limited VGE never blocks Claude Code.

---

## Prerequisites

- `bash` ≥ 3.2 (macOS default) or ≥ 4.0 (Linux)
- `jq` — JSON parsing
- `curl` — HTTP client

```bash
# macOS
brew install jq

# Debian/Ubuntu
sudo apt-get install -y jq curl
```

A running VGE you can reach over HTTPS, and a functional API key (`vg_live_...` or `vg_test_...`).

---

## Install

Four steps. Everything is manual and reversible — no installer to run.

### Step 1 — copy the hook script

```bash
mkdir -p ~/.claude/vg-cc
cp vg-cc/hooks/user-prompt-submit.sh ~/.claude/vg-cc/
chmod +x ~/.claude/vg-cc/user-prompt-submit.sh
```

The hook lives in `~/.claude/vg-cc/` so all Claude Code profiles share it. If you prefer a project-local copy, put it anywhere under your project and use an absolute path in Step 2.

### Step 2 — register the hook in Claude Code settings

Claude Code reads hooks from one of three files. Pick the scope you want:

| Scope | File | Effect |
|-------|------|--------|
| **User (all sessions, all projects)** | `~/.claude/settings.json` | Every CC session logs prompts |
| **Project (shared with team)** | `<repo>/.claude/settings.json` | Only this repo logs; committed to git |
| **Project (private, per-developer)** | `<repo>/.claude/settings.local.json` | Only your clone logs; gitignored |

The merge rules below apply identically to all three files.

**Back up first:**

```bash
cp ~/.claude/settings.json ~/.claude/settings.json.bak 2>/dev/null || true
```

**Case A — target file does not exist yet:** create it with the snippet verbatim.

```bash
cat > ~/.claude/settings.json <<'JSON'
{
  "hooks": {
    "UserPromptSubmit": [
      { "type": "command", "command": "$HOME/.claude/vg-cc/user-prompt-submit.sh" }
    ]
  }
}
JSON
```

**Case B — target file exists with other content.** Open it in your editor and merge *only* the `hooks.UserPromptSubmit` entry. Preserve everything else (skills, MCP servers, permissions, env, other hooks).

Example starting point — `settings.json` already has a `PreToolUse` hook and no `UserPromptSubmit`:

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

### Step 3 — configure VGE credentials via `.env`

The script auto-loads `.env` files. Precedence (highest wins):

1. `$CLAUDE_PROJECT_DIR/.claude/.env` — project-scoped (CC sets this var)
2. `~/.claude/.env` — user-scoped
3. Shell environment — wins when a variable is already exported before the hook runs

**Create the file:**

```bash
mkdir -p ~/.claude
cp vg-cc/config/.env.example ~/.claude/.env
chmod 600 ~/.claude/.env
```

Edit `~/.claude/.env` and fill in real values:

```bash
VGE_API_URL=https://api.vigilguard
VGE_API_KEY=vg_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

**File format rules** (enforced by the parser — the script does *not* `source` the file):

- One `KEY=value` per line
- Keys match `^[A-Z_][A-Z0-9_]*$`; anything else is skipped
- Values: plain or `"quoted"` / `'quoted'` (surrounding quotes are stripped); no `$VAR` / `$(cmd)` / `` `cmd` `` expansion — everything is literal
- `#` at column 0 is a comment; inline `#` is part of the value
- `export KEY=value` works but the `export ` prefix is ignored

**For project-scoped `.env`, add it to `.gitignore`:**

```bash
echo '.claude/.env' >> .gitignore
```

To share a template in git, commit `.claude/.env.example` with placeholders and keep the real `.env` ignored.

**Full environment variable reference:**

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `VGE_API_URL` | no | `https://api.vigilguard` | VGE base URL |
| `VGE_API_KEY` | yes | — | Bearer token, `vg_(live\|test)_...` |
| `VGE_TIMEOUT_SECONDS` | no | `5` | Per-request timeout, capped at 10 |
| `VGE_WIRE_FORMAT` | no | `auto` | `auto` / `typed` / `legacy` |
| `VGE_LOG_FILE` | no | `/tmp/vge-prompt-logger.log` | Local diagnostic log; set to `/dev/null` to disable |
| `VGE_DRY_RUN` | no | `0` | `1` = log payload and skip HTTP |

### Step 4 — verify

**Dry run** — no HTTP request, payload written to log:

```bash
echo '{"session_id":"test-s","prompt_id":"test-p","hook_event_name":"UserPromptSubmit","prompt":"hello"}' \
  | VGE_DRY_RUN=1 ~/.claude/vg-cc/user-prompt-submit.sh

tail -n 5 /tmp/vge-prompt-logger.log
```

Expect two lines starting with `DRY_RUN` — one summary, one payload. The API key must appear as `vg_***`.

**Live run:**

1. Reload Claude Code (new session, or close and reopen the app).
2. Submit any prompt.
3. Tail the log:

   ```bash
   tail -f /tmp/vge-prompt-logger.log
   ```

   Expect one `INFO status=200 event=UserPromptSubmit session=<uuid>` line per submitted prompt.

4. Confirm in VGE (Web UI → Investigation tab, filter by framework = `claude-code`), or directly:

   ```sql
   SELECT timestamp, decision, threat_score, agent_session_id
   FROM vigil.events_v2
   WHERE agent_framework = 'claude-code'
   ORDER BY timestamp DESC
   LIMIT 5;
   ```

---

## Coexistence — what this hook will NOT touch

vg-cc is deliberately additive. It registers only the `UserPromptSubmit` hook event and intentionally defers all audit-only events (PreToolUse, PostToolUse, SessionStart, SessionEnd, etc.) to Phase 1.

It does not edit:

- `CLAUDE.md` (user or project) — hooks run from `settings.json`, not CLAUDE.md
- `.claude/skills/` — no skill is installed or invoked
- `.claude/commands/` — no slash commands
- `.claude/agents/` — no subagents
- `.mcp.json` / `mcpServers` — MCP stays untouched
- `permissions` — the hook runs via the CC harness; it is not a tool call and needs no allowlist entry
- Any hook event other than `UserPromptSubmit` (these remain available for other tooling)

Safe to drop into projects with heavy existing CC configuration (Lasso, custom linters, multi-MCP servers, project skills).

---

## Uninstall

```bash
# 1. Remove the UserPromptSubmit entry from settings.json (restore backup or edit by hand)
cp ~/.claude/settings.json.bak ~/.claude/settings.json   # if you kept the backup
# ...or edit and remove just the VGE line from hooks.UserPromptSubmit

# 2. Delete the hook
rm -rf ~/.claude/vg-cc

# 3. (Optional) remove credentials
rm ~/.claude/.env
```

No other cleanup needed. The script writes only to `$VGE_LOG_FILE` and never modifies your shell, CC config, or git state.

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
