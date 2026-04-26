# ADR-0001: Implementation Language for vge-cc-guard Sidecar

- **Status:** Accepted
- **Date:** 2026-04-26
- **Deciders:** tbartel74
- **Supersedes:** previous "Proposed (Deferred)" version dated 2026-04-18

## Context

The vge-cc-guard sidecar is the only moving part on the user's machine in the agent-protection design (see [concept doc](../architecture/claude-code-agent-security-integration.md)). Before writing code we need to pick:

1. **Project scope for v1** — what ships in the first release.
2. **Implementation language** — impacts distribution, TUI library availability, VGE integration effort, latency budget.

The original ADR deferred the decision pending a one-day spike per candidate (Python, Rust, Go, TypeScript). The decision was finalised in PRD_1 §7.1 after the architecture stabilised around npm distribution and VGE-process consistency.

## Decision

**TypeScript on Node.js, distributed as an npm package (`vge-cc-guard`).**

Scope for v1 is defined by [PRD_1](../prd/PRD_1/PRD_1.md): full sidecar covering UserPromptSubmit, PreToolUse, PostToolUse, SessionStart, SessionEnd hooks, with a TUI configurator. No MCP integration. Claude Code only.

### Why TypeScript

1. **npm distribution.** `npm install -g vge-cc-guard` is a single command that works on macOS, Linux, and Windows out of the box. No platform binaries to publish, no Homebrew tap, no apt repository. Updates by `npm update -g`.

2. **Consistency with VGE.** VGE backend is TypeScript (`apps/api`, workers). Sharing types via `packages/shared` is trivial. Team already has the toolchain installed.

3. **Latency is achievable.** The sidecar is a separate Node.js process from VGE, so its event loop is not contended. With L1 heuristics dropped (PRD_1 §7.2) the PreToolUse decision is a hash-map lookup plus session-state read — well under the 50 ms p99 budget. GC pauses on a small heap (`--max-old-space-size=512`) are not a concern at this workload.

4. **Iteration speed.** vitest, pino, ink, regexp-tree — all the libraries we need are mature and don't fight us. Faster than Rust or Go for the size of this project.

### Alternatives considered and rejected

- **Rust.** Best raw performance and single-binary story, but the npm-distribution shape doesn't fit. Cargo + per-platform release artifacts is friction we don't need. Rejected unless future profiling shows GC latency is a real problem; in that case a native module via N-API for the path-deny check is the escape hatch.
- **Go.** Same single-binary advantage as Rust, mature TUI ecosystem (`bubbletea`). Rejected for the same npm reason and for losing the VGE codebase consistency.
- **Python.** Cold-start latency on hook invocation (~150–300 ms) blows the latency budget even before any work is done. `pyinstaller`/`shiv` distribution is awkward. Rejected.

### Distribution decisions that follow from the language choice

- **Package name:** `vge-cc-guard` (binary name and repo name are the same).
- **Node version:** `>=18` (LTS at time of writing, Active LTS through 2025; Maintenance through 2025-04). Phase 2 will revisit when Node 20 LTS becomes maintenance-only.
- **TUI library:** `ink` (React-based) for the configurator screens. `blessed` rejected as too low-level for the small UI footprint.
- **HTTP server:** `express` for the daemon; minimal, well-known, easy to test.
- **Validation:** `zod`, mirroring VGE's contract.
- **Logger:** `pino` with rotating-file transport.

## Consequences

**Positive:**
- One install command everywhere. No platform-specific install instructions in the README.
- VGE schemas can be imported directly (potential future package re-use). For Phase 1 we re-declare the subset we need, to avoid pulling in the full VGE monorepo.
- Hot path is JS but the work is tiny — config lookup + state read + JSON marshalling. No detection logic in the sidecar (PRD_1 §7.2 removed L1 entirely). Performance is not a risk.

**Negative / accepted tradeoffs:**
- Cold start of the **command shim** (PRD_1 §4.4 transport) on each hook invocation is the latency floor. Mitigation: lazy daemon start (PRD_1 §7.13), so the shim is the only per-call cost; the heavy work runs in the long-lived daemon.
- Single-binary distribution via `pkg`/`nexe`/Bun is not pursued for v1. If users complain about Node.js prerequisite friction, Phase 2 can ship a Bun single-file binary in addition to the npm package.

## References

- [PRD_1 §7.1](../prd/PRD_1/PRD_1.md) — language decision rationale, alternatives, latency model
- [Concept doc](../architecture/claude-code-agent-security-integration.md) — overall architecture
- Lasso `claude-hooks` (Node.js) — competitive precedent that npm distribution works for this shape
