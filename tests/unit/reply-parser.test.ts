import { describe, it, expect } from 'vitest';
import { parseReply } from '../../src/daemon/reply-parser.js';

describe('reply-parser', () => {
  it("'once' → { decision: 'once', residual: '' }", () => {
    expect(parseReply('once')).toEqual({ decision: 'once', residual: '' });
  });

  it("'o' → { decision: 'once', residual: '' }", () => {
    expect(parseReply('o')).toEqual({ decision: 'once', residual: '' });
  });

  it("'session do the thing' → { decision: 'session', residual: 'do the thing' }", () => {
    expect(parseReply('session do the thing')).toEqual({
      decision: 'session',
      residual: 'do the thing',
    });
  });

  it("'allow session' → { decision: 'session', residual: '' }", () => {
    expect(parseReply('allow session')).toEqual({ decision: 'session', residual: '' });
  });

  it("'allow once' → { decision: 'once', residual: '' }", () => {
    expect(parseReply('allow once')).toEqual({ decision: 'once', residual: '' });
  });

  it("'block' → { decision: 'block', residual: '' }", () => {
    expect(parseReply('block')).toEqual({ decision: 'block', residual: '' });
  });

  it("'no' → { decision: 'block', residual: '' }", () => {
    expect(parseReply('no')).toEqual({ decision: 'block', residual: '' });
  });

  it("'quarantine' → { decision: 'quarantine', residual: '' }", () => {
    expect(parseReply('quarantine')).toEqual({ decision: 'quarantine', residual: '' });
  });

  it("'q' → { decision: 'quarantine', residual: '' }", () => {
    expect(parseReply('q')).toEqual({ decision: 'quarantine', residual: '' });
  });

  it("'allow' (bare) → null (ambiguous)", () => {
    expect(parseReply('allow')).toBeNull();
  });

  it("'please continue' → null (not in vocabulary)", () => {
    expect(parseReply('please continue')).toBeNull();
  });

  it("'' → null (empty)", () => {
    expect(parseReply('')).toBeNull();
  });

  it("'   ONCE   ' → { decision: 'once', residual: '' } (case + trim)", () => {
    expect(parseReply('   ONCE   ')).toEqual({ decision: 'once', residual: '' });
  });

  it("residual is trimmed: 'session  do the  thing  ' → residual is 'do the  thing'", () => {
    const result = parseReply('session  do the  thing  ');
    expect(result?.decision).toBe('session');
    expect(result?.residual).toBe('do the  thing');
  });
});
