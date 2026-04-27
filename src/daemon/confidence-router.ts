import type { RouterOutcome, GuardResponseSubset } from '../shared/types.js';

const BRANCH_THRESHOLDS = {
  heuristics: 50,
  semantic: 50,
  llmGuard: 55,
} as const;

export function routeResponse(response: GuardResponseSubset): RouterOutcome {
  // Step 1: Hard VGE policy pre-check (exact order per PRD §7.7)
  if (response.ruleAction === 'BLOCK') return 'HARD_TAINT';
  if (response.decision === 'BLOCKED' && !response.ruleAction) return 'HARD_TAINT';
  if (response.failOpen === true) return 'SOFT_TAINT';
  if (response.decisionFlags?.some((f) => f.endsWith('_DEGRADED') || f === 'API_TIMEOUT')) {
    return 'SOFT_TAINT';
  }
  if (response.decision === 'SANITIZED') return 'SOFT_TAINT';

  // Step 2: Count agreed branches
  const agreedBranches = [
    (response.branches.heuristics?.score ?? 0) >= BRANCH_THRESHOLDS.heuristics,
    (response.branches.semantic?.score ?? 0) >= BRANCH_THRESHOLDS.semantic,
    (response.branches.llmGuard?.score ?? 0) >= BRANCH_THRESHOLDS.llmGuard,
  ].filter(Boolean).length;

  // Step 3: Route
  if (agreedBranches >= 2) return 'HARD_TAINT';
  if (agreedBranches === 1 && response.score >= 90) return 'HARD_TAINT';
  if (agreedBranches === 1 && response.score >= 55) return 'ESCALATE';
  if (agreedBranches === 1) return 'SOFT_TAINT';
  return 'ALLOW';
}
