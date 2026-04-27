import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { runResetSession } from '../../src/commands/reset-session.js';

let tmpDir: string;
let sessionsDir: string;
let originalConfigDir: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync('/tmp/vge-reset-test-');
  sessionsDir = path.join(tmpDir, 'sessions');
  originalConfigDir = process.env['VGE_CC_GUARD_CONFIG_DIR'];
  process.env['VGE_CC_GUARD_CONFIG_DIR'] = tmpDir;
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env['VGE_CC_GUARD_CONFIG_DIR'];
  else process.env['VGE_CC_GUARD_CONFIG_DIR'] = originalConfigDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeSession(id: string, lastActivity: number, overrides: Record<string, unknown> = {}): void {
  fs.mkdirSync(sessionsDir, { recursive: true });
  const data = {
    sessionId: id,
    parentSessionId: null,
    createdAt: lastActivity - 1000,
    lastActivity,
    state: 'caution',
    allowlist: ['bash:abc123def456', 'Read:/tmp/file.ts'],
    pendingEscalations: [{ escalationId: 'esc_1', sessionId: id }],
    escalationCount: 2,
    ...overrides,
  };
  fs.writeFileSync(path.join(sessionsDir, `${id}.json`), JSON.stringify(data), 'utf-8');
}

function readSession(id: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(sessionsDir, `${id}.json`), 'utf-8'),
  ) as Record<string, unknown>;
}

describe('reset-session', () => {
  it('H1: empty sessions dir → prints no active sessions and exits cleanly', async () => {
    fs.mkdirSync(sessionsDir, { recursive: true });
    await expect(runResetSession()).resolves.toBeUndefined();
  });

  it('H1b: sessions dir does not exist → exits cleanly', async () => {
    await expect(runResetSession()).resolves.toBeUndefined();
  });

  it('H2: one session → resets allowlist, escalations, state to clean', async () => {
    writeSession('sess-001', Date.now());
    await runResetSession();
    const data = readSession('sess-001');
    expect(data['allowlist']).toEqual([]);
    expect(data['pendingEscalations']).toEqual([]);
    expect(data['escalationCount']).toBe(0);
    expect(data['state']).toBe('clean');
  });

  it('H3: multiple sessions → resets the most recent (highest lastActivity)', async () => {
    const now = Date.now();
    writeSession('sess-old', now - 10_000);
    writeSession('sess-new', now);
    await runResetSession();
    const newest = readSession('sess-new');
    expect(newest['state']).toBe('clean');
    expect(newest['allowlist']).toEqual([]);
    // older session is untouched
    const older = readSession('sess-old');
    expect(older['state']).toBe('caution');
  });

  it('H4: malformed JSON session file is skipped, valid ones processed', async () => {
    const now = Date.now();
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, 'bad.json'), '{not-valid-json', 'utf-8');
    writeSession('sess-valid', now);
    await runResetSession();
    const data = readSession('sess-valid');
    expect(data['state']).toBe('clean');
  });

  it('H5: state field survives reset with correct value', async () => {
    writeSession('sess-tainted', Date.now(), { state: 'tainted' });
    await runResetSession();
    const data = readSession('sess-tainted');
    expect(data['state']).toBe('clean');
    expect(data['escalationCount']).toBe(0);
  });
});
