import { describe, it, expect } from 'vitest';
import type {
  PreToolResponse,
  PostToolResponse,
  UserPromptResponse,
  SessionStartResponse,
  SessionEndResponse,
  ShimRequest,
  DaemonResponse,
} from '../../src/shared/ipc-protocol.js';

describe('ipc-protocol', () => {
  it('PreToolResponse deny shape — no top-level decision field (Claude Code PreToolUse spec)', () => {
    const resp: PreToolResponse = {
      event: 'pretool',
      ccOutput: {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'Credential path denied',
        },
      },
    };
    expect(resp.ccOutput.hookSpecificOutput.permissionDecision).toBe('deny');
    expect('decision' in resp.ccOutput).toBe(false);
  });

  it('PreToolResponse allow shape — reason is optional', () => {
    const resp: PreToolResponse = {
      event: 'pretool',
      ccOutput: {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      },
    };
    expect(resp.ccOutput.hookSpecificOutput.permissionDecisionReason).toBeUndefined();
  });

  it('PreToolResponse ask shape', () => {
    const resp: PreToolResponse = {
      event: 'pretool',
      ccOutput: {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: 'Low-confidence threat — user confirmation required',
        },
      },
    };
    expect(resp.ccOutput.hookSpecificOutput.permissionDecision).toBe('ask');
  });

  it('PostToolResponse null ccOutput means pass-through (no enforcement)', () => {
    const resp: PostToolResponse = { event: 'posttool', ccOutput: null };
    expect(resp.ccOutput).toBeNull();
  });

  it('PostToolResponse block shape provides feedback to Claude', () => {
    const resp: PostToolResponse = {
      event: 'posttool',
      ccOutput: { decision: 'block', reason: 'Suspicious tool output detected' },
    };
    expect(resp.ccOutput?.decision).toBe('block');
    expect(resp.ccOutput?.reason).toBeTruthy();
  });

  it('UserPromptResponse null ccOutput means pass-through', () => {
    const resp: UserPromptResponse = { event: 'userprompt', ccOutput: null };
    expect(resp.ccOutput).toBeNull();
  });

  it('UserPromptResponse block shape', () => {
    const resp: UserPromptResponse = {
      event: 'userprompt',
      ccOutput: { decision: 'block', reason: 'Session tainted — reset-session to continue' },
    };
    expect(resp.ccOutput?.decision).toBe('block');
  });

  it('SessionStart response has null ccOutput', () => {
    const resp: SessionStartResponse = { event: 'sessionstart', ccOutput: null };
    expect(resp.ccOutput).toBeNull();
  });

  it('SessionEnd response has null ccOutput', () => {
    const resp: SessionEndResponse = { event: 'sessionend', ccOutput: null };
    expect(resp.ccOutput).toBeNull();
  });

  it('ShimRequest accepts all five event names', () => {
    const events: ShimRequest['event'][] = [
      'sessionstart', 'userprompt', 'pretool', 'posttool', 'sessionend',
    ];
    expect(events).toHaveLength(5);
  });

  it('DaemonResponse discriminated union — sessionstart and sessionend both have null ccOutput', () => {
    const responses: DaemonResponse[] = [
      { event: 'sessionstart', ccOutput: null },
      { event: 'sessionend', ccOutput: null },
    ];
    for (const r of responses) {
      expect(r.ccOutput).toBeNull();
    }
  });
});
