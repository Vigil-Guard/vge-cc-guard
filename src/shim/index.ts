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

interface SocketResult {
  body: string;
  status: number;
}

function sendToSocket(socketPath: string, event: string, payload: unknown): Promise<SocketResult | null> {
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
        res.on('end', () =>
          resolve({ body: Buffer.concat(chunks).toString('utf8'), status: res.statusCode ?? 0 }),
        );
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

// Returns true iff the response was successfully forwarded to stdout in the
// shape Claude Code expects. False signals a malformed/non-JSON daemon response —
// caller decides exit code (fail-closed for pretool, fail-open otherwise).
function writeResponse(event: string, responseText: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    return false;
  }

  if (event === 'pretool') {
    // Daemon for pretool returns CC-ready { hookSpecificOutput: {...} }.
    // Verify the shape before claiming success — otherwise CC sees nothing
    // and defaults to allow (fail-open). PR-review C2.
    const hso = (parsed as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput;
    if (!hso || typeof hso.permissionDecision !== 'string') return false;
    process.stdout.write(responseText.trimEnd() + '\n');
    return true;
  }

  // posttool / userprompt / sessionstart / sessionend: { ccOutput: ... }
  const wrapped = parsed as { ccOutput?: unknown };
  if (wrapped.ccOutput != null) {
    process.stdout.write(JSON.stringify(wrapped.ccOutput) + '\n');
  }
  return true;
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
  const result = await sendToSocket(socketPath, event, payload);

  if (result === null) {
    process.exit(event === 'pretool' ? 2 : 0);
  }

  // Non-2xx from daemon → unparseable shape almost always; fail-closed for pretool.
  if (result.status < 200 || result.status >= 300) {
    process.stderr.write(`vge-cc-guard hook: daemon returned status ${result.status}\n`);
    process.exit(event === 'pretool' ? 2 : 0);
  }

  const ok = writeResponse(event, result.body);
  if (!ok) {
    process.stderr.write('vge-cc-guard hook: malformed daemon response\n');
    process.exit(event === 'pretool' ? 2 : 0);
  }

  process.exit(0);
}
