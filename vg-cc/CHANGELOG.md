# Changelog

## 0.1.0 — 2026-04-20 (PRD_0)

### Added
- `hooks/user-prompt-submit.sh` — fail-open Claude Code `UserPromptSubmit` hook posting to VGE `/v1/guard/input`.
- Safe `.env` loader (no `source`, no shell interpolation), project-scope then user-scope precedence.
- Dual wire format: typed `agent` (post-PRD_29) and `metadata` (pre-PRD_29) emitted together with automatic 400 → legacy retry.
- Prompt truncation at 99 000 bytes with `vge_prompt_truncated` flag.
- `VGE_DRY_RUN=1` preview mode — payload written to log, no HTTP call.
- Idempotency header `X-Idempotency-Key: idem_<prompt_id>`.
