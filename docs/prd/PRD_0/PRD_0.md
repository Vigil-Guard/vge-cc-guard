# PRD_0 — User Prompt Logger (Interim, Pre-Sidecar)

**Status:** Draft for implementation
**Author:** Tomasz Bartel
**Created:** 2026-04-20
**Target branch:** `main`
**Owners:** vge-agent-guard
**Related:**
[Concept doc](../../architecture/claude-code-agent-security-integration.md),
[ADR-0001](../../adr/ADR-0001-project-scope-and-language.md),
[PRD_V1 placeholder](../PRD_V1/README.md),
[VGE PRD_29](../../../../Vigil-Guard-Enterprise/docs/prd/PRD_29/PRD_29.md),
[VGE PRD_28](../../../../Vigil-Guard-Enterprise/docs/prd/PRD_28/PRD_28.md)

---

## 1. Executive Summary

The full `vge-agent-guard` sidecar (Phase 1 of the concept doc) is still pending. ADR-0001 defers the language choice. `src/` is empty. Building the sidecar — L1 heuristics, L2 dispatch, session state, TUI, BLOCK-default enforcement — is multi-week work.

Meanwhile, one piece of the concept is already deliverable with **a single bash script and a settings.json snippet**: capture every user prompt in a Claude Code session and forward it to VGE for detection and audit logging. No enforcement, no tool gating, no session state — just the `UserPromptSubmit` hook calling `POST /v1/guard/input`.

PRD_0 is that interim deliverable. It gives developers working with Claude Code **full user-prompt visibility in VGE today**, sets the wire-format that the full sidecar will reuse, and stays out of the way of the Phase 1 design.

**Estimated effort:** half a working day including script, examples, installer, README, and smoke test against local VGE.

---

## 2. Problem Statement

### 2.1 What exists today

- VGE already accepts `POST /v1/guard/input` with `prompt` + `metadata` (schemas in [packages/shared/src/schemas/index.ts:8-18](../../../../Vigil-Guard-Enterprise/packages/shared/src/schemas/index.ts#L8-L18)).
- VGE PRD_28 added a narrow metadata allowlist that lifts up to ten flat keys into `arbiter_json.agentContext` (see extractor at [services/arbiter-worker/src/agent-context/extractor.ts](../../../../Vigil-Guard-Enterprise/services/arbiter-worker/src/agent-context/extractor.ts)). Alias path accepts `session_id`, `prompt_id`, `hook_event`, `tool_name`, `tool_use_id` and a few others.
- VGE PRD_29 (pending) promotes these to typed first-class fields `agent` / `tool` / `conversation` with full flat-column + SIEM coverage; keeps the PRD_28 alias path as a legacy bridge.
- Claude Code exposes a `UserPromptSubmit` hook that fires on **every** user message regardless of whether it triggers any tool use — documented under [code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks).

### 2.2 What is missing

- No way for a Claude Code user today to route their prompts to VGE without writing everything themselves.
- The sidecar concept doc (canonical) focuses almost entirely on **tool gating** (`PreToolUse` / `PostToolUse`). Plain user-prompt logging is a much smaller problem that does not need the sidecar machinery at all.
- Without a stopgap, the VGE integration story for Claude Code looks gated on Phase 1 sidecar delivery, which is not true.

### 2.3 Why this matters

- Developers already using both Claude Code and VGE want prompt-level audit today, not in six weeks.
- User-prompt detection is exactly the use case VGE branches are calibrated for (PRD_21 Pangea, user-input attack corpora). Tool-output detection is weaker today (see PRD_29 §16.8). Shipping prompt logging first is the highest-value, lowest-risk integration.
- A published stopgap locks down the wire format before the sidecar ships. When the sidecar lands in Phase 1, it inherits exactly the same HTTP payload shape — no breaking change for users.

---

## 3. Goals and Non-Goals

### 3.1 Goals

PRD_0 must:

1. Ship a single POSIX-compatible hook script that reads Claude Code's `UserPromptSubmit` stdin-JSON payload and posts it to VGE `POST /v1/guard/input`.
2. Provide an `examples/prompt-logger-v0/` directory with the script, a `settings.json` snippet, and a one-page `README.md` for users who want to enable it.
3. Preserve full backward compatibility with VGE today (PRD_28 metadata-bag) **and** forward compatibility with VGE after PRD_29 (typed `agent` field) — both wire formats must be supported.
4. Fail-open on any error: VGE unreachable, network timeout, bad JSON, missing env var. The user's Claude Code session must never be blocked by this script.
5. Never log API keys or full prompts to stderr/stdout.
6. Stay under 100 lines of shell code. Single responsibility: UserPromptSubmit → VGE → done.

### 3.2 Non-Goals

PRD_0 explicitly does **not**:

1. Register or process `PreToolUse`, `PostToolUse`, `PermissionDenied`, `ConfigChange`, `SessionEnd`, or any other hook. Those require the sidecar.
2. Implement enforcement, BLOCK decisions, or any form of gating. `UserPromptSubmit` is advisory in the concept doc and PRD_0 keeps it that way.
3. Maintain session state (`clean`/`caution`/`tainted`). That's Phase 1 sidecar.
4. Provide a TUI, admin UI, or configuration surface beyond environment variables and the hook script itself.
5. Implement L1 heuristics, local caching, or concurrency control. This is a fire-and-forget HTTP POST.
6. Replace the sidecar. When Phase 1 lands, PRD_0 is superseded for installed users and kept as a reference example for constrained environments.
7. Touch VGE code. VGE accepts the payload as-is under both PRD_28 and PRD_29 contracts.

---

## 4. Deliverables

```
vge-agent-guard/
├── docs/prd/PRD_0/
│   └── PRD_0.md                                 # This document
│
└── examples/prompt-logger-v0/
    ├── README.md                                # One-page install guide for users
    ├── user-prompt-submit.sh                    # The hook script itself (<100 lines)
    └── settings.json.snippet                    # Copy-paste fragment for ~/.claude/settings.json
```

Files are examples, not installed products. They live under `examples/` (matching `examples/managed-settings.template.json` convention from [CLAUDE.md:347-349](../../../CLAUDE.md#L347-L349)).

Nothing in `src/` is created by PRD_0 — the script is a deliberate, disposable shim that users copy and own.

---

## 5. Architecture

```
Claude Code session
    │
    │ stdin-JSON payload on every user prompt:
    │   { session_id, prompt_id, hook_event_name: "UserPromptSubmit",
    │     prompt, transcript_path }
    ▼
user-prompt-submit.sh  (registered in ~/.claude/settings.json)
    │
    │ HTTP POST, fire-and-forget, timeout 5s, fail-open
    ▼
VGE /v1/guard/input
    │
    ├── Zod validation passes (new fields optional under PRD_29;
    │   metadata-bag accepted under PRD_28)
    ├── Detection branches analyze `prompt` (heuristics + semantic + llm-guard + pii)
    ├── PRD_28 extractor lifts metadata.session_id, metadata.prompt_id
    │   into arbiter_json.agentContext
    └── Logging worker writes events_v2 + events_v2_payload
    │
    ▼
ClickHouse:
    events_v2                         ─ flat columns incl. agent_session_id (post-PRD_29)
    events_v2_payload.arbiter_json    ─ full agentContext + branch scores
    │
    ▼
Vector → SIEM (CEF + JSON)
```

`exit 0` always. Claude Code treats `UserPromptSubmit` as advisory — there is no enforcement path in PRD_0.

---

## 6. Wire Format

Two wire formats are supported from day one so the script works against any VGE build.

### 6.1 Post-PRD_29 (typed, preferred)

```json
{
  "prompt": "<user text>",
  "agent": {
    "framework": "claude-code",
    "sessionId": "<session_id from hook>",
    "promptId": "<prompt_id from hook>",
    "hookEvent": "UserPromptSubmit"
  }
}
```

### 6.2 Pre-PRD_29 (metadata-bag, legacy bridge)

```json
{
  "prompt": "<user text>",
  "metadata": {
    "platform": "claude-code",
    "session_id": "<session_id from hook>",
    "prompt_id": "<prompt_id from hook>",
    "hookEvent": "UserPromptSubmit"
  }
}
```

### 6.3 Detection rule

The script always emits **both** `agent` and `metadata`. VGE pre-PRD_29 validates successfully because unknown top-level keys are either accepted or will be after the PRD_29 schema lands; if the pre-PRD_29 build rejects the `agent` object, the script switches to `metadata`-only via an env toggle (`VGE_WIRE_FORMAT=legacy`). Default is `auto` — emit both, accept 400 silently, retry `metadata`-only once. Post-PRD_29 the typed path is authoritative; legacy bridge in the arbiter extractor remains the fallback.

This mirrors the backward-compatibility contract PRD_29 already commits to.

---

## 7. Implementation Notes

### 7.0 Installation Philosophy (CRITICAL)

**PRD_0 is built on universal, one-time installation — zero per-project configuration required.**

1. **Global install** (one-time, per user):
   - Copy script to `~/.claude/vg-cc/user-prompt-submit.sh`
   - Register hooks in `~/.claude/settings.json`
   - Configure credentials in `~/.claude/.env`

2. **Works everywhere automatically:**
   - Every project you open in Claude Code uses the same hook and credentials
   - No per-project `.env` files needed
   - New projects work immediately with zero setup

3. **Optional per-project override:**
   - If a project needs different credentials (e.g., prod API key), create `project/.claude/.env`
   - Hook checks project-level first, falls back to user-level
   - Rare case; most projects just work with the global config

**This is intentional:** the installation burden is 5 minutes total. The user-level `~/.claude/.env` is the **de facto credential source** for all Claude Code integration — both the hook and future tooling share it.

### 7.1 Environment variables (only configuration surface)

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `VGE_API_URL` | no | `https://api.vigilguard` | Base URL of the VGE API |
| `VGE_API_KEY` | yes | — | Bearer token, format `vg_(live\|test)_...` |
| `VGE_TIMEOUT_SECONDS` | no | `5` | Per-request timeout; cap at 10 |
| `VGE_WIRE_FORMAT` | no | `auto` | `auto` / `typed` / `legacy` |
| `VGE_LOG_FILE` | no | `/tmp/vge-prompt-logger.log` | Local diagnostic log (no prompt text, no key) |

Missing `VGE_API_KEY` logs a warning to `$VGE_LOG_FILE` and exits `0`. Fail-open is absolute.

### 7.2 Script dependencies

- `bash >= 4.0` (available on macOS via `/bin/bash` or `/opt/homebrew/bin/bash`)
- `jq` — hard dependency for JSON parsing; the `README.md` lists install commands for macOS and Linux
- `curl` — virtually always available

No `python`, `node`, or SDK install required. Keeping the shim POSIX-leaning is the point.

### 7.3 Payload size guardrails

- Claude Code hook JSON can be large when the transcript path is long or when a user pastes huge blobs into a prompt.
- VGE enforces `MAX_PROMPT_LENGTH = 100000` ([packages/shared/src/schemas/index.ts:5](../../../../Vigil-Guard-Enterprise/packages/shared/src/schemas/index.ts#L5)).
- Script truncates the `prompt` field to 99,000 UTF-8 bytes before sending and sets `metadata.vge_prompt_truncated = true` when truncation happens. Truncation never prevents the POST.

### 7.4 Privacy and logging discipline

- **Never** echo the prompt text to stderr, stdout, or `$VGE_LOG_FILE`.
- **Never** log the API key. Log only: timestamp, hook event name, HTTP status, request id if returned.
- Respect `VGE_LOG_FILE=/dev/null` — user can disable all local logging.

### 7.5 Idempotency

- The script generates `X-Idempotency-Key: idem_<prompt_id or uuid>` header, matching the Python SDK convention. VGE ignores duplicates.

---

## 8. Backward and Forward Compatibility

| Scenario | Behavior |
|----------|----------|
| VGE build is **pre-PRD_28** (no alias path) | Works. `prompt` reaches branches; `metadata` is logged as `clientMetadata`. No `agentContext`. |
| VGE build is **PRD_28 only** (current production) | Works. `metadata.session_id` / `prompt_id` land in `agentContext` via the existing alias path. |
| VGE build is **post-PRD_29** (typed schema) | Works. Typed `agent` is the primary source; `metadata` is still carried and ignored for agentContext purposes. Flat column `agent_session_id` populates; SIEM CEF carries it. |
| Claude Code version drops or renames `UserPromptSubmit` payload fields | Script degrades: missing `session_id` → empty string; missing `prompt_id` → generated `uuid`. No hard error. |
| Rate limiting returns `429` | Fail-open. Log the status. Do not retry. |

No migration is ever needed on the user's side. When Phase 1 sidecar lands, the user replaces the hook line in `~/.claude/settings.json` with the sidecar's HTTP hook endpoint. The wire format seen by VGE is identical.

---

## 9. Security and Privacy

- Script runs in the user's local shell context. No elevated privileges requested.
- API key travels only over HTTPS to the user-configured endpoint. Self-signed certs supported via standard curl env (`CURL_CA_BUNDLE`).
- Script does not read `.env`, `.ssh/`, `.aws/`, `.kube/`, `credentials*`, or `secrets*`. Matches the sidecar's own L1 deny-list (per [CLAUDE.md:297](../../../CLAUDE.md#L297)).
- Script does not write the prompt body anywhere other than the HTTPS POST body. No on-disk spillage.
- Users running in regulated environments can point `VGE_API_URL` to an on-premise VGE without changes.

---

## 10. Acceptance Criteria

PRD_0 is accepted when:

1. `examples/prompt-logger-v0/user-prompt-submit.sh` exists, is `< 100` lines, passes `shellcheck`, and runs on macOS (bash 3.2 and 5.x) and Linux (bash 4.x+).
2. `examples/prompt-logger-v0/README.md` documents install in under one page, including prerequisite install commands for `jq` on macOS (Homebrew) and Debian/Ubuntu.
3. `examples/prompt-logger-v0/settings.json.snippet` is a valid JSON fragment that can be merged into `~/.claude/settings.json` verbatim.
4. A manual smoke test against a local VGE confirms: user submits a prompt in Claude Code, one row appears in `events_v2` with `metadata.session_id` (pre-PRD_29) or `agent_session_id` (post-PRD_29) correctly populated.
5. VGE unreachable → no user-visible error in Claude Code, exit code `0` from the script, a warning line appended to `$VGE_LOG_FILE`.
6. Missing `VGE_API_KEY` → same failure mode: exit `0`, warning logged, nothing blocked.
7. Prompt longer than 99,000 bytes is truncated and tagged; the event still reaches VGE.
8. No secrets in repo history; no API keys or prompt text in the script's own log output.

---

## 11. Tests and Validation

### 11.1 Shell tests

- `shellcheck user-prompt-submit.sh` — zero warnings.
- Dry-run mode (`VGE_DRY_RUN=1`) prints the intended curl payload (with API key redacted) to `$VGE_LOG_FILE` for inspection without actually posting.

### 11.2 Integration smoke test

One documented manual procedure:

1. Stand up VGE locally (`./scripts/stack.sh up -d` in the VGE repo).
2. Export `VGE_API_URL=https://api.vigilguard`, `VGE_API_KEY=<functional-key>`, `NODE_TLS_REJECT_UNAUTHORIZED=0` (local only).
3. Install the hook per `examples/prompt-logger-v0/README.md`.
4. Open Claude Code, submit three prompts (one benign, one with PII, one with an injection attempt).
5. Query `SELECT timestamp, decision, threat_score, detected_language FROM vigil.events_v2 ORDER BY timestamp DESC LIMIT 5`.
6. Expected: three rows visible, decisions reasonable (ALLOWED / SANITIZED / BLOCKED), `agent_session_id` populated on all three (assuming post-PRD_29 build).

### 11.3 Negative tests

- Kill VGE mid-session. Submit three more prompts. Confirm Claude Code does not freeze, error, or block; script log shows three `connection refused` warnings.
- Revoke API key. Submit a prompt. Confirm HTTP `401` logged, script exits `0`, user session continues.

---

## 12. Implementation Steps

### Phase 1 — script and example

1. Write `examples/prompt-logger-v0/user-prompt-submit.sh`.
2. Write `examples/prompt-logger-v0/settings.json.snippet`.
3. Write `examples/prompt-logger-v0/README.md` (install, env vars, troubleshooting, uninstall).
4. `shellcheck` clean.

### Phase 2 — docs and smoke test

5. Add a one-line pointer in the main `README.md`: *"For prompt-only logging today, see [examples/prompt-logger-v0](examples/prompt-logger-v0/README.md). Full sidecar comes in Phase 1."*
6. Run the integration smoke test from §11.2 against local VGE and record the results inline in `examples/prompt-logger-v0/README.md` under a `## Verified Against` section.

### Phase 3 — announce

7. Add changelog entry (no CHANGELOG.md yet — create it with one line under `## 0.1.0 (PRD_0)`).
8. Tag the commit `prompt-logger-v0` for traceability.

Suggested PR: one PR titled `feat(hooks): PRD_0 user prompt logger for Claude Code (interim)`.

---

## 13. Migration to Phase 1 (Sidecar)

When the sidecar ships (Phase 1 of the concept doc):

| PRD_0 component | Phase 1 replacement | Action for users |
|-----------------|---------------------|------------------|
| `examples/prompt-logger-v0/user-prompt-submit.sh` | sidecar's `UserPromptSubmit` HTTP hook endpoint | one-line change in `~/.claude/settings.json`: point hook at the local sidecar port instead of the script |
| `examples/prompt-logger-v0/settings.json.snippet` | `vge-guard init` installer | installer overwrites settings.json with the full hook set |
| env-var configuration | `~/.config/vge-guard/config.toml` + TUI | users migrate env vars into the config file |

The VGE wire format seen by the server is **identical** in both cases. No VGE-side change required at the Phase 1 cutover.

Users who cannot install the sidecar (restricted environments, shared dev boxes, CI runners) keep using PRD_0 indefinitely. The example stays supported.

---

## 14. Out of Scope (Explicit Deferrals)

- `PreToolUse` gating → Phase 1 sidecar.
- `PostToolUse` scanning → Phase 1 sidecar.
- Session state tracking → Phase 1 sidecar.
- Approval-fatigue mitigations → Phase 1 sidecar.
- TUI → Phase 1 sidecar.
- Managed settings enforcement (`allowManagedHooksOnly`, etc.) → Phase 1 sidecar.
- Conversation digest / multi-turn context → optional follow-up; not needed for prompt-only logging.

---

## 15. References

- Concept doc: [claude-code-agent-security-integration.md](../../architecture/claude-code-agent-security-integration.md)
- ADR-0001: [project-scope-and-language.md](../../adr/ADR-0001-project-scope-and-language.md)
- VGE PRD_28: [PRD_28.md](../../../../Vigil-Guard-Enterprise/docs/prd/PRD_28/PRD_28.md)
- VGE PRD_29: [PRD_29.md](../../../../Vigil-Guard-Enterprise/docs/prd/PRD_29/PRD_29.md)
- VGE guardInputSchema: [packages/shared/src/schemas/index.ts:8-18](../../../../Vigil-Guard-Enterprise/packages/shared/src/schemas/index.ts#L8-L18)
- VGE agent-context extractor: [services/arbiter-worker/src/agent-context/extractor.ts](../../../../Vigil-Guard-Enterprise/services/arbiter-worker/src/agent-context/extractor.ts)
- Claude Code hooks docs: https://code.claude.com/docs/en/hooks
- Claude Code security: https://code.claude.com/docs/en/security
- Lasso `claude-hooks` (competitor reference): https://github.com/lasso-security/claude-hooks
