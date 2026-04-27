import { describe, it, expect } from 'vitest';
import { routeResponse } from '../../src/daemon/confidence-router.js';
import type { GuardResponseSubset } from '../../src/shared/types.js';

function resp(overrides: Partial<GuardResponseSubset>): GuardResponseSubset {
  return {
    decision: 'ALLOWED',
    score: 0,
    branches: {},
    ...overrides,
  };
}

describe('confidence-router', () => {
  it('ruleAction=BLOCK → HARD_TAINT (overrides everything)', () => {
    expect(routeResponse(resp({ ruleAction: 'BLOCK' }))).toBe('HARD_TAINT');
  });

  it('decision=BLOCKED, no ruleAction → HARD_TAINT', () => {
    expect(routeResponse(resp({ decision: 'BLOCKED' }))).toBe('HARD_TAINT');
  });

  it('failOpen=true → SOFT_TAINT', () => {
    expect(routeResponse(resp({ failOpen: true }))).toBe('SOFT_TAINT');
  });

  it("decisionFlags contains 'HEURISTICS_DEGRADED' → SOFT_TAINT", () => {
    expect(routeResponse(resp({ decisionFlags: ['HEURISTICS_DEGRADED'] }))).toBe('SOFT_TAINT');
  });

  it("decisionFlags contains 'API_TIMEOUT' → SOFT_TAINT", () => {
    expect(routeResponse(resp({ decisionFlags: ['API_TIMEOUT'] }))).toBe('SOFT_TAINT');
  });

  it('decision=SANITIZED → SOFT_TAINT', () => {
    expect(routeResponse(resp({ decision: 'SANITIZED' }))).toBe('SOFT_TAINT');
  });

  it('2 branches agree (heuristics=55, semantic=55) → HARD_TAINT', () => {
    expect(
      routeResponse(
        resp({
          score: 55,
          branches: { heuristics: { score: 55 }, semantic: { score: 55 } },
        }),
      ),
    ).toBe('HARD_TAINT');
  });

  it('1 branch (llmGuard=95), score=95 → HARD_TAINT (score >= 90 guard)', () => {
    expect(
      routeResponse(resp({ score: 95, branches: { llmGuard: { score: 95 } } })),
    ).toBe('HARD_TAINT');
  });

  it('1 branch (semantic=72), score=72 → ESCALATE (55..89 band)', () => {
    expect(
      routeResponse(resp({ score: 72, branches: { semantic: { score: 72 } } })),
    ).toBe('ESCALATE');
  });

  it('1 branch (heuristics=49), score=49 → ALLOW (below threshold = 0 agreed)', () => {
    expect(
      routeResponse(resp({ score: 49, branches: { heuristics: { score: 49 } } })),
    ).toBe('ALLOW');
  });

  it('1 branch (semantic=54), score=54 → SOFT_TAINT (agreed=1, score<55)', () => {
    expect(
      routeResponse(resp({ score: 54, branches: { semantic: { score: 54 } } })),
    ).toBe('SOFT_TAINT');
  });

  it('0 branches, score=0 → ALLOW', () => {
    expect(routeResponse(resp({ score: 0 }))).toBe('ALLOW');
  });

  // Boundary tests (CRITICAL)
  it('boundary: heuristics=50 counts as agreed (>= threshold)', () => {
    expect(
      routeResponse(resp({ score: 50, branches: { heuristics: { score: 50 } } })),
    ).toBe('SOFT_TAINT'); // agreed=1, score<55 → SOFT_TAINT
  });

  it('boundary: heuristics=49 does NOT count as agreed', () => {
    expect(
      routeResponse(resp({ score: 49, branches: { heuristics: { score: 49 } } })),
    ).toBe('ALLOW');
  });

  it('boundary: score=89 → ESCALATE (not HARD_TAINT)', () => {
    expect(
      routeResponse(resp({ score: 89, branches: { semantic: { score: 89 } } })),
    ).toBe('ESCALATE');
  });

  it('boundary: score=90 → HARD_TAINT', () => {
    expect(
      routeResponse(resp({ score: 90, branches: { llmGuard: { score: 90 } } })),
    ).toBe('HARD_TAINT');
  });

  it('llmGuard threshold=55: llmGuard=55 → ESCALATE (triggered, score=55 >= 55)', () => {
    expect(
      routeResponse(resp({ score: 55, branches: { llmGuard: { score: 55 } } })),
    ).toBe('ESCALATE');
  });

  it('llmGuard threshold=55: llmGuard=54 → NOT triggered (0 agreed → ALLOW)', () => {
    expect(
      routeResponse(resp({ score: 54, branches: { llmGuard: { score: 54 } } })),
    ).toBe('ALLOW');
  });
});
