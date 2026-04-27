# SPRINT 5 — Resilience + Beta

**Status:** Ready to execute after Sprint 4 (Phase 1a) is complete  
**Duration:** 4–6 weeks total (Phase 1b: 1–2 weeks, Phase 1c: 2–3 weeks, Beta: 2–3 weeks)  
**Predecessor:** Sprint 4 — Phase 1a feature-complete  
**Goal:** Phase 1b (resilience), Phase 1c (live monitoring), closed beta, `vge-cc-guard@1.0.0`

---

## Overview

Sprint 5 has three sequential sub-phases. Each sub-phase must be complete before the next starts:

```
Phase 1b — Resilience (1–2 weeks)
    ↓
Phase 1c — Live Monitoring & Beta Prep (2–3 weeks)
    ↓
Closed Beta → vge-cc-guard@1.0.0 GA
```

---

## Prerequisites

Read before starting:

| Document | Sections | Why |
|---|---|---|
| [PRD_1.md §6.2](./PRD_1.md#62-phase-1b--resilience-12-weeks) | Full section | Phase 1b scope |
| [PRD_1.md §6.3](./PRD_1.md#63-phase-1c--live-monitoring--closed-beta-prep-23-weeks) | Full section | Phase 1c scope |
| [CONFIG_DESIGN.md §9](../../CONFIG_DESIGN.md) | §9 only | Live-monitoring TUI screens (Events, Pending, Audit, Stats) |
| [PRD_1.md §7.13](./PRD_1.md#713-transport--lifecycle-decided) | Persistence section | Eager fsync vs lazy write-behind semantics |

---

## Phase 1b — Resilience

### 1b-1: VGE client — retry + backoff

**File to modify:** `src/daemon/vge-client.ts`

Replace the Phase 1a simple retry loop with proper exponential backoff:

```typescript
const RETRY_DELAYS_MS = [100, 200, 400];  // 3 retries
const MAX_TOTAL_MS = 5_000;
```

**Logic:**

```
attempt 0: try request
  → success: return response
  → 4xx (not 429): do NOT retry, return null immediately
  → 5xx or network error: wait RETRY_DELAYS_MS[attempt], retry
  → 429: honour Retry-After header if present, else use RETRY_DELAYS_MS[attempt]
  → track total elapsed; if > MAX_TOTAL_MS: abort and return null
```

**Test additions to `tests/unit/vge-client.test.ts`:**

```
✓ 500 → retry → success on second attempt
✓ 400 → no retry (client error), return null immediately
✓ 429 with Retry-After: 1 → waits ~1s then retries
✓ 3 consecutive 500s → return null after third attempt
✓ slow response (>5s total budget) → abort and return null
```

### 1b-2: Per-resource VGE response cache

**New file:** `src/daemon/response-cache.ts`

Cache `GuardResponseSubset` by resource ID. Used when the same resource (same canonicalized key from `allowlist.ts`) is analyzed multiple times within a 5-minute window.

```typescript
interface CacheEntry {
  response: GuardResponseSubset;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;  // 5 minutes

export class ResponseCache {
  private cache: Map<string, CacheEntry> = new Map();

  get(resourceId: string): GuardResponseSubset | null
  set(resourceId: string, response: GuardResponseSubset): void
  prune(): void  // remove expired entries — call on a 60s interval
}
```

**Where to use it:** in `http-server.ts` PostToolUse handler, before calling `vge-client.analyzeToolOutput`. Cache key = canonicalized resource ID. Cache hit: skip VGE call, use cached response. Still run Confidence Router on cached response (for audit trail).

**Important:** only cache `GuardResponseSubset`, never raw tool content. The cache is keyed on the resource identifier, not the content hash.

```typescript
// SECURITY: cache is resource-ID only. A compromised CDN or server that begins
// serving malicious content on the same URL will not be re-analyzed until this
// TTL expires. Acceptable for Phase 1b (5-min window is short; most attacks
// are not coordinated to flip content mid-session). Phase 2 should add
// content-hash caching to close this gap.
```

**Test file:** `tests/unit/response-cache.test.ts`

```
✓ cache miss → returns null
✓ cache hit within TTL → returns cached response
✓ cache entry after TTL → returns null (expired)
✓ prune removes expired entries without removing fresh ones
```

### 1b-3: Pino debug log with rotation

**New file:** `src/daemon/debug-logger.ts`

```typescript
import pino from 'pino';

// Log file: ~/.vge-cc-guard/debug.log
// Rotation: 50MB per file, keep 5 files, 7-day TTL
// Level: 'debug' in development, 'info' in production
// Enable with VGE_CC_GUARD_DEBUG=1 env var
```

Install dependencies:

```bash
pnpm add pino pino-roll
# Note: do NOT add @types/pino — pino ships its own TypeScript declarations
# since v7. Adding @types/pino alongside pino causes duplicate-type conflicts.
```

Use `pino-roll` for file rotation. Log level controlled by `VGE_CC_GUARD_LOG_LEVEL` env var (default: `info`).

**Usage:** import `debugLogger` in each daemon module and replace `console.error` / `console.log` calls with `debugLogger.error()` / `debugLogger.info()`. Keep `console.error` only for startup failures before the logger is initialized.

**Do NOT log:**
- Raw tool content
- API keys or credentials
- User prompts

**Do log:**
- Hook routing decisions (tool name, decision, reason)
- VGE call outcomes (success/failure/cached, latency_ms)
- Session state transitions
- Daemon startup/shutdown events

### 1b-4: Session-state persistence

**Files to modify:** `src/daemon/session-state.ts`

Phase 1a used synchronous `fs.writeFileSync` for all writes. Phase 1b splits into:

**Eager fsync (synchronous) on:**
- `transitionState()` — state change to caution or tainted
- `addToAllowlist()` — new allowlist entry
- `enqueueEscalation()` / `dequeueEscalation()` — escalation queue changes

**Lazy write-behind (async, 5s coalesce) on:**
- `lastActivity` updates (happen on every hook call — too frequent for sync fsync)
- `escalationCount` read-only increments

**Implementation of lazy write-behind:**

```typescript
private lazyWriteTimer: NodeJS.Timeout | null = null;

private scheduleLazyWrite(sessionId: string): void {
  if (this.lazyWriteTimer) return;
  this.lazyWriteTimer = setTimeout(() => {
    this.flushToDisk(sessionId);
    this.lazyWriteTimer = null;
  }, 5_000);
}
```

**On daemon startup:** scan `~/.vge-cc-guard/sessions/` and load all JSON files back into `session_store`. GC entries older than `policy.session_idle_ttl_hours` at load time.

**Test additions to `tests/unit/session-state.test.ts`:**

```
✓ state transition to tainted → file written synchronously before function returns
✓ lastActivity update → file NOT written synchronously (lazy)
✓ daemon restart simulation: write session to disk → create new state store → load from disk → state preserved
✓ old session file (older than TTL) → pruned at load time
```

### 1b-5: Daemon kill -9 + restart recovery test

**New test file:** `tests/integration/daemon-restart.test.ts`

```
✓ Send SessionStart → PostToolUse (ESCALATE) → daemon receives session decision
✓ Kill daemon with SIGKILL
✓ Send PreToolUse → shim auto-starts new daemon
✓ New daemon loads session state from disk (eager-fsynced fields present)
✓ New daemon denies PreToolUse (pending escalation survived restart)
```

---

## Phase 1c — Live Monitoring & Beta Prep

### 1c-1: TUI live-monitoring screens

> **Reference:** CONFIG_DESIGN.md §9 — full spec for all 4 Phase 1c screens

**Add 4 new screens to the TUI:**

```
src/tui/screens/
├── LiveEvents.tsx      ← tail of hook firings (last 50)
├── PendingEscalations.tsx  ← ask-dialog queue with click-to-resolve
├── AuditViewer.tsx     ← JSONL viewer with filters
└── Stats.tsx           ← decision histogram, p50/p99 latency, VGE health
```

**Add to MainMenu** a second section: "Live Monitoring" with these 4 items.

**LiveEvents.tsx:** tail `~/.vge-cc-guard/audit.log`, poll every 500ms, display last 50 events. Each event shows: timestamp, event_type, tool_name, router_outcome. Colorize: HARD_TAINT=red, ESCALATE=yellow, ALLOW=green, SOFT_TAINT=blue.

**PendingEscalations.tsx:** read session files from `~/.vge-cc-guard/sessions/`, find sessions with non-empty `pendingEscalations`. Display them as a list. Select one and press `1`/`2`/`3`/`4` to resolve with `once`/`session`/`block`/`quarantine` directly from the TUI (alternative to replying in the Claude Code prompt).

**Implementation note for PendingEscalations resolution:** DO NOT write the decision directly to the session JSON file. Writing directly bypasses three critical code paths: (1) in-memory `session_store` state is not updated, (2) `logEscalationResolved()` is never called, and (3) `addToAllowlist()` is never called for `session` decisions.

Instead, send the decision over HTTP to the daemon using a new route added in Phase 1c:

```
POST /v1/session/resolve-escalation
Body: { sessionId: string, escalationId: string, decision: EscalationDecision }
```

Add this route to `src/daemon/http-server.ts` as part of the Phase 1c work. The handler calls `applyDecision()` (same code path as `UserPromptSubmit` reply parser) and `logEscalationResolved()`. This ensures all three systems (memory, allowlist, audit) stay consistent regardless of how the decision is submitted.

If the daemon is not running when the TUI tries to resolve (user opened `vge-cc-guard config` while CC session is idle), show a message: "Daemon not running — start a Claude Code session to activate pending decisions."

**AuditViewer.tsx:** read `~/.vge-cc-guard/audit.log`, display as a paginated list. Support filtering by `event_type`. Each row is one JSONL line rendered as compact JSON.

**Stats.tsx:**
- Decision histogram: count of HARD_TAINT / SOFT_TAINT / ESCALATE / ALLOW from audit log
- VGE health: call `GET /v1/license/status` and display latency + status
- Session count: number of active session files

### 1c-2: `vge-cc-guard install --project`

**File to modify:** `src/commands/install.ts`

The `--scope=project` flag already exists from Sprint 3. In Phase 1c, add `--project` as a shorthand alias:

```bash
vge-cc-guard install --project   # equivalent to --scope=project --apply
```

When installed project-scope, the hook entries go into `./.claude/settings.json` (relative to `process.cwd()`). The `~/.vge-cc-guard/config.json` is still the global config (no per-project config in Phase 1a-1c).

### 1c-3: End-to-end test suite completion

Three additional E2E tests from PRD_1 §6.3:

**Test 1: Full WebFetch → session decision → allowlist pass-through**

Already covered in Sprint 4 `escalation-flow.test.ts`. Verify it still passes after Phase 1b changes.

**Test 2: Tainted session denies Bash**

```
✓ PostToolUse with 2-branch VGE response → HARD_TAINT → session.state=tainted
✓ Next PreToolUse for Bash → deny (tainted + risky tool)
✓ Next PreToolUse for WebSearch → allow (not in tainted deny set: {Bash, Write, Edit, Task})
```

**Test 3: Credential path deny regardless of config**

```
✓ policy.credential_protection=true: Read("~/.aws/credentials") → deny
✓ policy.credential_protection=false: Read("~/.aws/credentials") → allow (protection disabled)
  Note: this tests that the toggle works, not that disabling it is recommended
```

### 1c-4: Closed beta packaging

**Version bump:** `0.9.0-beta.1` in `package.json`.

**Publish with beta tag:**

```bash
pnpm publish --tag beta --no-git-checks
```

**Internal install:**

```bash
pnpm add -g vge-cc-guard@beta
vge-cc-guard install
vge-cc-guard config
# Use in a real Claude Code session for 1–2 weeks
```

**Bug-fix iteration protocol:**

1. Issue found → create GitHub issue
2. Fix in a branch → PR → tests must pass → merge to main
3. Bump to `0.9.0-beta.2`, etc.
4. After 2 weeks with no P0 bugs: promote to `1.0.0`

---

## Release: `vge-cc-guard@1.0.0`

When all acceptance criteria from PRD_1 §8 are green and the closed beta has no open P0 issues:

```bash
# 1. Final version bump (edit package.json manually — pnpm version not needed)
# Update version field in package.json to "1.0.0"

# 2. Publish to npm with 'latest' tag via CI (see npm-publish.yml below)
# Or manually: pnpm publish --no-git-checks

# 3. Create GitHub release
gh release create v1.0.0 --title "vge-cc-guard v1.0.0 GA" --notes "..."

# 4. Update documentation
# Update README.md quickstart instructions
# Update CHANGELOG.md with 1.0.0 release notes
```

**Publish checklist:**

```
□ pnpm build passes
□ pnpm test passes
□ pnpm lint passes
□ pnpm typecheck passes
□ package.json version is 1.0.0
□ package.json "files" field is ["dist/", "config/"] — this is the allowlist;
  no .npmignore needed (the two mechanisms conflict; "files" takes precedence)
□ dist/cli.js has shebang line
□ dist/cli.js is executable (ls -la dist/cli.js shows rwxr-xr-x)
□ pnpm pack --dry-run shows only: dist/, config/, package.json, README.md
```

**CI publish workflow — `.github/workflows/npm-publish.yml`:**

Create this file in Sprint 5 (it was listed in PRD_1 §5 deliverables but not yet written):

```yaml
name: Publish to npm

on:
  push:
    tags: ['v*']

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: latest

      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: 'pnpm'
          registry-url: 'https://registry.npmjs.org'

      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: pnpm test

      - name: Publish
        run: pnpm publish --no-git-checks
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

Store `NPM_TOKEN` as a GitHub Actions secret (generate at npmjs.com → Access Tokens → Automation token).

---

## Final directory structure at end of Sprint 5

```
src/
├── cli.ts                              ✅
├── commands/
│   ├── install.ts                      ✅ (updated: --project alias)
│   ├── uninstall.ts                    ✅
│   ├── reset-session.ts                ✅
│   ├── daemon.ts                       ✅
│   └── config.ts                       ✅
├── shim/                               ✅
├── daemon/
│   ├── http-server.ts                  ✅ (updated: cache, debug logger)
│   ├── tool-policy.ts                  ✅
│   ├── session-state.ts                ✅ (updated: lazy write-behind, disk restore)
│   ├── path-deny.ts                    ✅
│   ├── confidence-router.ts            ✅
│   ├── ask-dialog.ts                   ✅
│   ├── allowlist.ts                    ✅
│   ├── reply-parser.ts                 ✅
│   ├── vge-client.ts                   ✅ (updated: retry + backoff)
│   ├── truncate.ts                     ✅
│   ├── audit-logger.ts                 ✅
│   ├── response-cache.ts               ✅ (new)
│   └── debug-logger.ts                 ✅ (new)
├── shared/                             ✅
└── tui/
    ├── App.tsx                         ✅ (updated: live monitoring section)
    ├── strings.ts                      ✅ (updated)
    └── screens/
        ├── MainMenu.tsx                ✅ (updated)
        ├── InstallWizard.tsx           ✅
        ├── ApiKeys.tsx                 ✅
        ├── ToolsPolicy.tsx             ✅
        ├── SecurityBaseline.tsx        ✅
        ├── ViewConfig.tsx              ✅
        ├── LiveEvents.tsx              ✅ (new)
        ├── PendingEscalations.tsx      ✅ (new)
        ├── AuditViewer.tsx             ✅ (new)
        └── Stats.tsx                   ✅ (new)

tests/
├── unit/
│   ├── (all Sprint 2 tests)            ✅
│   ├── response-cache.test.ts          ✅ (new)
│   └── (updated: session-state, vge-client)
└── integration/
    ├── shim-daemon.test.ts             ✅
    ├── install-uninstall.test.ts       ✅
    ├── claude-code-fixtures.test.ts    ✅
    ├── escalation-flow.test.ts         ✅
    └── daemon-restart.test.ts          ✅ (new)
```

---

## External References

| Resource | Path | Why |
|---|---|---|
| PRD_1 §6.2 Phase 1b scope | `docs/prd/PRD_1/PRD_1.md` | Complete Phase 1b task list |
| PRD_1 §6.3 Phase 1c scope | `docs/prd/PRD_1/PRD_1.md` | Complete Phase 1c task list |
| PRD_1 §7.13 persistence | `docs/prd/PRD_1/PRD_1.md` | Eager fsync vs lazy write-behind semantics |
| CONFIG_DESIGN.md §9 | `docs/CONFIG_DESIGN.md` | Live monitoring TUI screen specs |
| VGE nats-client retry pattern | `Vigil-Guard-Enterprise/packages/nats-client/src/` | Retry + backoff implementation reference |
| VGE logging-worker JSONL | `Vigil-Guard-Enterprise/services/logging-worker/src/` | JSONL writing and rotation patterns |
| VGE observability package | `Vigil-Guard-Enterprise/packages/observability/` | Pino setup pattern in the VGE ecosystem |
| Pino documentation | https://github.com/pinojs/pino | Pino API for structured logging |
| pino-roll documentation | https://github.com/nicolo-ribaudo/pino-roll | File rotation configuration |

---

## Acceptance Criteria for Sprint 5

### Phase 1b Done

- [ ] VGE client retries on 5xx up to 3 times, aborts after 5s budget
- [ ] 4xx responses are not retried
- [ ] Response cache returns hit for same resource within 5min TTL
- [ ] Debug log written to `~/.vge-cc-guard/debug.log` when `VGE_CC_GUARD_LOG_LEVEL=debug`
- [ ] No raw tool content, API keys, or prompts in debug log
- [ ] Session state survives daemon kill -9 + restart (eager-fsynced fields)
- [ ] `lastActivity` writes are lazy (verified: no fsync on every hook call)
- [ ] Daemon-restart integration test passes

### Phase 1c Done

- [ ] `vge-cc-guard config` shows "Live Monitoring" section with 4 screens
- [ ] LiveEvents screen tails audit.log and updates every 500ms
- [ ] PendingEscalations screen resolves decisions via `POST /v1/session/resolve-escalation` (not direct JSON write)
- [ ] PendingEscalations resolution: audit log, allowlist, and in-memory state all updated correctly
- [ ] Stats screen shows VGE health (reachable/unreachable + latency)
- [ ] `vge-cc-guard install --project` registers hooks in `./.claude/settings.json`
- [ ] All three Phase 1c E2E tests pass

### Beta Done

- [ ] `pnpm add -g vge-cc-guard@beta` installs successfully on macOS 14+ and Ubuntu 22.04
- [ ] `vge-cc-guard install && vge-cc-guard config` completes the full onboarding flow on both platforms
- [ ] Dogfood session: zero daemon crashes (unhandled exceptions logged to debug.log) over a 1-week real Claude Code session
- [ ] All 23 acceptance criteria from PRD_1 §8 verified by the automated test suite (`pnpm test` exits 0)
- [ ] `vge-cc-guard hook pretool` p99 latency < 50ms measured with the fixture runner (PRD_1 §8 criterion 1)
- [ ] No open GitHub issues labelled P0 at the time of 1.0.0 tag

### 1.0.0 Release

- [ ] `npm-publish.yml` CI workflow triggers on `git push origin v1.0.0` tag and publishes to npm
- [ ] `pnpm add -g vge-cc-guard` installs the 1.0.0 build
- [ ] GitHub release v1.0.0 created with release notes
- [ ] README.md quickstart is accurate for the released version
- [ ] `pnpm pack --dry-run` output matches the "files" allowlist (no src/, tests/, docs/ in the published package)
