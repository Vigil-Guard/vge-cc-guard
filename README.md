# vge-agent-guard

Security sidecar for Claude Code. BLOCK-default runtime policy, scope-drift intent gating, full audit path, terminal UI.

**Status:** Bootstrapped 2026-04-18. Not yet a working product.

## What it does

- Intercepts Claude Code hooks (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `PermissionDenied`, `ConfigChange`, `SessionEnd`).
- Runs a local two-tier policy engine — fast L1 heuristics for obvious decisions, VGE-backed L2 analysis for the rest.
- Maps VGE detection output into a session state (`clean` / `caution` / `tainted`) that drives subsequent tool gating.
- Ships a terminal UI (`vge-guard`) for live configuration, event tail, approval management, and audit inspection.
- Persists audit trail locally (JSONL) and, when configured, to a VGE ClickHouse backend or SIEM.

## What it does not do

- MCP integration — out of scope for v1. Future work.
- Cursor, Copilot, or other agents — Claude Code only.
- Remote / cloud-hosted agents.
- Prompt-level scanning as a primary control — filter-only approaches miss developed IPIs (OpenAI). We gate actions, not prompts.

## Documentation

- [Concept and architecture](docs/architecture/claude-code-agent-security-integration.md) — canonical design doc
- [ADR index](docs/adr/) — architectural decisions, starting with language choice (ADR-0001)

## Positioning

| Product | Claude Code | Action | Shape |
|---|---|---|---|
| **vge-agent-guard** | yes | **BLOCK** | PreToolUse + PostToolUse + full TUI |
| Lasso `claude-hooks` | yes | warn | PostToolUse OSS, advisory |
| Anthropic built-in | yes | advisory | baseline (IPI probe + Auto Mode) |

## License

Proprietary — see [LICENSE.md](LICENSE.md).
