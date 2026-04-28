import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { RouterOutcome, EscalationDecision } from '../shared/types.js';

function getLogDir(): string {
  return process.env['VGE_CC_GUARD_CONFIG_DIR'] ?? path.join(os.homedir(), '.vge-cc-guard');
}

function getLogPath(): string {
  return path.join(getLogDir(), 'audit.log');
}

let lastWriteDate = '';

// PR-review W1: across daemon restarts, derive lastWriteDate from the existing
// audit.log mtime so a stale log from yesterday gets rotated on the first append today.
function bootstrapLastWriteDate(logPath: string): void {
  if (lastWriteDate) return;
  try {
    const mtime = fs.statSync(logPath).mtime;
    lastWriteDate = mtime.toISOString().slice(0, 10);
  } catch {
    // file doesn't exist yet — leave empty; first write will set today
  }
}

function appendEvent(event: Record<string, unknown>): void {
  const dir = getLogDir();
  fs.mkdirSync(dir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const logPath = getLogPath();

  bootstrapLastWriteDate(logPath);

  if (lastWriteDate && lastWriteDate !== today && fs.existsSync(logPath)) {
    fs.renameSync(logPath, path.join(dir, `audit.log.${lastWriteDate}`));
  }
  lastWriteDate = today;

  const line = JSON.stringify({ ...event, timestamp: new Date().toISOString() }) + '\n';
  fs.appendFileSync(logPath, line);
}

export function cleanupOldLogs(): void {
  const dir = getLogDir();
  if (!fs.existsSync(dir)) return;
  const cutoff = Date.now() - 90 * 24 * 3600 * 1000;
  for (const entry of fs.readdirSync(dir)) {
    const match = entry.match(/^audit\.log\.(\d{4}-\d{2}-\d{2})$/);
    if (!match) continue;
    const fileDate = new Date(match[1] as string).getTime();
    if (fileDate < cutoff) {
      fs.unlinkSync(path.join(dir, entry));
    }
  }
}

export function logToolOutputEscalated(params: {
  escalationId: string;
  sessionId: string;
  toolName: string;
  resourceId: string;
  analysisId: string | null;
  branches: Record<string, number>;
  routerOutcome: RouterOutcome;
}): void {
  appendEvent({
    event_type: 'tool_output_escalated',
    escalation_id: params.escalationId,
    session_id: params.sessionId,
    tool_name: params.toolName,
    resource_id: params.resourceId,
    analysis_id: params.analysisId,
    branches: params.branches,
    router_outcome: params.routerOutcome,
  });
}

export function logEscalationResolved(params: {
  escalationId: string;
  sessionId: string;
  decision: EscalationDecision;
  enqueuedAt: number;
}): void {
  appendEvent({
    event_type: 'escalation_resolved',
    escalation_id: params.escalationId,
    session_id: params.sessionId,
    decision: params.decision,
    decision_source: 'user',
    resolution_delay_ms: Date.now() - params.enqueuedAt,
  });
}

export function logToolOutputAnalyzed(params: {
  sessionId: string;
  toolName: string;
  resourceId: string;
  userAllowlisted: boolean;
  routerOutcome: RouterOutcome;
  enforcementTaken: 'none' | 'tainted' | 'escalated' | 'denied';
}): void {
  appendEvent({
    event_type: 'tool_output_analyzed',
    session_id: params.sessionId,
    tool_name: params.toolName,
    resource_id: params.resourceId,
    user_allowlisted: params.userAllowlisted,
    router_outcome: params.routerOutcome,
    enforcement_taken: params.enforcementTaken,
  });
}

export function logCredentialPathDenied(params: {
  sessionId: string;
  resolvedPath: string;
  credentialProtectionEnabled: boolean;
}): void {
  appendEvent({
    event_type: 'credential_path_denied',
    session_id: params.sessionId,
    resolved_path: params.resolvedPath,
    credential_protection_enabled: params.credentialProtectionEnabled,
  });
}
