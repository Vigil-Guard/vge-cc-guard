import type { SessionData, Escalation, EscalationDecision, RouterOutcome, SessionState } from '../shared/types.js';

export function hasPending(session: SessionData): boolean {
  return session.pendingEscalations.length > 0;
}

export function enqueue(
  session: SessionData,
  escalation: Escalation,
  fatigueCapPerSession: number,
): RouterOutcome {
  if (session.escalationCount >= fatigueCapPerSession) {
    session.state = 'tainted';
    return 'HARD_TAINT';
  }
  session.pendingEscalations.push(escalation);
  session.escalationCount++;
  return 'ESCALATE';
}

export function formatDenyReason(escalation: Escalation, triggerExcerpt: string): string {
  const excerpt = triggerExcerpt.slice(0, 120);
  const branchSummary = Object.entries(escalation.branches)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ') || 'none';

  return [
    'VGE Agent Guard: tool output flagged by VGE. Decide before continuing.',
    '',
    `  Tool:     ${escalation.toolName}`,
    `  Resource: ${escalation.resourceId}`,
    `  Score:    ${Object.values(escalation.branches).reduce((a, b) => Math.max(a, b), 0)}  (${branchSummary})`,
    excerpt ? `  Trigger:  "...${excerpt}..."` : '',
    '',
    '  Why asking: VGE flagged this on a single branch (not corroborated).',
    '  Single-branch signals are FP-prone in educational cybersec content.',
    '',
    '  Reply:',
    '    once        — accept this result once; ask again if this exact',
    '                  (tool, resource) triggers again',
    '    session     — accept + trust THIS specific resource for the rest',
    '                  of the session',
    '    block       — reject this resource; keep the session tainted until',
    '                  reset or SessionEnd',
    '    quarantine  — accept but keep session on caution for 3 turns',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

interface StateStore {
  transitionState: (sessionId: string, state: SessionState) => void;
  addToAllowlist: (sessionId: string, key: string) => void;
}

export function applyDecision(
  session: SessionData,
  decision: EscalationDecision,
  stateStore: StateStore,
): Escalation | undefined {
  const esc = session.pendingEscalations.shift();
  if (!esc) return undefined;

  switch (decision) {
    case 'once':
      break;
    case 'session':
      // resourceId is already the canonical key (set during PostToolUse processing)
      stateStore.addToAllowlist(session.sessionId, esc.resourceId);
      break;
    case 'block':
      stateStore.transitionState(session.sessionId, 'tainted');
      break;
    case 'quarantine':
      stateStore.transitionState(session.sessionId, 'caution');
      break;
  }

  return esc;
}
