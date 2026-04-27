import { describe, it, expect, vi } from 'vitest';
import {
  hasPending,
  enqueue,
  applyDecision,
  formatDenyReason,
} from '../../src/daemon/ask-dialog.js';
import type { SessionData, Escalation } from '../../src/shared/types.js';

function makeSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    sessionId: 'sess_test',
    parentSessionId: null,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    state: 'clean',
    allowlist: new Set(),
    pendingEscalations: [],
    escalationCount: 0,
    ...overrides,
  };
}

function makeEscalation(overrides: Partial<Escalation> = {}): Escalation {
  return {
    escalationId: 'esc_1',
    sessionId: 'sess_test',
    toolName: 'WebFetch',
    resourceId: 'https://example.com/blog',
    analysisId: null,
    branches: { heuristics: 0, semantic: 72, llmGuard: 0 },
    routerOutcome: 'ESCALATE',
    enqueuedAt: Date.now(),
    ...overrides,
  };
}

describe('ask-dialog', () => {
  it('hasPending returns false for empty queue', () => {
    expect(hasPending(makeSession())).toBe(false);
  });

  it('hasPending returns true after enqueue', () => {
    const session = makeSession();
    enqueue(session, makeEscalation(), 3);
    expect(hasPending(session)).toBe(true);
  });

  it('enqueue returns ESCALATE when under fatigue cap', () => {
    const session = makeSession();
    expect(enqueue(session, makeEscalation(), 3)).toBe('ESCALATE');
  });

  it('enqueue returns HARD_TAINT and sets state=tainted when cap exceeded', () => {
    const session = makeSession({ escalationCount: 3 });
    const result = enqueue(session, makeEscalation(), 3);
    expect(result).toBe('HARD_TAINT');
    expect(session.state).toBe('tainted');
    // Escalation NOT added to queue when cap exceeded
    expect(session.pendingEscalations).toHaveLength(0);
  });

  it('applyDecision(once) dequeues the escalation, session state unchanged', () => {
    const session = makeSession();
    enqueue(session, makeEscalation(), 3);
    const stateStore = { transitionState: vi.fn(), addToAllowlist: vi.fn() };
    applyDecision(session, 'once', stateStore);
    expect(session.pendingEscalations).toHaveLength(0);
    expect(stateStore.transitionState).not.toHaveBeenCalled();
    expect(stateStore.addToAllowlist).not.toHaveBeenCalled();
  });

  it('applyDecision(session) dequeues + adds to allowlist', () => {
    const sess = makeSession();
    enqueue(sess, makeEscalation(), 3);
    const stateStore = { transitionState: vi.fn(), addToAllowlist: vi.fn() };
    applyDecision(sess, 'session', stateStore);
    expect(sess.pendingEscalations).toHaveLength(0);
    expect(stateStore.addToAllowlist).toHaveBeenCalledOnce();
  });

  it('applyDecision(block) dequeues + sets state=tainted', () => {
    const sess = makeSession();
    enqueue(sess, makeEscalation(), 3);
    const stateStore = { transitionState: vi.fn(), addToAllowlist: vi.fn() };
    applyDecision(sess, 'block', stateStore);
    expect(sess.pendingEscalations).toHaveLength(0);
    expect(stateStore.transitionState).toHaveBeenCalledWith(sess.sessionId, 'tainted');
  });

  it('applyDecision(quarantine) dequeues + sets state=caution', () => {
    const sess = makeSession();
    enqueue(sess, makeEscalation(), 3);
    const stateStore = { transitionState: vi.fn(), addToAllowlist: vi.fn() };
    applyDecision(sess, 'quarantine', stateStore);
    expect(sess.pendingEscalations).toHaveLength(0);
    expect(stateStore.transitionState).toHaveBeenCalledWith(sess.sessionId, 'caution');
  });

  it('formatDenyReason returns string containing tool name and resource id', () => {
    const esc = makeEscalation({ toolName: 'WebFetch', resourceId: 'https://example.com/blog' });
    const reason = formatDenyReason(esc, '');
    expect(reason).toContain('WebFetch');
    expect(reason).toContain('https://example.com/blog');
  });

  it('FIFO: second escalation stays after first is resolved', () => {
    const sess = makeSession();
    enqueue(sess, makeEscalation({ escalationId: 'esc_1' }), 5);
    enqueue(sess, makeEscalation({ escalationId: 'esc_2' }), 5);
    const stateStore = { transitionState: vi.fn(), addToAllowlist: vi.fn() };
    applyDecision(sess, 'once', stateStore);
    expect(sess.pendingEscalations).toHaveLength(1);
    expect(sess.pendingEscalations[0]?.escalationId).toBe('esc_2');
  });
});
