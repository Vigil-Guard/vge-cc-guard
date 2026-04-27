import type { EscalationDecision } from '../shared/types.js';

const DECISION_MAP: Readonly<Record<string, EscalationDecision>> = Object.freeze({
  once: 'once',
  o: 'once',
  session: 'session',
  s: 'session',
  always: 'session',
  block: 'block',
  b: 'block',
  no: 'block',
  deny: 'block',
  stop: 'block',
  discard: 'block',
  quarantine: 'quarantine',
  q: 'quarantine',
  caution: 'quarantine',
});

export function parseReply(
  rawPrompt: string,
): { decision: EscalationDecision; residual: string } | null {
  const trimmed = rawPrompt.trim();
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();

  // Two-token check first (must precede single-token to avoid 'allow' ambiguity)
  if (lower.startsWith('allow once')) {
    return { decision: 'once', residual: trimmed.slice(10).trim() };
  }
  if (lower.startsWith('allow session')) {
    return { decision: 'session', residual: trimmed.slice(13).trim() };
  }
  // Bare 'allow' or 'allow <anything-else>' → ambiguous
  if (lower === 'allow' || lower.startsWith('allow ')) return null;

  // Single-token match
  const spaceIdx = lower.indexOf(' ');
  const token = (spaceIdx === -1 ? lower : lower.slice(0, spaceIdx)).slice(0, 20);
  const decision = DECISION_MAP[token];
  if (!decision) return null;

  const residual = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trimStart();
  return { decision, residual };
}
