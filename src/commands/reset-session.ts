import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

interface SessionFile {
  sessionId: string;
  lastActivity: number;
  filePath: string;
  data: Record<string, unknown>;
}

function resolveVgeDir(): string {
  return process.env['VGE_CC_GUARD_CONFIG_DIR'] ?? path.join(os.homedir(), '.vge-cc-guard');
}

function resolveSessionsDir(): string {
  return path.join(resolveVgeDir(), 'sessions');
}

function resolveSocketPath(): string {
  return path.join(resolveVgeDir(), 'daemon.sock');
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

// PR-review C1: prefer the daemon's control endpoint so that in-memory state
// (sessionStore) is reset alongside the disk file. Falls back to disk-only
// mutation when the daemon isn't reachable.
function tryDaemonReset(sessionId: string): Promise<boolean> {
  return new Promise((resolve) => {
    const body = JSON.stringify({ session_id: sessionId });
    const req = http.request(
      {
        socketPath: resolveSocketPath(),
        path: '/v1/control/reset-session',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 2_000,
      },
      (res) => {
        res.on('data', () => undefined);
        res.on('end', () => resolve((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300));
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.write(body);
    req.end();
  });
}

function resetOnDisk(target: SessionFile): void {
  const updated = {
    ...target.data,
    allowlist: [],
    pendingEscalations: [],
    escalationCount: 0,
    state: 'clean',
  };
  fs.writeFileSync(target.filePath, JSON.stringify(updated, null, 2), 'utf-8');
}

export async function runResetSession(): Promise<void> {
  const sessions = loadSessions(resolveSessionsDir());
  if (sessions.length === 0) {
    console.log('No active sessions found.');
    return;
  }

  const target = sessions[0]!;

  const daemonOk = await tryDaemonReset(target.sessionId);
  if (daemonOk) {
    console.log(`Session reset (via daemon): ${target.sessionId}`);
    console.log('The session will resume in clean state.');
    return;
  }

  // Daemon unreachable — disk-only fallback. Will be authoritative iff the
  // daemon never starts back up; otherwise the daemon's next persistSession
  // for this session would overwrite the reset.
  resetOnDisk(target);
  console.log(`Session reset (disk-only — daemon was not reachable): ${target.sessionId}`);
  console.log('Restart Claude Code if the session looks stuck.');
}
