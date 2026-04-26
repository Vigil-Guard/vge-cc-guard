# Changelog

## Unreleased — 2026-04-26 (PRD_1 design lock)

### Architecture decisions locked

- Transport: command-shim hooks talking to a long-lived HTTP daemon over a Unix socket. Shim is the fail-closed boundary; daemon owns session state.
- Lifecycle: lazy auto-start of the daemon by the shim. No launchd/systemd registration in v1. Hybrid persistence — eager fsync for allowlist/escalations/state, lazy write-behind for telemetry.
- Detection model: sidecar does **not** run local content detection (no L1 patterns, no risk score 0–100). VGE is the only detector. Sidecar is a router + state machine + audit orchestrator.
- Credential path protection: hard-coded deny list for `~/.env`, `~/.ssh/`, `~/.aws/credentials`, `~/.kube/config`, `~/.gcp/`, `id_rsa*`, `*credentials*`, `*secrets*`. Configurable on/off in TUI; default ON.
- Tool defaults shifted to "safe by default": `Bash`, `Read`, `Grep` get `analyze_output: true`; `WebFetch`/`WebSearch` `gate: allow + analyze_output: true`; `Write`/`Edit` `gate: block`.
- Escalation: synchronous ask-dialog (PreToolUse `permissionDecision: deny` + `UserPromptSubmit` reply parser), no timeout, soft per-resource allowlist on `session` decision.
- Subagent inheritance: subagent sessions share full state with the master (allowlist, tainted state, escalation count, pending escalations) by reference.
- Truncation: dual-pass head+tail (50k + `[truncated]` + 50k) for long tool outputs sent to VGE, mirroring VGE llm-guard.
- VGE metadata enrichment: `vgeAgentGuard.{resourceId, userAllowlisted, escalationId, subagent, parentSessionId}`. `routerOutcome` and `enforcementTaken` stay in local audit JSONL.
- TUI configurator (`vge-cc-guard config`) shipped in Phase 1a MVP, not 1c. Live-monitoring views (events, stats, audit) stay in Phase 1c.
- CLI binary, npm package, and repo all named `vge-cc-guard`. Repo rename from `vge-agent-guard` is a manual step (see execution plan).

### Documentation refresh

- `docs/adr/ADR-0001-project-scope-and-language.md` moved from Proposed (Deferred) to Accepted with TypeScript locked.
- `docs/CONFIG_DESIGN.md` rewritten as canonical TUI specification consistent with PRD_1.
- `docs/prd/PRD_1/PRD_1.md` revised — L1 sections removed, defaults updated, ask-dialog moved to Phase 1a, credential protection added as §7.11, subagent inheritance added as §7.12, transport/lifecycle as §7.13, acceptance criteria pruned of FP/FN measurement (now VGE's responsibility).
- `docs/architecture/claude-code-agent-security-integration.md` — CLI name unified to `vge-cc-guard`, L1 references removed.
- PRD_0 references removed from PRD_1; Phase 0 history captured in PRD_1 §2 only.
- `README.md` rewritten to reflect the locked design.

## 0.1.0 — 2026-04-20 (PRD_0)

### Added

- `hooks/user-prompt-submit.sh` — fail-open Claude Code `UserPromptSubmit` hook posting to VGE `/v1/guard/input`.
- Safe `.env` loader (no `source`, no shell interpolation), project-scope then user-scope precedence.
- Dual wire format: typed `agent` (post-PRD_29) and `metadata` (pre-PRD_29) emitted together with automatic 400 → legacy retry.
- Prompt truncation at 99 000 bytes with `vge_prompt_truncated` flag.
- `VGE_DRY_RUN=1` preview mode — payload written to log, no HTTP call.
- Idempotency header `X-Idempotency-Key: idem_<prompt_id>`.
