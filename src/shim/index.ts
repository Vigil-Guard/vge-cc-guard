import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { ensureDaemonRunning } from './lazy-start.js';

const REQUEST_TIMEOUT_MS = 30_000;

function getSocketPath(): string {
  const base = process.env['VGE_CC_GUARD_CONFIG_DIR'] ?? path.join(os.homedir(), '.vge-cc-guard');
  return path.join(base, 'daemon.sock');
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

function sendToSocket(socketPath: string, event: string, payload: unknown): Promise<string | null> {
  return new Promise((resolve) => {
    // Daemon routes expect the CC payload directly; event name is conveyed via URL path.
    const body = JSON.stringify(payload);
    const req = http.request(
      {
        socketPath,
        path: `/v1/hooks/${event}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.write(body);
    req.end();
  });
}

// Daemon returns different shapes per event.
// pretool: { hookSpecificOutput: {...} }  — already CC-ready, write as-is.
// posttool/userprompt: { ccOutput: <payload|null> } — write ccOutput if non-null.
// sessionstart/sessionend: { ok: true } — write nothing.
function writeResponse(event: string, responseText: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    return;
  }

  if (event === 'pretool') {
    process.stdout.write(responseText.trimEnd() + '\n');
    return;
  }

  const wrapped = parsed as { ccOutput?: unknown };
  if (wrapped.ccOutput != null) {
    process.stdout.write(JSON.stringify(wrapped.ccOutput) + '\n');
  }
}

export async function main(): Promise<void> {
  const event = process.argv[3];
  if (!event) {
    process.stderr.write('vge-cc-guard hook: missing event name\n');
    process.exit(1);
  }

  let rawInput: string;
  try {
    rawInput = await readStdin();
  } catch {
    process.stderr.write('vge-cc-guard hook: failed to read stdin\n');
    process.exit(event === 'pretool' ? 2 : 0);
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawInput) as Record<string, unknown>;
  } catch {
    process.stderr.write('vge-cc-guard hook: invalid JSON on stdin\n');
    process.exit(2);
  }

  await ensureDaemonRunning();

  const socketPath = getSocketPath();
  const responseText = await sendToSocket(socketPath, event, payload);

  if (responseText === null) {
    process.exit(event === 'pretool' ? 2 : 0);
  }

  try {
    writeResponse(event, responseText);
  } catch {
    process.exit(event === 'pretool' ? 2 : 0);
  }

  process.exit(0);
}
