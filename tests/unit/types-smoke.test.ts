import { describe, it, expect } from 'vitest';
import type {
  SessionData,
  RouterOutcome,
  CCPreToolPayload,
  CCPostToolPayload,
  CCUserPromptPayload,
  CCSessionStartPayload,
} from '../../src/shared/types.js';

describe('types', () => {
  it('SessionData can be constructed with Set allowlist', () => {
    const s: SessionData = {
      sessionId: 'sess_abc',
      parentSessionId: null,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      state: 'clean',
      allowlist: new Set<string>(),
      pendingEscalations: [],
      escalationCount: 0,
    };
    expect(s.state).toBe('clean');
    expect(s.allowlist.size).toBe(0);
  });

  it('SessionState union covers all three values', () => {
    const states: SessionData['state'][] = ['clean', 'caution', 'tainted'];
    expect(states).toHaveLength(3);
  });

  it('RouterOutcome union covers all four values', () => {
    const outcomes: RouterOutcome[] = ['HARD_TAINT', 'SOFT_TAINT', 'ESCALATE', 'ALLOW'];
    expect(outcomes).toHaveLength(4);
  });

  it('CCPreToolPayload shape has required fields', () => {
    const p: CCPreToolPayload = {
      hook_event_name: 'PreToolUse',
      session_id: 'sess_001',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    };
    expect(p.hook_event_name).toBe('PreToolUse');
    expect(p.tool_input).toEqual({ command: 'ls' });
  });

  it('CCPostToolPayload has tool_error nullable', () => {
    const p: CCPostToolPayload = {
      hook_event_name: 'PostToolUse',
      session_id: 'sess_001',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/x' },
      tool_response: 'content',
      tool_error: null,
    };
    expect(p.tool_error).toBeNull();
  });

  it('CCUserPromptPayload has prompt field', () => {
    const p: CCUserPromptPayload = {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'sess_001',
      prompt: 'Hello world',
    };
    expect(p.prompt).toBe('Hello world');
  });

  it('CCSessionStartPayload accepts parent_session_id for subagents', () => {
    const p: CCSessionStartPayload = {
      hook_event_name: 'SessionStart',
      session_id: 'sub_001',
      parent_session_id: 'master_001',
    };
    expect(p.parent_session_id).toBe('master_001');
  });

  it('SessionData parentSessionId null for top-level sessions', () => {
    const s: SessionData = {
      sessionId: 'top_001',
      parentSessionId: null,
      createdAt: 0,
      lastActivity: 0,
      state: 'tainted',
      allowlist: new Set(['Bash:/tmp/script.sh']),
      pendingEscalations: [],
      escalationCount: 2,
    };
    expect(s.parentSessionId).toBeNull();
    expect(s.allowlist.has('Bash:/tmp/script.sh')).toBe(true);
  });
});
