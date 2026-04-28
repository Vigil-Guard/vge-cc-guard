import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('audit-logger', () => {
  let tmpDir: string;
  let originalEnv: string | undefined;
  let logger: typeof import('../../src/daemon/audit-logger.js');

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vge-audit-test-'));
    originalEnv = process.env['VGE_CC_GUARD_CONFIG_DIR'];
    process.env['VGE_CC_GUARD_CONFIG_DIR'] = tmpDir;
    logger = await import('../../src/daemon/audit-logger.js');
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env['VGE_CC_GUARD_CONFIG_DIR'];
    } else {
      process.env['VGE_CC_GUARD_CONFIG_DIR'] = originalEnv;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function readLog(): object[] {
    const logPath = path.join(tmpDir, 'audit.log');
    if (!fs.existsSync(logPath)) return [];
    return fs
      .readFileSync(logPath, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as object);
  }

  it('PR-W1: stale audit.log from yesterday is rotated on first append today (process restart case)', async () => {
    // Plant a "yesterday" audit.log with mtime set 2 days ago
    const logPath = path.join(tmpDir, 'audit.log');
    fs.writeFileSync(logPath, JSON.stringify({ event_type: 'old', timestamp: '2026-04-26T12:00:00Z' }) + '\n');
    const twoDaysAgo = Date.now() - 2 * 24 * 3600 * 1000;
    fs.utimesSync(logPath, twoDaysAgo / 1000, twoDaysAgo / 1000);

    // Fresh module load — simulates daemon restart
    vi.resetModules();
    const fresh = await import('../../src/daemon/audit-logger.js');

    fresh.logCredentialPathDenied({
      sessionId: 'sess_w1',
      resolvedPath: '/x/y',
      credentialProtectionEnabled: true,
    });

    // Yesterday's log should have been rotated to audit.log.YYYY-MM-DD
    const rotated = fs
      .readdirSync(tmpDir)
      .find((f) => /^audit\.log\.\d{4}-\d{2}-\d{2}$/.test(f));
    expect(rotated).toBeDefined();
    // Today's audit.log contains only the new event
    const events = readLog();
    expect(events).toHaveLength(1);
    expect((events[0] as { event_type: string }).event_type).toBe('credential_path_denied');
  });

  it("logToolOutputEscalated writes JSONL with event_type='tool_output_escalated'", () => {
    logger.logToolOutputEscalated({
      escalationId: 'esc_1',
      sessionId: 'sess_1',
      toolName: 'WebFetch',
      resourceId: 'https://example.com',
      analysisId: null,
      branches: { heuristics: 0, semantic: 72, llmGuard: 0 },
      routerOutcome: 'ESCALATE',
    });
    const events = readLog();
    expect(events).toHaveLength(1);
    expect((events[0] as Record<string, unknown>)['event_type']).toBe('tool_output_escalated');
  });

  it('logEscalationResolved writes resolution_delay_ms as a positive number', () => {
    logger.logEscalationResolved({
      escalationId: 'esc_1',
      sessionId: 'sess_1',
      decision: 'once',
      enqueuedAt: Date.now() - 500,
    });
    const events = readLog();
    const event = events[0] as Record<string, unknown>;
    expect(event['event_type']).toBe('escalation_resolved');
    expect(typeof event['resolution_delay_ms']).toBe('number');
    expect((event['resolution_delay_ms'] as number) > 0).toBe(true);
  });

  it("logToolOutputAnalyzed with userAllowlisted=true writes enforcement_taken='none'", () => {
    logger.logToolOutputAnalyzed({
      sessionId: 'sess_1',
      toolName: 'WebFetch',
      resourceId: 'https://example.com',
      userAllowlisted: true,
      routerOutcome: 'HARD_TAINT',
      enforcementTaken: 'none',
    });
    const event = readLog()[0] as Record<string, unknown>;
    expect(event['enforcement_taken']).toBe('none');
    expect(event['user_allowlisted']).toBe(true);
  });

  it('logCredentialPathDenied writes the resolved path', () => {
    logger.logCredentialPathDenied({
      sessionId: 'sess_1',
      resolvedPath: '/home/user/.aws/credentials',
      credentialProtectionEnabled: true,
    });
    const event = readLog()[0] as Record<string, unknown>;
    expect(event['event_type']).toBe('credential_path_denied');
    expect(event['resolved_path']).toBe('/home/user/.aws/credentials');
  });

  it('each event has an ISO 8601 timestamp field', () => {
    logger.logToolOutputEscalated({
      escalationId: 'esc_2',
      sessionId: 'sess_1',
      toolName: 'Read',
      resourceId: '/tmp/foo',
      analysisId: null,
      branches: { heuristics: 55, semantic: 0, llmGuard: 0 },
      routerOutcome: 'HARD_TAINT',
    });
    const event = readLog()[0] as Record<string, unknown>;
    expect(typeof event['timestamp']).toBe('string');
    expect(() => new Date(event['timestamp'] as string).toISOString()).not.toThrow();
  });

  it('multiple events → multiple lines in the file, each valid JSON', () => {
    logger.logEscalationResolved({ escalationId: 'e1', sessionId: 's1', decision: 'block', enqueuedAt: Date.now() - 100 });
    logger.logEscalationResolved({ escalationId: 'e2', sessionId: 's1', decision: 'once', enqueuedAt: Date.now() - 200 });
    logger.logEscalationResolved({ escalationId: 'e3', sessionId: 's1', decision: 'session', enqueuedAt: Date.now() - 300 });
    expect(readLog()).toHaveLength(3);
  });

  it('retention cleanup: files older than 90 days are deleted', () => {
    // Create a rotated log file with a date 91 days ago
    const oldDate = new Date(Date.now() - 91 * 24 * 3600 * 1000);
    const oldDateStr = oldDate.toISOString().slice(0, 10);
    const oldLogPath = path.join(tmpDir, `audit.log.${oldDateStr}`);
    fs.writeFileSync(oldLogPath, '{"event_type":"old"}\n');

    // Create a recent log file (yesterday)
    const recentDate = new Date(Date.now() - 1 * 24 * 3600 * 1000);
    const recentDateStr = recentDate.toISOString().slice(0, 10);
    const recentLogPath = path.join(tmpDir, `audit.log.${recentDateStr}`);
    fs.writeFileSync(recentLogPath, '{"event_type":"recent"}\n');

    logger.cleanupOldLogs();
    expect(fs.existsSync(oldLogPath)).toBe(false);
    expect(fs.existsSync(recentLogPath)).toBe(true);
  });
});
