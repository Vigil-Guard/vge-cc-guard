import { spawn } from 'child_process';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

const DAEMON_WAIT_MS = 1_000;
const POLL_INTERVAL_MS = 50;

function getSocketPath(): string {
  const base = process.env['VGE_CC_GUARD_CONFIG_DIR'] ?? path.join(os.homedir(), '.vge-cc-guard');
  return path.join(base, 'daemon.sock');
}

function socketExists(): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection(getSocketPath());
    sock.once('connect', () => {
      sock.destroy();
      resolve(true);
    });
    sock.once('error', () => {
      sock.destroy();
      resolve(false);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function ensureDaemonRunning(): Promise<void> {
  if (await socketExists()) return;

  // process.argv[1] is the cli.js binary path — passed as-is per PRD_1 §4.3.
  // DO NOT path.resolve it: that resolves relative to the PATH STRING, not the directory.
  const daemonBin = process.argv[1]!;
  const child = spawn(process.execPath, [daemonBin, 'daemon'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  const deadline = Date.now() + DAEMON_WAIT_MS;
  while (Date.now() < deadline) {
    if (await socketExists()) return;
    await sleep(POLL_INTERVAL_MS);
  }
}
