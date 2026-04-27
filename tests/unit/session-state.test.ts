import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('session-state', () => {
  let tmpDir: string;
  let originalEnv: string | undefined;
  let store: typeof import('../../src/daemon/session-state.js');

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vge-session-test-'));
    originalEnv = process.env['VGE_CC_GUARD_CONFIG_DIR'];
    process.env['VGE_CC_GUARD_CONFIG_DIR'] = tmpDir;
    store = await import('../../src/daemon/session-state.js');
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env['VGE_CC_GUARD_CONFIG_DIR'];
    } else {
      process.env['VGE_CC_GUARD_CONFIG_DIR'] = originalEnv;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('createSession returns clean state with empty allowlist and no pending escalations', () => {
    const session = store.createSession('sess_001', null);
    expect(session.sessionId).toBe('sess_001');
    expect(session.parentSessionId).toBeNull();
    expect(session.state).toBe('clean');
    expect(session.allowlist.size).toBe(0);
    expect(session.pendingEscalations).toHaveLength(0);
    expect(session.escalationCount).toBe(0);
  });

  it('subagent session shares SAME OBJECT reference as parent', () => {
    store.createSession('master', null);
    store.createSession('sub', 'master');
    expect(Object.is(store.getSession('sub'), store.getSession('master'))).toBe(true);
  });

  it('taint propagation: transition in child visible through parent ID', () => {
    store.createSession('master', null);
    store.createSession('sub', 'master');
    store.transitionState('sub', 'tainted');
    expect(store.getSession('master')?.state).toBe('tainted');
  });

  it('addToAllowlist adds exactly one entry', () => {
    store.createSession('sess_002', null);
    store.addToAllowlist('sess_002', 'WebFetch:https://example.com');
    expect(store.getSession('sess_002')?.allowlist.size).toBe(1);
    expect(store.getSession('sess_002')?.allowlist.has('WebFetch:https://example.com')).toBe(true);
  });

  it('enqueue + dequeue escalation is FIFO', () => {
    store.createSession('sess_003', null);
    const esc1 = {
      escalationId: 'esc_1',
      sessionId: 'sess_003',
      toolName: 'WebFetch',
      resourceId: 'https://a.com',
      analysisId: null,
      branches: { heuristics: 0, semantic: 72, llmGuard: 0 },
      routerOutcome: 'ESCALATE' as const,
      enqueuedAt: Date.now(),
    };
    const esc2 = { ...esc1, escalationId: 'esc_2', resourceId: 'https://b.com' };
    store.enqueueEscalation('sess_003', esc1);
    store.enqueueEscalation('sess_003', esc2);
    expect(store.dequeueEscalation('sess_003')?.escalationId).toBe('esc_1');
    expect(store.dequeueEscalation('sess_003')?.escalationId).toBe('esc_2');
    expect(store.dequeueEscalation('sess_003')).toBeUndefined();
  });

  it('deleteSession removes the entry', () => {
    store.createSession('sess_004', null);
    store.deleteSession('sess_004');
    expect(store.getSession('sess_004')).toBeUndefined();
  });

  it('gcIdleSessions removes sessions older than TTL', () => {
    const sess = store.createSession('sess_old', null);
    // Backdate lastActivity by 25 hours
    sess.lastActivity = Date.now() - 25 * 3600 * 1000;
    store.gcIdleSessions(24);
    expect(store.getSession('sess_old')).toBeUndefined();
  });

  it('gcIdleSessions does not remove active sessions', () => {
    store.createSession('sess_active', null);
    store.gcIdleSessions(24);
    expect(store.getSession('sess_active')).toBeDefined();
  });
});
