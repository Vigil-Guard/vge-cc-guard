# ADR-0001: Project Scope and Implementation Language

- **Status:** Proposed (pending decision in next working session)
- **Date:** 2026-04-18
- **Deciders:** tbartel74

## Context

The vge-agent-guard product is specified in [docs/architecture/claude-code-agent-security-integration.md](../architecture/claude-code-agent-security-integration.md). Before writing code we need to pick:

1. **Project scope for v1** — what ships in the first release.
2. **Implementation language** — impacts single-binary distribution, TUI library availability, VGE integration effort, and hiring.

## Decision

**Deferred.** This ADR is a placeholder; the decision will be made after a short spike (est. 1 day per candidate language) that covers:

- Hook HTTP / stdin-JSON handshake responsiveness.
- TUI library ergonomics (for the split-pane `vge-guard` dashboard).
- Single-binary distribution story (developers will install, not run `pnpm dev`).
- Cross-platform support (macOS + Linux at minimum).

## Candidate Languages (to be evaluated)

### Option A: Python

**Pros:**
- Matches existing VGE Python services (`llm-guard`, `scope-drift-worker`, `presidio-api`, `language-detector`).
- Claude Code's hook stdin-JSON format is trivial to parse.
- TUI libraries: Textual (Rich-based), Urwid.
- Scaner scaffold (`.claude/hooks/*.py`) is already Python — reusable.

**Cons:**
- Single-binary distribution requires `pyinstaller` / `shiv` / `pyoxidizer` — extra complexity.
- Startup time on cold hook invocation matters for PreToolUse latency budget (<50 ms target).
- Dependency pinning + Python version handling on user machines.

### Option B: Rust

**Pros:**
- Single binary, fast startup, no runtime dependencies.
- `ratatui` is an excellent TUI library.
- Strong type system for policy engine correctness.

**Cons:**
- Steepest learning curve; slower initial iteration.
- No VGE code reuse — full HTTP client from scratch.
- Smaller contributor pool.

### Option C: Go

**Pros:**
- Single binary, fast startup.
- `bubbletea` + `lipgloss` + `bubbles` — mature TUI ecosystem.
- Simple concurrency for L1/L2 dispatch.
- Strong HTTP client stdlib.

**Cons:**
- No code reuse with VGE.
- Less rigorous than Rust, less familiar than Python in the team.

### Option D: TypeScript / Node

**Pros:**
- Matches VGE `apps/api` and workers.
- `ink` for React-based TUI, `blessed` as alternative.
- npm ecosystem for HTTP and hook parsing.

**Cons:**
- Single-binary distribution is awkward (`pkg`, `nexe`, Bun).
- Heavy runtime for a small sidecar.
- Cold-start latency concerns for PreToolUse.

## Recommendation (to be validated)

**Rust or Go for the sidecar, Python for optional scripts and tooling.**

The sidecar is on the critical path of every tool call. Startup-time and single-binary distribution dominate. Rust/Go both give us that. Between them, Go has faster iteration and a proven TUI library (`bubbletea`) used by major developer tools (`lazygit`, `gh`, `glow`). Rust gives stronger correctness guarantees for the policy engine.

**Proposed spike plan (next session):**

1. One-day Rust PoC — minimal hook → stdout JSON → `ratatui` hello-world.
2. One-day Go PoC — same scope using `bubbletea`.
3. Measure cold start, binary size, LoC for equivalent functionality.
4. Make final decision and update this ADR to Accepted.

## Alternatives Considered

- Pure Python MVP for speed, then port to Rust later: risk of never porting (Chesterton's fence) and locking in startup-time problems.
- Kotlin / Swift / other: no meaningful advantage for this use case.

## References

- Concept doc: [claude-code-agent-security-integration.md](../architecture/claude-code-agent-security-integration.md)
- Competitor reference: [Lasso `claude-hooks`](https://github.com/lasso-security/claude-hooks) — Node.js, uses Claude Code hooks
- `bubbletea`: https://github.com/charmbracelet/bubbletea
- `ratatui`: https://github.com/ratatui-org/ratatui
- `textual`: https://textual.textualize.io/
