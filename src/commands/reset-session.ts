import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

interface SessionFile {
  sessionId: string;
  lastActivity: number;
  filePath: string;
  data: Record<string, unknown>;
}

function resolveSessionsDir(): string {
  const base = process.env['VGE_CC_GUARD_CONFIG_DIR'] ?? path.join(os.homedir(), '.vge-cc-guard');
  return path.join(base, 'sessions');
}

function loadSessions(sessionsDir: string): SessionFile[] {
  if (!fs.existsSync(sessionsDir)) return [];
  const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
  const sessions: SessionFile[] = [];
  for (const file of files) {
    const filePath = path.join(sessionsDir, file);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
      sessions.push({
        sessionId: data['sessionId'] as string,
        lastActivity: (data['lastActivity'] as number) ?? 0,
        filePath,
        data,
      });
    } catch {
      // skip malformed files
    }
  }
  return sessions.sort((a, b) => b.lastActivity - a.lastActivity);
}

export async function runResetSession(): Promise<void> {
  const sessionsDir = resolveSessionsDir();
  const sessions = loadSessions(sessionsDir);

  if (sessions.length === 0) {
    console.log('No active sessions found.');
    return;
  }

  const target = sessions[0]!;
  const updated = {
    ...target.data,
    allowlist: [],
    pendingEscalations: [],
    escalationCount: 0,
    state: 'clean',
  };

  fs.writeFileSync(target.filePath, JSON.stringify(updated, null, 2), 'utf-8');
  console.log(`Session reset: ${target.sessionId}`);
  console.log('The session will resume in clean state.');
}
