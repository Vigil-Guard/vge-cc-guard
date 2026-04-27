# SPRINT 2 — Daemon Core

**Status:** Ready to execute after Sprint 1 is complete  
**Duration:** 4–5 days  
**Predecessor:** Sprint 1 (requires `src/shared/` — config-schema, types, ipc-protocol)  
**Unlocks:** Sprint 3 (shim connects to the daemon; install registers hooks that call the daemon)

---

## Objective

Build all 11 daemon modules in dependency order. Each module gets a sibling unit test file. A module is considered done when its test file is green — do not move to the next module until the current one passes.

At the end of Sprint 2 you can start the daemon in foreground mode and it will correctly handle hook events sent over its Unix socket.

---

## Prerequisites

Read before writing any code:

| Document | Why |
|---|---|
| [PRD_1.md §4.1](./PRD_1.md#41-component-diagram) | Full component flow — read the entire ASCII diagram |
| [PRD_1.md §7.7](./PRD_1.md#77-confidence-router-layer-1) | Confidence Router — exact routing rules and thresholds |
| [PRD_1.md §7.9–7.9.1](./PRD_1.md#79-ask-dialog-layer-2) | Ask Dialog and reply parser — vocabulary, aliases, ambiguity handling |
| [PRD_1.md §7.10](./PRD_1.md#710-resource-allowlist-session-scoped-soft) | Allowlist — per-tool canonicalization table |
| [PRD_1.md §7.11](./PRD_1.md#711-credential-path-protection) | Credential deny list — full path list and resolution requirements |
| [PRD_1.md §7.12](./PRD_1.md#712-subagent-inheritance) | Subagent inheritance — shared reference model |
| [PRD_1.md §7.6](./PRD_1.md#76-vge-payload-limits-and-fail-mode) | VGE payload limits and truncation strategy |
| [PRD_1.md §7.9.2](./PRD_1.md#792-audit-trail-for-escalation-decisions) | Audit event shapes — exact JSONL format |
| VGE `packages/shared/src/schemas/index.ts:236–334` | Full GuardResponse shape — read every field |
| VGE `docs/api/endpoints.md` | `/v1/guard/input` and `/v1/guard/analyze` request bodies |

---

## New dependency to add

Sprint 2 adds Express for the daemon's HTTP server over Unix socket:

```bash
pnpm add express
pnpm add -D @types/express
```

---

## Build order (strict — each module imports from those above it)

```
1. tool-policy.ts       (imports: config-schema, fs)
2. path-deny.ts         (imports: os, path, fs)
3. session-state.ts     (imports: types, fs)
4. allowlist.ts         (imports: types, crypto, path, url)
5. confidence-router.ts (imports: types)
6. reply-parser.ts      (imports: types)
7. ask-dialog.ts        (imports: types, confidence-router, reply-parser)
8. truncate.ts          (no imports except types)
9. vge-client.ts        (imports: config-schema, types, truncate)
10. audit-logger.ts     (imports: types, fs)
11. http-server.ts      (imports: all of the above)
```

---

## Module 1 — `src/daemon/tool-policy.ts`

**Purpose:** Load `~/.vge-cc-guard/config.json`, validate it, hot-reload on file change, resolve `(toolName) → ToolPolicy`.

**Inputs:** tool name string  
**Output:** `{ gate: 'allow' | 'block' | 'ask', analyze_output: boolean }`

**Implementation guide:**

1. On startup, call `loadConfig()` which reads the config file, parses it with `configSchema.parse()`, and stores the result in a module-level variable. This function **must complete synchronously** before `startDaemon()` begins accepting requests — `http-server.ts` calls `loadConfig()` as the first statement and only starts the socket listener after it returns.
2. **Config file path:** determined in this priority order:
   - `process.env.VGE_CC_GUARD_CONFIG_DIR` (if set) → `<dir>/config.json`
   - Otherwise `path.join(os.homedir(), '.vge-cc-guard', 'config.json')`
   
   The env var override is required for integration tests (Sprint 4) to use temp directories instead of the developer's real `~/.vge-cc-guard/`.
3. Set up `fs.watch` on the config file. Debounce the callback with a 100ms delay (macOS fires double events). On change, re-read and re-validate. Log a warning if validation fails and keep the last valid config.
4. `resolveToolPolicy(toolName: string): ToolPolicy` looks up `config.tools[toolName]`, falls back to `config.tools['*']`, falls back to `{ gate: 'ask', analyze_output: false }` — never throws.

**Test — `tests/unit/tool-policy.test.ts`:**

```
✓ returns correct policy for known tool (Bash → allow + analyze_output=true)
✓ falls back to '*' for unknown tool
✓ falls back to ask+false when '*' is absent
✓ rejects invalid config file and keeps last-valid config
✓ hot-reload: use vi.waitFor with 500ms timeout (not a fixed setTimeout)
  — macOS fs.watch debounce means 100ms is not reliable
✓ VGE_CC_GUARD_CONFIG_DIR overrides the config path
```

Write the test file **before** writing the module. The test failing is the signal to start the implementation.

---

## Module 2 — `src/daemon/path-deny.ts`

**Purpose:** Check whether a path argument (from a Read, Edit, or Write tool call) matches the credential protection deny list.

> **Reference:** PRD_1 §7.11 — exact deny list and resolution requirements. Read this section before writing a single line.

**Input:** `rawPath: string`  
**Output:** `{ denied: true; resolvedPath: string } | { denied: false; resolvedPath: string }`

**Implementation guide:**

1. Resolve the path: tilde expand (`~` → `os.homedir()`), then `path.resolve()`, then `fs.realpathSync()` (catch ENOENT — the file may not exist yet; use the pre-resolve result in that case). Symlink resolution via `realpathSync` is required: a symlink `~/mylink → ~/.aws/credentials` must also be denied.
2. Match the resolved path against the deny list patterns from PRD_1 §7.11 using **manual pattern matching only** — do NOT add `micromatch` or any other glob library. The deny list is 8 fixed patterns; adding a dependency to a security-critical module expands the attack surface without benefit.
3. Basename patterns (`id_rsa*`, `*credentials*`, `*secrets*`) match against `path.basename(resolvedPath)` case-insensitively using `String.prototype.toLowerCase()` + simple prefix/suffix checks.
4. Directory prefix patterns (`~/.ssh/*`) match if the resolved path starts with the resolved expanded prefix.
5. This module does **not** check `policy.credential_protection` — that toggle is checked in `http-server.ts` before calling this module.

**Test — `tests/unit/path-deny.test.ts`:**

```
✓ ~/.aws/credentials → denied
✓ ~/.ssh/id_rsa → denied
✓ ~/.ssh/id_rsa.pub → denied (basename match)
✓ /tmp/.env → denied
✓ /home/user/project/.env → denied
✓ ~/project/src/main.ts → not denied
✓ ~/project/config.json → not denied
✓ path with .. that resolves to a denied path → denied
✓ non-existent path matching a pattern → denied (resolution falls back to pre-realpath)
✓ symlink pointing to ~/.aws/credentials → denied (realpathSync resolves it)
```

---

## Module 3 — `src/daemon/session-state.ts`

**Purpose:** In-memory store of all active session states. Keyed by Claude Code `session_id`. Handles subagent inheritance by shared reference.

> **Reference:** PRD_1 §7.3, §7.9.3, §7.12, §7.13 (persistence fsync semantics)

**Key operations:**

```typescript
createSession(sessionId: string, parentSessionId: string | null): SessionData
getSession(sessionId: string): SessionData | undefined
deleteSession(sessionId: string): void
transitionState(sessionId: string, newState: SessionState): void  // eager fsync
addToAllowlist(sessionId: string, key: string): void              // eager fsync
enqueueEscalation(sessionId: string, esc: Escalation): void       // eager fsync
dequeueEscalation(sessionId: string): Escalation | undefined
gcIdleSessions(ttlHours: number): void  // called on a 60s interval
```

**Subagent inheritance (PRD_1 §7.12):**

When `createSession` is called with a non-null `parentSessionId` and the parent session exists in the store, the new session gets a **shared reference** to the parent's `SessionData` object — not a copy. Both `session_store[parentId]` and `session_store[childId]` point to the same object.

```typescript
// Shared reference — both map entries point to the same object
const parentData = sessionStore.get(parentSessionId);
if (parentData) {
  sessionStore.set(sessionId, parentData);  // same reference
  return parentData;
}
```

This means any state transition in the child immediately affects the parent and vice versa. This is the correct behavior per PRD_1 §7.12.

**Eager fsync (Phase 1a):** In Sprint 2 (Phase 1a), write session state to `~/.vge-cc-guard/sessions/<id>.json` synchronously on every security-relevant write (allowlist add, escalation enqueue/dequeue, state transition). Use `fs.writeFileSync` for now — Phase 1b (Sprint 5) replaces this with lazy write-behind for telemetry fields.

**GC:** On a 60s interval, call `gcIdleSessions` which removes sessions where `Date.now() - lastActivity > ttlHours * 3600 * 1000`.

**Test — `tests/unit/session-state.test.ts`:**

```
✓ createSession returns clean state with empty allowlist and no pending escalations
✓ subagent session shares state object with parent (same reference, not copy)
✓ transition to tainted propagates to subagent (shared reference test)
✓ addToAllowlist adds exactly one entry
✓ enqueue + dequeue escalation is FIFO
✓ deleteSession removes the entry
✓ gcIdleSessions removes sessions older than TTL
✓ gcIdleSessions does not remove active sessions
```

---

## Module 4 — `src/daemon/allowlist.ts`

**Purpose:** Canonicalize a `(toolName, rawInput)` pair into a string key. This is the logic that makes `(WebFetch, "https://example.com/?utm_source=x")` and `(WebFetch, "https://example.com/?utm_source=y")` match the same allowlist entry in Phase 1c (Phase 1a: exact match only).

> **Reference:** PRD_1 §7.10 — full per-tool canonicalization table. Implement exactly what is specified there for each tool.

**Input:** `toolName: string, toolInput: Record<string, unknown>`  
**Output:** `string` (the canonical key, e.g., `"WebFetch:https://example.com/blog/post"`)

**Implementation guide:**

Implement the canonicalization table from PRD_1 §7.10 exactly:

| Tool | Key construction |
|---|---|
| `WebFetch` | Full URL from `toolInput.url`, strip `#` fragment |
| `WebSearch` | Verbatim query from `toolInput.query` |
| `Read` | `path.resolve(expandTilde(toolInput.file_path))` |
| `Glob` | `toolInput.pattern + ':' + path.resolve(toolInput.cwd ?? process.cwd())` |
| `Grep` | `toolInput.pattern + ':' + path.resolve(toolInput.path ?? process.cwd())` |
| `Bash` | `'bash:' + sha256(normalizeWhitespace(toolInput.command).toLowerCase()).slice(0,12)` |
| `Edit` | `path.resolve(toolInput.file_path) + ':edit:' + sha256(toolInput.old_string).slice(0,12)` |
| `Write` | `path.resolve(toolInput.file_path) + ':write:' + sha256(toolInput.content).slice(0,12)` |
| `Task` | `'task:' + (toolInput.subagent_type ?? 'unknown') + ':' + sha256(toolInput.prompt).slice(0,12)` |
| Any other | `toolName + ':' + sha256(stableStringify(stripVolatileFields(toolInput))).slice(0,12)` |

For `sha256`: use `crypto.createHash('sha256').update(input).digest('hex')`.  
For `stableStringify`: sort object keys alphabetically before serializing.  
For `stripVolatileFields`: remove keys named `timestamp`, `requestId`, `sessionId`, `traceId`, `id`.

In Phase 1a, tracking param stripping for WebFetch (`utm_*`, `fbclid`, `ref`) is **not required** — that is Phase 1c. Implement the comment `// TODO Phase 1c: strip tracking params` in the WebFetch case.

**Test — `tests/unit/allowlist.test.ts`:**

```
✓ WebFetch: fragment stripped, URL preserved
✓ Bash: sha256 hash of normalized command
✓ Read: tilde expanded, path resolved to absolute
✓ Edit: path + sha256(old_string) prefix
✓ unknown tool: falls through to generic sha256 case
✓ two different WebFetch URLs produce different keys
✓ same WebFetch URL produces the same key regardless of call timing
✓ volatile fields (timestamp, requestId) stripped from generic hash input
```

---

## Module 5 — `src/daemon/confidence-router.ts`

**Purpose:** Reduce a VGE `GuardResponseSubset` to one of four `RouterOutcome` values. Deterministic — no network calls, no async.

> **Reference:** PRD_1 §7.7 — full routing rules, branch thresholds, and hard VGE policy pre-check. Read this section completely before implementing.

**Input:** `response: GuardResponseSubset`  
**Output:** `RouterOutcome`

**Branch trigger thresholds (from PRD_1 §7.7):**

```typescript
const BRANCH_THRESHOLDS = {
  heuristics: 50,
  semantic: 50,
  llmGuard: 55,
} as const;
```

**Routing logic (implement in this exact order):**

```
Step 1 — Hard VGE policy pre-check:
  if response.ruleAction === 'BLOCK'                    → HARD_TAINT
  if response.decision === 'BLOCKED' (no ruleAction)    → HARD_TAINT
  if response.failOpen === true                         → SOFT_TAINT
  if decisionFlags contains any flag ending in _DEGRADED or API_TIMEOUT → SOFT_TAINT
  if response.decision === 'SANITIZED'                  → SOFT_TAINT

Step 2 — Branch counting:
  agreed_branches = count of core branches where score >= threshold
  (core branches: heuristics, semantic, llmGuard)

Step 3 — Route by agreed count + score:
  if agreed_branches >= 2                               → HARD_TAINT
  if agreed_branches === 1 AND score >= 90              → HARD_TAINT
  if agreed_branches === 1 AND score >= 55              → ESCALATE
  if agreed_branches === 1 AND score < 55               → SOFT_TAINT
  if agreed_branches === 0                              → ALLOW
```

**Test — `tests/unit/confidence-router.test.ts`:**

```
✓ ruleAction=BLOCK → HARD_TAINT (overrides everything)
✓ decision=BLOCKED, no ruleAction → HARD_TAINT
✓ failOpen=true → SOFT_TAINT
✓ decisionFlags contains 'HEURISTICS_DEGRADED' → SOFT_TAINT
✓ decision=SANITIZED → SOFT_TAINT
✓ 2 branches agree (heuristics=55, semantic=55) → HARD_TAINT
✓ 1 branch (llmGuard=95), score=95 → HARD_TAINT (score >= 90 guard)
✓ 1 branch (semantic=72), score=72 → ESCALATE (55..89 band)
✓ 1 branch (heuristics=49), score=49 → ALLOW (below threshold = 0 agreed)
✓ 1 branch (semantic=54), score=54 → SOFT_TAINT (agreed=1, score<55)
✓ 0 branches, score=0 → ALLOW
✓ boundary: heuristics=50 counts as agreed (>= threshold)
✓ boundary: heuristics=49 does NOT count as agreed
✓ boundary: score=89 → ESCALATE (not HARD_TAINT)
✓ boundary: score=90 → HARD_TAINT
```

---

## Module 6 — `src/daemon/reply-parser.ts`

**Purpose:** Extract a structured `EscalationDecision` from the first token(s) of a user's prompt when a pending escalation is waiting. Returns `null` for ambiguous/unrecognized input (caller then blocks the prompt and re-asks).

> **Reference:** PRD_1 §7.9.1 — full vocabulary, aliases, pipeline steps

**Input:** `rawPrompt: string`  
**Output:** `{ decision: EscalationDecision; residual: string } | null`

**Vocabulary (from PRD_1 §7.9.1):**

```typescript
const DECISION_MAP: Record<string, EscalationDecision> = {
  once: 'once', o: 'once', 'allow once': 'once',
  session: 'session', s: 'session', 'allow session': 'session', always: 'session',
  block: 'block', b: 'block', no: 'block', deny: 'block', stop: 'block', discard: 'block',
  quarantine: 'quarantine', q: 'quarantine', caution: 'quarantine',
};
```

**Parse pipeline (exact order):**

1. Lowercase and trim the prompt.
2. Check for two-token match first: if the first two tokens are `allow once` or `allow session` → map accordingly.
3. Extract first alphanumeric token (max 20 chars, stop at first space).
4. Look up the token in `DECISION_MAP`. If found, return `{ decision, residual: prompt.slice(tokenEnd).trim() }`.
5. Bare `allow` (without `once`/`session`) → return `null` (ambiguous).
6. No match → return `null`.

The `residual` is the remainder of the prompt after the decision token(s). It will be sent to VGE as the user's actual message.

**Test — `tests/unit/reply-parser.test.ts`:**

```
✓ 'once' → { decision: 'once', residual: '' }
✓ 'o' → { decision: 'once', residual: '' }
✓ 'session do the thing' → { decision: 'session', residual: 'do the thing' }
✓ 'allow session' → { decision: 'session', residual: '' }
✓ 'allow once' → { decision: 'once', residual: '' }
✓ 'block' → { decision: 'block', residual: '' }
✓ 'no' → { decision: 'block', residual: '' }
✓ 'quarantine' → { decision: 'quarantine', residual: '' }
✓ 'q' → { decision: 'quarantine', residual: '' }
✓ 'allow' (bare) → null (ambiguous)
✓ 'please continue' → null (not in vocabulary)
✓ '' → null (empty)
✓ '   ONCE   ' → { decision: 'once', residual: '' } (case + trim)
✓ residual is trimmed: 'session  do the  thing  ' → residual is 'do the  thing'
```

---

## Module 7 — `src/daemon/ask-dialog.ts`

**Purpose:** Manage the per-session pending escalation queue. Apply user decisions from `reply-parser`. Check and increment the fatigue cap.

> **Reference:** PRD_1 §7.9 (full dialog mechanism), §7.9.2 (audit event shapes)

**Key operations:**

```typescript
// Check if session has pending escalations
hasPending(session: SessionData): boolean

// Format the PreToolUse denial message (PRD_1 §7.9 dialog format)
formatDenyReason(escalation: Escalation): string

// Apply a user decision to the first pending escalation.
// Returns the escalation that was resolved (for audit logging).
applyDecision(
  session: SessionData,
  decision: EscalationDecision,
  sessionStateStore: { transitionState, addToAllowlist }
): Escalation

// Enqueue a new escalation. If fatigue cap is reached, auto-convert to HARD_TAINT.
// Returns the final RouterOutcome after cap check.
enqueue(
  session: SessionData,
  escalation: Escalation,
  fatigueCapPerSession: number
): RouterOutcome
```

**Fatigue cap (PRD_1 §7.9):**

In `enqueue()`: if `session.escalationCount >= fatigueCapPerSession`, do NOT enqueue. Instead return `'HARD_TAINT'` and set `session.state = 'tainted'`. The caller (http-server) writes an audit event with `auto_hard_tainted_due_to_fatigue_cap: true`.

**Trigger excerpt source:** `formatDenyReason` receives the first 120 characters of the tool's `tool_response` string as the `triggerExcerpt` argument. This is the simplest Phase 1a approach. Phase 1b can improve it using branch-specific positions from `GuardResponse` if needed.

**Dialog text format (produce exactly this structure):**

```
VGE Agent Guard: tool output flagged by VGE. Decide before continuing.

  Tool:     <toolName>
  Resource: <resourceId>
  Score:    <score>  (<description>)
  Trigger:  "...<first 120 chars of tool_response>..."

  Why asking: VGE flagged this on a single branch (not corroborated).
  Single-branch signals are FP-prone in educational cybersec content.

  Reply:
    once        — accept this result once; ask again if this exact
                  (tool, resource) triggers again
    session     — accept + trust THIS specific resource for the rest
                  of the session. Future analyses still run and are
                  logged for audit, but sidecar takes no action on
                  them
    block       — reject this resource; keep the session tainted until
                  reset or SessionEnd
    quarantine  — accept but keep session on caution for 3 turns
```

**Test — `tests/unit/ask-dialog.test.ts`:**

```
✓ hasPending returns false for empty queue
✓ hasPending returns true after enqueue
✓ enqueue returns ESCALATE when under fatigue cap
✓ enqueue returns HARD_TAINT and sets state=tainted when cap exceeded
✓ applyDecision('once') dequeues the escalation, session state unchanged
✓ applyDecision('session') dequeues + adds to allowlist
✓ applyDecision('block') dequeues + sets state=tainted
✓ applyDecision('quarantine') dequeues + sets state=caution
✓ formatDenyReason returns string containing tool name and resource id
✓ FIFO: second escalation stays after first is resolved
```

---

## Module 8 — `src/daemon/truncate.ts`

**Purpose:** Dual-pass head+tail truncation for tool output text before sending to VGE.

> **Reference:** PRD_1 §7.6 — head+tail strategy, binary detection  
> **Also see:** VGE `services/llm-guard/src/onnx_inference.py:85–202` — the same dual-pass pattern used for LLM Guard inference

**Input:** `text: string`  
**Output:** `string` (truncated if > 100,000 chars, unchanged otherwise)

**Constants:**
```typescript
const MAX_CHARS = 100_000;
// HALF must be small enough that head + marker + tail stays under MAX_CHARS.
// The marker is ~45 chars ("...[truncated middle, original was NNNNNNN chars]\n").
// Using 49_975 leaves 50 chars for the marker — safe margin.
const HALF = 49_975;
const BINARY_MAGIC_BYTES = [
  [0x89, 0x50, 0x4e, 0x47],  // PNG
  [0x25, 0x50, 0x44, 0x46],  // PDF
  [0x50, 0x4b, 0x03, 0x04],  // ZIP
  [0xff, 0xd8, 0xff],        // JPEG
  [0x47, 0x49, 0x46],        // GIF
];
```

**Logic:**

```
1. If text.length <= MAX_CHARS → return text unchanged
2. head = text.slice(0, HALF)
3. tail = text.slice(text.length - HALF)
4. marker = `\n[truncated middle, original was ${text.length} chars]\n`
5. return head + marker + tail
```

**Binary detection (for PostToolUse only — called separately):**

```typescript
function isBinaryBuffer(buf: Buffer): boolean
// Checks first 8 bytes against BINARY_MAGIC_BYTES
// If binary: caller uses "text: '[binary content, sha256=<hex>, len=<N>]'" instead
```

**Test — `tests/unit/truncate.test.ts`:**

```
✓ text shorter than 100,000 chars → returned unchanged
✓ text exactly 100,000 chars → returned unchanged
✓ text 100,001 chars → truncated with marker
✓ truncated result is STRICTLY LESS THAN 100,000 chars
  (HALF=49,975 × 2 + ~45 char marker = ~99,995 — must stay under the VGE limit)
✓ marker contains the original length
✓ tail of original text appears at end of truncated result
✓ head of original text appears at start of truncated result
✓ PNG magic bytes → isBinaryBuffer returns true
✓ plain text buffer → isBinaryBuffer returns false
```

---

## Module 9 — `src/daemon/vge-client.ts`

**Purpose:** HTTP client for POSTing to VGE `/v1/guard/input` (user prompts) and `/v1/guard/analyze` (tool outputs). Reads VGE URL and API keys from the loaded config.

> **Reference:**  
> - VGE `docs/api/endpoints.md` — request body shapes for both endpoints  
> - PRD_1 §7.6 — fail-mode on VGE error (log and continue, never crash)  
> - Phase 0 hook `vg-cc-legacy/hooks/user-prompt-submit.sh` — example of the curl request structure  
> - VGE `packages/shared/src/schemas/index.ts:135–178` — `guardInputSchema` and `guardAnalyzeSchema`

**Two public functions:**

```typescript
// Fire-and-forget. Does not await response. Never throws.
async function postUserPrompt(
  prompt: string,
  sessionId: string,
  metadata?: Record<string, unknown>
): Promise<void>

// Returns GuardResponseSubset on success, null on any error.
// Retries up to 3 times with exponential backoff (100ms, 200ms, 400ms).
// Total timeout: 5s across all retries.
async function analyzeToolOutput(
  text: string,
  toolName: string,
  resourceId: string,
  sessionId: string,
  metadata?: Record<string, unknown>
): Promise<GuardResponseSubset | null>
```

**Request body for `analyzeToolOutput`:**

```json
{
  "text": "<truncated if needed>",
  "source": "tool_output",
  "agent": {
    "sessionId": "<sessionId>",
    "traceId": "<uuid>"
  },
  "tool": {
    "name": "<toolName>"
  },
  "metadata": {
    "platform": "claude-code",
    "vgeAgentGuard": {
      "resourceId": "<resourceId>",
      "userAllowlisted": false,
      "escalationId": null,
      "subagent": false,
      "parentSessionId": null
    }
  }
}
```

**Config loading (no race):** `vge-client.ts` does NOT call `loadConfig()` itself. Instead, it accepts a `getConfig: () => Config` callback injected by `http-server.ts` at startup. This guarantees config is already loaded when the first hook fires (since `http-server.ts` calls `loadConfig()` before binding the socket). Call the callback on each request to pick up hot-reloaded config values.

**API key guard:** Before making any VGE call, check `config.vge.api_key_input !== ''`. If empty, log a one-time warning ("VGE API key not configured — skipping analysis. Run `vge-cc-guard config` to set it up.") and return `null`. Do NOT throw.

**Error handling:** On any fetch error (network, timeout, 4xx, 5xx), `analyzeToolOutput` logs the error to console (stderr) and returns `null`. The daemon's PostToolUse handler treats `null` as "log and continue" — per PRD_1 §7.6.

**Phase 1a retry:** Simple loop, 3 attempts, `await sleep(100 * 2^attempt)` between retries. Max total 5s ceiling — track elapsed time and abort if exceeded.

**Note on `postUserPrompt`:** This is fire-and-forget. Call it, do not `await`, do not catch. If it throws (it shouldn't, but if it does), the unhandled rejection is caught by the daemon's global `unhandledRejection` handler (set up in `http-server.ts`).

**Test — `tests/unit/vge-client.test.ts`:**

Mock `fetch` (or use `msw` / `nock`) — do not make real network calls in unit tests.

```
✓ analyzeToolOutput sends correct request body with source='tool_output'
✓ analyzeToolOutput returns null on 500 error (log and continue)
✓ analyzeToolOutput returns null on network timeout
✓ analyzeToolOutput retries up to 3 times on 5xx
✓ analyzeToolOutput stops retrying after total 5s budget
✓ analyzeToolOutput returns GuardResponseSubset on success
✓ analyzeToolOutput returns null when api_key_input is empty (no VGE call made)
✓ postUserPrompt does not throw (fire-and-forget, no await)
✓ vgeAgentGuard.resourceId is included in metadata
```

---

## Module 10 — `src/daemon/audit-logger.ts`

**Purpose:** Write escalation lifecycle events to `~/.vge-cc-guard/audit.log` in JSONL format. Daily rotation. 90-day retention (cleanup of old files).

> **Reference:** PRD_1 §7.9.2 — exact event types and field shapes. Reproduce them exactly.

**Three event types to implement:**

```typescript
function logToolOutputEscalated(params: {
  escalationId: string;
  sessionId: string;
  toolName: string;
  resourceId: string;
  analysisId: string | null;
  branches: Record<string, number>;
  routerOutcome: RouterOutcome;
}): void

function logEscalationResolved(params: {
  escalationId: string;
  sessionId: string;
  decision: EscalationDecision;
  enqueuedAt: number;  // to compute resolution_delay_ms
}): void

function logToolOutputAnalyzed(params: {
  sessionId: string;
  toolName: string;
  resourceId: string;
  userAllowlisted: boolean;
  routerOutcome: RouterOutcome;
  enforcementTaken: 'none' | 'tainted' | 'escalated' | 'denied';
}): void

function logCredentialPathDenied(params: {
  sessionId: string;
  resolvedPath: string;
  credentialProtectionEnabled: boolean;
}): void
```

**File naming:** `~/.vge-cc-guard/audit.log` for today, `~/.vge-cc-guard/audit.log.YYYY-MM-DD` for rotated files.  
**Rotation:** At midnight (or on first write after midnight), rename the current file and open a new one.  
**Retention cleanup:** On startup, delete `audit.log.YYYY-MM-DD` files older than 90 days.

**Test — `tests/unit/audit-logger.test.ts`:**

Use a temporary directory for the log file path (not the real `~/.vge-cc-guard/`).

```
✓ logToolOutputEscalated writes a JSONL line with event_type='tool_output_escalated'
✓ logEscalationResolved writes resolution_delay_ms as a positive number
✓ logToolOutputAnalyzed with userAllowlisted=true writes enforcement_taken='none'
✓ logCredentialPathDenied writes the resolved path
✓ each event has an ISO 8601 timestamp field
✓ multiple events → multiple lines in the file, each valid JSON
✓ retention cleanup: files older than 90 days are deleted
```

---

## Module 11 — `src/daemon/http-server.ts`

**Purpose:** Express HTTP server listening on a Unix socket at `~/.vge-cc-guard/daemon.sock`. Routes the five hook events to their handlers. This module wires all previous modules together.

> **Reference:** PRD_1 §4.1 — full PreToolUse decision ordering (5 steps, critical path)

**Setup:**

```typescript
import express from 'express';
import http from 'http';
import path from 'path';
import os from 'os';

const SOCKET_PATH = path.join(os.homedir(), '.vge-cc-guard', 'daemon.sock');

const app = express();
app.use(express.json({ limit: '5mb' }));
```

**Routes:**

```
POST /health           → 200 { ok: true }
POST /v1/hooks/sessionstart  → handleSessionStart
POST /v1/hooks/userprompt    → handleUserPrompt
POST /v1/hooks/pretool       → handlePreTool
POST /v1/hooks/posttool      → handlePostTool
POST /v1/hooks/sessionend    → handleSessionEnd
```

**PreToolUse handler — decision ordering (implement EXACTLY in this order, from PRD_1 §4.1):**

```
1. If policy.credential_protection AND path-deny match → deny, log audit
2. If session has pending escalation → deny with ask-dialog text
3. If (tool_name, resource_id) in session.allowlist → allow
4. If session.state === 'tainted' AND toolName in {Bash, Write, Edit, Task} → deny
5. config.tools[toolName].gate → allow / deny / ask
```

**PostToolUse handler:**

```
1. If tool config.analyze_output === false → logToolOutputAnalyzed(enforcementTaken='none'), return null
2. Apply dual-pass truncation to tool_response
3. If binary content detected → send hash placeholder
4. POST to VGE /v1/guard/analyze
5. On VGE error → log, return null (fail-open for PostToolUse)
6. Run Confidence Router on response
7a. HARD_TAINT → session.state = tainted
                 logToolOutputAnalyzed(enforcementTaken='tainted')
                 return null  ← deliberate Phase 1a choice (see note below)
7b. SOFT_TAINT → session.state = caution
                 logToolOutputAnalyzed(enforcementTaken='tainted')
                 return null
7c. ESCALATE   → enqueue(escalation, fatigue_cap)
                 logToolOutputEscalated(...)
                 return null
7d. ALLOW      → logToolOutputAnalyzed(enforcementTaken='none')
                 return null
```

> **Phase 1a deliberate trade-off:** PostToolUse always returns `null` (no CC `decision: "block"` feedback to Claude). This means Claude does not see a warning in the prior turn when the next PreToolUse will be denied. This is an acceptable UX gap for MVP — the user sees the PreToolUse denial reason when they attempt the next tool call. Returning `{ decision: 'block', reason: '...' }` for `HARD_TAINT` is tracked as a Phase 1b improvement, not a Phase 1a requirement.

**UserPromptSubmit handler:**

```
1. If session has pending escalation → run reply-parser on prompt
   a. Valid decision → apply, write audit, return null (allow prompt through)
   b. Ambiguous → block prompt with re-ask message
2. Else → fire-and-forget postUserPrompt, return null
```

**Start function:**

```typescript
export async function startDaemon(): Promise<void> {
  // Remove stale socket if it exists
  // Start fs.listen on SOCKET_PATH
  // Set up process.on('unhandledRejection') to log but not crash
  // Set up SIGTERM / SIGINT handlers to close gracefully
}
```

**Test — `tests/unit/http-server.test.ts`:**

Start a test server on a temp socket. Send hook payloads via HTTP.

```
✓ /health returns 200 { ok: true }
✓ PreToolUse on credential path → deny with credential deny message
✓ PreToolUse on tainted session + Bash → deny
✓ PreToolUse with pending escalation → deny with dialog text
✓ PreToolUse on allowlisted resource → allow
✓ PreToolUse with gate=block → deny
✓ PreToolUse with gate=allow + clean session → allow
✓ PostToolUse with analyze_output=false → no VGE call (mock VGE)
✓ PostToolUse with VGE error → returns null (no crash)
✓ SessionStart → creates session
✓ SessionEnd → deletes session
```

---

## Final directory structure at end of Sprint 2

```
src/daemon/
├── http-server.ts        ✅
├── tool-policy.ts        ✅
├── session-state.ts      ✅
├── path-deny.ts          ✅
├── confidence-router.ts  ✅
├── ask-dialog.ts         ✅
├── allowlist.ts          ✅
├── reply-parser.ts       ✅
├── vge-client.ts         ✅
├── truncate.ts           ✅
└── audit-logger.ts       ✅

tests/unit/
├── tool-policy.test.ts
├── path-deny.test.ts
├── session-state.test.ts
├── allowlist.test.ts
├── confidence-router.test.ts
├── reply-parser.test.ts
├── ask-dialog.test.ts
├── truncate.test.ts
├── vge-client.test.ts
├── audit-logger.test.ts
└── http-server.test.ts
```

---

## External References

| Resource | Path | Why |
|---|---|---|
| VGE GuardResponse full schema | `Vigil-Guard-Enterprise/packages/shared/src/schemas/index.ts:236–334` | Every field used by confidence-router.ts |
| VGE guardAnalyzeSchema | `Vigil-Guard-Enterprise/packages/shared/src/schemas/index.ts:162–178` | Request body for /v1/guard/analyze |
| VGE guardInputSchema | `Vigil-Guard-Enterprise/packages/shared/src/schemas/index.ts:135–150` | Request body for /v1/guard/input |
| VGE payload constants | `Vigil-Guard-Enterprise/packages/shared/src/schemas/index.ts:20–25` | MAX_PROMPT_LENGTH=100000, MAX_TOOL_VALUE_BYTES=65536 |
| VGE /v1/guard/analyze docs | `Vigil-Guard-Enterprise/docs/api/endpoints.md` | Request/response shape, source field values |
| LLM Guard dual-pass truncation | `Vigil-Guard-Enterprise/services/llm-guard/src/onnx_inference.py:85–202` | Pattern for head+tail in truncate.ts |
| Phase 0 hook (curl examples) | `vg-cc-legacy/hooks/user-prompt-submit.sh` | Working curl examples for vge-client reference |
| PRD_1 §4.1 | `docs/prd/PRD_1/PRD_1.md` | PreToolUse decision ordering — 5 exact steps |
| PRD_1 §7.6 | `docs/prd/PRD_1/PRD_1.md` | VGE payload limits and binary detection |
| PRD_1 §7.7 | `docs/prd/PRD_1/PRD_1.md` | Confidence Router routing rules and thresholds |
| PRD_1 §7.9 | `docs/prd/PRD_1/PRD_1.md` | Ask Dialog format and fatigue cap |
| PRD_1 §7.9.1 | `docs/prd/PRD_1/PRD_1.md` | Reply parser vocabulary and aliases |
| PRD_1 §7.9.2 | `docs/prd/PRD_1/PRD_1.md` | Audit event JSONL shapes |
| PRD_1 §7.10 | `docs/prd/PRD_1/PRD_1.md` | Per-tool resource_id canonicalization table |
| PRD_1 §7.11 | `docs/prd/PRD_1/PRD_1.md` | Credential deny list — full 9-pattern list |
| PRD_1 §7.12 | `docs/prd/PRD_1/PRD_1.md` | Subagent shared-reference model |

---

## Acceptance Criteria

- [ ] All 11 unit test files pass (`pnpm test`)
- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm lint` exits 0
- [ ] PreToolUse decision ordering matches PRD_1 §4.1 exactly (verified by test fixtures)
- [ ] Confidence Router boundary tests pass: score 89→ESCALATE, score 90→HARD_TAINT
- [ ] `analyzeToolOutput` returns null on VGE error (never throws)
- [ ] `postUserPrompt` is fire-and-forget (never awaited in the calling path)
- [ ] Subagent session shares state by reference (mutation in child visible in parent)
- [ ] `formatDenyReason` output contains the ask-dialog 4-option vocabulary
- [ ] Credential paths denied regardless of `policy.credential_protection` flag at the module level (the toggle is applied in `http-server.ts`, not in `path-deny.ts`)
