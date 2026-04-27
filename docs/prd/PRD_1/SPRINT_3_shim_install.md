# SPRINT 3 — Shim + Install

**Status:** Ready to execute after Sprint 2 is complete  
**Duration:** 2 days  
**Predecessor:** Sprint 2 (daemon must be running; shim connects to it)  
**Unlocks:** Sprint 4 (TUI tests require install to have registered hooks; E2E tests use shim)

---

## Objective

Build the shim (the tiny per-hook process that bridges Claude Code → daemon) and the install/uninstall/reset commands. At the end of Sprint 3 a developer can run:

```bash
npm run build
node dist/cli.js install   # registers hooks in ~/.claude/settings.json
# restart Claude Code
# Claude Code now fires vge-cc-guard hook <event> on every hook event
```

And the shim correctly forwards hook payloads to the daemon and returns decisions to Claude Code.

---

## Prerequisites

Read before writing any code:

| Document | Why |
|---|---|
| [PRD_1.md §4.3](./PRD_1.md#43-sidecar-internal-architecture) | Shim architecture — stdin → socket → stdout, exit 2 on failure |
| [PRD_1.md §7.13](./PRD_1.md#713-transport--lifecycle-decided) | Transport rationale — why command hooks, why exit code 2 for fail-closed |
| [PRD_1.md §13 Steps 4 and 6](./PRD_1.md#13-execution-plan) | Execution plan for these steps |
| [CONFIG_DESIGN.md §2](../../CONFIG_DESIGN.md) | Install flow — screen layout, merge vs dry-run, scope options |
| Anthropic Claude Code Hooks reference | https://docs.anthropic.com/en/docs/claude-code/hooks | Hook command format, settings.json schema |
| VGE `.claude/settings.json` (if it exists) | Example settings.json with hook entries |

---

## Step 4 — Shim

The shim is the most security-critical piece of code in the entire project. It is called on **every** Claude Code hook event. If it misbehaves (throws, returns wrong JSON, exits with the wrong code) it affects every Claude Code session.

**Rules:**
- The shim contains **zero** policy logic. It is a courier.
- It must exit 2 on any transport failure (socket missing, connection refused, timeout).
- It must exit 0 on success.
- It must write the daemon's response JSON to stdout exactly as received (no modification).
- It must never hang indefinitely — the connection timeout is 1 second for the socket connect step and 30 seconds for the full request.

### 4.1 `src/shim/index.ts`

This is the entry point for `vge-cc-guard hook <event>`.

```typescript
import net from 'net';
import path from 'path';
import os from 'os';

const SOCKET_PATH = path.join(os.homedir(), '.vge-cc-guard', 'daemon.sock');
const CONNECT_TIMEOUT_MS = 1_000;   // socket connect
const REQUEST_TIMEOUT_MS = 30_000;  // full request (shim waits for daemon)

async function main(): Promise<void> {
  const event = process.argv[3];  // vge-cc-guard hook <event>
  if (!event) {
    process.stderr.write('vge-cc-guard hook: missing event name\n');
    process.exit(1);
  }

  // Read the CC hook payload from stdin
  const rawInput = await readStdin();
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawInput) as Record<string, unknown>;
  } catch {
    process.stderr.write('vge-cc-guard hook: invalid JSON on stdin\n');
    process.exit(2);  // fail-closed
  }

  // Lazy-start daemon if socket is missing
  await ensureDaemonRunning();

  // Forward to daemon
  const responseText = await sendToSocket(event, payload);
  if (responseText === null) {
    // Transport failure: fail-closed for PreToolUse (exit 2), fail-open for others (exit 0)
    if (event === 'pretool') {
      process.exit(2);
    }
    process.exit(0);
  }

  // Write response to stdout (Claude Code reads this)
  try {
    const response = JSON.parse(responseText) as { ccOutput: unknown };
    if (response.ccOutput !== null) {
      process.stdout.write(JSON.stringify(response.ccOutput) + '\n');
    }
  } catch {
    // Malformed daemon response: fail-closed for pretool, fail-open otherwise
    if (event === 'pretool') process.exit(2);
    process.exit(0);
  }
  process.exit(0);
}

main().catch(() => process.exit(2));
```

**Key design points:**
- `process.exit(2)` for `pretool` transport failures — this is the fail-closed behavior that makes `PreToolUse` block tool execution when the daemon is unreachable.
- `process.exit(0)` for all other events on transport failure — `PostToolUse`, `UserPromptSubmit` failures are non-fatal (the tool already ran or the prompt already happened).
- The shim does NOT import any daemon code. It only imports from `src/shared/ipc-protocol.ts` (for types) and Node built-ins.

**Helper: `readStdin()`**

```typescript
function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}
```

**Helper: `sendToSocket(event, payload)`**

Connects to `SOCKET_PATH`, sends `POST /v1/hooks/<event>` with JSON body, reads the response. Returns response text or `null` on any error.

Use Node's `http.request` with `socketPath` option:

```typescript
import http from 'http';

function sendToSocket(event: string, payload: unknown): Promise<string | null> {
  return new Promise((resolve) => {
    const body = JSON.stringify({ event, payload });
    const req = http.request({
      socketPath: SOCKET_PATH,
      path: `/v1/hooks/${event}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}
```

### 4.2 `src/shim/lazy-start.ts`

Forks the daemon as a detached process when the socket is missing.

```typescript
import { spawn } from 'child_process';
import net from 'net';
import path from 'path';
import os from 'os';

const SOCKET_PATH = path.join(os.homedir(), '.vge-cc-guard', 'daemon.sock');
const DAEMON_WAIT_MS = 1_000;     // max time to wait for socket to appear
const POLL_INTERVAL_MS = 50;

export async function ensureDaemonRunning(): Promise<void> {
  if (await socketExists()) return;

  // Fork daemon detached so it outlives the shim process.
  // process.argv[1] IS the cli.js binary — pass it with 'daemon' subcommand.
  // DO NOT use path.resolve(process.argv[1], '../../cli.js') — that resolves
  // relative to the PATH STRING (not the directory), producing a wrong path.
  const daemonBin = process.argv[1]!;
  const child = spawn(process.execPath, [daemonBin, 'daemon'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  // Poll for socket to appear
  const deadline = Date.now() + DAEMON_WAIT_MS;
  while (Date.now() < deadline) {
    if (await socketExists()) return;
    await sleep(POLL_INTERVAL_MS);
  }
  // If socket still not present, shim will fail when trying to connect (handled in main)
}

function socketExists(): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection(SOCKET_PATH);
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => resolve(false));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
```

### 4.3 Update `src/cli.ts`

Replace the `'hook'` stub with a real dispatch:

```typescript
case 'hook':
  // Dynamically import to keep the shim cold-start fast
  const { main } = await import('./shim/index.js');
  await main();
  break;

case 'daemon':
  const { startDaemon } = await import('./daemon/http-server.js');
  await startDaemon();
  break;
```

### 4.4 Integration test — `tests/integration/shim-daemon.test.ts`

This test starts a real daemon on a temp socket path, then calls the shim as a child process with a hook payload piped to stdin, and asserts the stdout.

```
✓ SessionStart payload → shim exits 0, no stdout output
✓ PreToolUse (gate=allow) → shim exits 0, stdout contains permissionDecision=allow
✓ PreToolUse (gate=block) → shim exits 0, stdout contains permissionDecision=deny
✓ PreToolUse with daemon down → shim exits 2 (fail-closed)
✓ PostToolUse with daemon down → shim exits 0 (fail-open)
✓ Shim starts daemon automatically when socket is missing
```

---

## Step 5 — Commands: install, uninstall, reset-session

### 5.1 `src/commands/install.ts`

> **Reference:** CONFIG_DESIGN.md §2 — install flow screen layout, exact JSON to merge into settings.json

**What install does (in order):**

1. Detect scope: `--scope=user` (default) or `--scope=project`.
2. Resolve target settings.json path:
   - user-wide: `~/.claude/settings.json`
   - project: `./.claude/settings.json` (relative to `process.cwd()`)
3. Read existing settings (or start with `{}`).
4. Check if vge-cc-guard hooks are already registered (idempotent check).
5. If not a dry-run:
   - Create `~/.vge-cc-guard/` directory (`fs.mkdirSync(dir, { recursive: true })`).
   - Create `~/.vge-cc-guard/sessions/` directory (`fs.mkdirSync(sessionsDir, { recursive: true })`). **This is required** — `session-state.ts` writes files there on the first hook event, and will throw `ENOENT` if the directory does not exist.
   - Write pre-install backup to `~/.vge-cc-guard/.pre-install-settings.backup` (only if backup doesn't already exist — preserve original).
   - Merge vge-cc-guard hook entries into settings.json.
   - Write `~/.vge-cc-guard/config.json` with `DEFAULT_CONFIG` (only if file doesn't exist).
6. Print a summary of changes.
7. Offer to run `vge-cc-guard config` for API key setup.

**Hook entries to merge (exact format):**

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "vge-cc-guard hook userprompt" }] }
    ],
    "PreToolUse": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "vge-cc-guard hook pretool" }] }
    ],
    "PostToolUse": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "vge-cc-guard hook posttool" }] }
    ],
    "SessionStart": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "vge-cc-guard hook sessionstart" }] }
    ],
    "SessionEnd": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "vge-cc-guard hook sessionend" }] }
    ]
  }
}
```

**Non-interactive mode (for CI):**

```bash
vge-cc-guard install --apply --scope=user
vge-cc-guard install --dry-run
```

When `--apply` is not provided and the terminal is interactive, show a confirmation prompt before writing.

**Settings.json merge strategy:**

The existing `hooks` object may already have entries. Merge by appending to each event's array, not overwriting. If vge-cc-guard's command is already present (idempotency check: look for the string `vge-cc-guard hook` in the command field), skip that entry.

**Atomic write:** write to a temp file first, then `fs.renameSync` to the target. This prevents corrupted settings.json on crash.

### 5.2 `src/commands/uninstall.ts`

> **Reference:** CONFIG_DESIGN.md §1 (uninstall command) — confirmation prompt, full revert

1. Read the pre-install backup from `~/.vge-cc-guard/.pre-install-settings.backup`.
2. If backup exists: restore it to `~/.claude/settings.json`.
3. If backup does not exist: remove vge-cc-guard hook entries from the current settings.json (fallback path — user may have deleted the backup).
4. Show confirmation prompt (cannot be skipped without a `--yes` flag).
5. `rm -rf ~/.vge-cc-guard/`
6. Print "Uninstall complete. Restart Claude Code to apply."

**Idempotency:** Running uninstall twice is safe. Second run will find no backup and no vge-cc-guard hooks to remove, print a message, and exit 0.

### 5.3 `src/commands/reset-session.ts`

Clears the active session's allowlist, pending escalations, and escalation counter.

1. Read `session_id` from the environment. Claude Code sets `CLAUDE_SESSION_ID` in the shell environment when hooks run, but `reset-session` is run manually by the user. So it needs to find the active session a different way.

   **Strategy for Phase 1a:** list all session files in `~/.vge-cc-guard/sessions/`, sort by `lastActivity` descending, pick the most recent one. If there are multiple active sessions, print them all and ask which to reset.

   **Empty sessions directory:** if `~/.vge-cc-guard/sessions/` is empty or does not exist, print `"No active sessions found."` and exit 0.

2. Load the session file, zero out `allowlist`, `pendingEscalations`, and `escalationCount`. Set `state = 'clean'`.
3. Write the file back.
4. Print "Session reset. The session will resume in clean state."

### 5.4 `src/commands/daemon.ts`

Foreground daemon for development:

```typescript
import { startDaemon } from '../daemon/http-server.js';

startDaemon().catch((err) => {
  console.error('Daemon failed to start:', err);
  process.exit(1);
});
```

That's it. The daemon handles its own signal handlers and keeps running until killed.

### 5.5 Integration test — `tests/integration/install-uninstall.test.ts`

Use a temporary directory as the mock `~/.claude/` and `~/.vge-cc-guard/` home:

```
✓ install creates settings.json with all 5 hook entries
✓ install creates ~/.vge-cc-guard/config.json with DEFAULT_CONFIG
✓ install creates pre-install backup
✓ install is idempotent (running twice does not add duplicate hook entries)
✓ install --dry-run prints diff but does not write
✓ uninstall restores settings.json from backup
✓ uninstall deletes ~/.vge-cc-guard/
✓ uninstall is idempotent (running twice exits 0)
✓ uninstall without backup removes only vge-cc-guard hooks, preserves others
```

---

## Final directory structure at end of Sprint 3

```
src/
├── cli.ts                         ✅ (updated with real dispatch)
├── commands/
│   ├── install.ts                 ✅
│   ├── uninstall.ts               ✅
│   ├── reset-session.ts           ✅
│   ├── daemon.ts                  ✅
│   └── config.ts                  (stub — Sprint 4)
├── shim/
│   ├── index.ts                   ✅
│   └── lazy-start.ts              ✅
├── daemon/                        ✅ (Sprint 2)
└── shared/                        ✅ (Sprint 1)

tests/
├── unit/                          ✅ (Sprint 2)
└── integration/
    ├── shim-daemon.test.ts        ✅
    └── install-uninstall.test.ts  ✅
```

---

## Manual smoke test (run after Sprint 3 is complete)

After `pnpm build`, verify end-to-end:

```bash
# 1. Install to a test location (use --dry-run first)
node dist/cli.js install --dry-run

# 2. Actually install
node dist/cli.js install --apply --scope=user

# 3. Check settings.json has the hooks
grep "vge-cc-guard" ~/.claude/settings.json
# Should show 5 hook entries

# 4. Check sessions/ directory was created
ls ~/.vge-cc-guard/sessions/
# Should not give 'No such file or directory'

# 5. Start daemon in foreground
node dist/cli.js daemon &
DAEMON_PID=$!

# 6. Simulate a PreToolUse hook event
echo '{"session_id":"test-sess","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls"}}' \
  | node dist/cli.js hook pretool
# Should print: {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}

# 7. Kill daemon and wait for it to fully stop
kill $DAEMON_PID && sleep 2

# 8. Remove the socket to prevent lazy-start (otherwise shim restarts daemon)
rm -f ~/.vge-cc-guard/daemon.sock

# 9. Simulate PreToolUse with daemon down → should exit 2
echo '{"session_id":"test-sess","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls"}}' \
  | node dist/cli.js hook pretool ; echo "Exit code: $?"
# Should print: Exit code: 2
# Note: lazy-start polls for 1s. If the daemon binary is reachable and restarts
# within 1s, exit code may be 0. The socket removal in step 8 prevents this.
```

> **Known limitation — PATH resolution:** The installed hook command is `"vge-cc-guard hook pretool"` (bare binary name). This requires `vge-cc-guard` to be in the PATH that Claude Code uses at startup. On macOS, GUI-launched Claude Code may not inherit the user's shell PATH (`~/.zshrc` is not sourced for GUI apps). If hooks appear to do nothing after install, this is likely the cause. **Workaround:** use `launchctl setenv PATH "$PATH"` before starting Claude Code, or set the full absolute path in the hook command. Document this in the README troubleshooting section. Full-path hooks (`/usr/local/bin/vge-cc-guard hook pretool`) will be added as an install option in a future sprint.

---

## External References

| Resource | Path | Why |
|---|---|---|
| PRD_1 §7.13 | `docs/prd/PRD_1/PRD_1.md` | Why exit code 2 = fail-closed for PreToolUse |
| PRD_1 §4.3 | `docs/prd/PRD_1/PRD_1.md` | Shim architecture — stdin/socket/stdout contract |
| PRD_1 §13 Steps 4, 6 | `docs/prd/PRD_1/PRD_1.md` | Execution plan |
| CONFIG_DESIGN.md §2 | `docs/CONFIG_DESIGN.md` | Install screen and hook JSON format |
| Anthropic hooks reference | https://docs.anthropic.com/en/docs/claude-code/hooks | settings.json hook entry format |
| VGE `.claude/settings.json` | `Vigil-Guard-Enterprise/.claude/settings.json` | Real example of CC settings format |
| Phase 0 hook | `vg-cc-legacy/hooks/user-prompt-submit.sh` | Example hook that was registered in Phase 0 |

---

## Acceptance Criteria

- [ ] `pnpm test` exits 0 (includes integration tests)
- [ ] `pnpm typecheck` exits 0
- [ ] Shim exits 2 for `pretool` transport failures (verified by integration test)
- [ ] Shim exits 0 for `posttool` transport failures (fail-open)
- [ ] Install is idempotent (running twice does not duplicate hook entries)
- [ ] Pre-install backup is created only on first install (subsequent runs do not overwrite it)
- [ ] Uninstall restores the original settings.json from backup
- [ ] `vge-cc-guard hook pretool` with a running daemon returns valid `hookSpecificOutput` JSON on stdout
- [ ] `~/.vge-cc-guard/sessions/` directory created by `install` (verified in install-uninstall test)
- [ ] `reset-session` prints "No active sessions found." when sessions dir is empty and exits 0
- [ ] Manual smoke test passes (all 9 steps, including socket removal in step 8)
