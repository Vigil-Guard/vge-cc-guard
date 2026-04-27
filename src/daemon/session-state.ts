import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SessionData, SessionState, Escalation } from '../shared/types.js';

const sessionStore = new Map<string, SessionData>();

function getSessionsDir(): string {
  const base = process.env['VGE_CC_GUARD_CONFIG_DIR'] ?? path.join(os.homedir(), '.vge-cc-guard');
  return path.join(base, 'sessions');
}

function persistSession(data: SessionData): void {
  const dir = getSessionsDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${data.sessionId}.json`), JSON.stringify({
    ...data,
    allowlist: [...data.allowlist],
  }));
}

export function createSession(sessionId: string, parentSessionId: string | null): SessionData {
  if (parentSessionId !== null) {
    const parent = sessionStore.get(parentSessionId);
    if (parent) {
      sessionStore.set(sessionId, parent); // shared reference — PRD §7.12
      return parent;
    }
  }
  const data: SessionData = {
    sessionId,
    parentSessionId,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    state: 'clean',
    allowlist: new Set<string>(),
    pendingEscalations: [],
    escalationCount: 0,
  };
  sessionStore.set(sessionId, data);
  return data;
}

export function getSession(sessionId: string): SessionData | undefined {
  return sessionStore.get(sessionId);
}

export function deleteSession(sessionId: string): void {
  sessionStore.delete(sessionId);
}

export function transitionState(sessionId: string, newState: SessionState): void {
  const data = sessionStore.get(sessionId);
  if (!data) return;
  data.state = newState;
  data.lastActivity = Date.now();
  persistSession(data);
}

export function addToAllowlist(sessionId: string, key: string): void {
  const data = sessionStore.get(sessionId);
  if (!data) return;
  data.allowlist.add(key);
  data.lastActivity = Date.now();
  persistSession(data);
}

export function enqueueEscalation(sessionId: string, esc: Escalation): void {
  const data = sessionStore.get(sessionId);
  if (!data) return;
  data.pendingEscalations.push(esc);
  data.escalationCount++;
  data.lastActivity = Date.now();
  persistSession(data);
}

export function dequeueEscalation(sessionId: string): Escalation | undefined {
  const data = sessionStore.get(sessionId);
  if (!data) return undefined;
  const esc = data.pendingEscalations.shift();
  if (esc) {
    data.lastActivity = Date.now();
    persistSession(data);
  }
  return esc;
}

export function gcIdleSessions(ttlHours: number): void {
  const cutoff = Date.now() - ttlHours * 3600 * 1000;
  for (const [id, data] of sessionStore) {
    if (data.lastActivity < cutoff) {
      sessionStore.delete(id);
      try {
        fs.unlinkSync(path.join(getSessionsDir(), `${id}.json`));
      } catch {
        // file may not exist — ignore
      }
    }
  }
}
