import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as net from 'net';
import * as fs from 'fs';

// vi.hoisted ensures variables exist before vi.mock factory is executed.
const { mockSpawn, mockUnref } = vi.hoisted(() => {
  const mockUnref = vi.fn();
  const mockSpawn = vi.fn().mockReturnValue({ unref: mockUnref });
  return { mockSpawn, mockUnref };
});

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: mockSpawn };
});

import { ensureDaemonRunning } from '../../src/shim/lazy-start.js';

let tmpDir: string;
let originalConfigDir: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync('/tmp/vge-lazy-test-');
  originalConfigDir = process.env['VGE_CC_GUARD_CONFIG_DIR'];
  process.env['VGE_CC_GUARD_CONFIG_DIR'] = tmpDir;
  // Reset call history but keep implementation (mockReturnValue is set in vi.hoisted)
  mockSpawn.mockClear();
  mockUnref.mockClear();
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env['VGE_CC_GUARD_CONFIG_DIR'];
  else process.env['VGE_CC_GUARD_CONFIG_DIR'] = originalConfigDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function startSocketServer(socketPath: string): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(socketPath, () => resolve(server));
  });
}

function stopSocketServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('lazy-start', () => {
  it('C1/C3: socket exists → ensureDaemonRunning returns without spawning', async () => {
    const socketPath = `${tmpDir}/daemon.sock`;
    const server = await startSocketServer(socketPath);
    try {
      await ensureDaemonRunning();
      expect(mockSpawn).not.toHaveBeenCalled();
    } finally {
      await stopSocketServer(server);
    }
  });

  it('C2/C4: no socket → ensureDaemonRunning calls spawn', async () => {
    // spawn returns mockChild with unref() — but no socket appears, so poll times out
    await ensureDaemonRunning();
    expect(mockSpawn).toHaveBeenCalledOnce();
  });

  it('C5: returns within ~1100ms even if daemon never starts (poll deadline)', async () => {
    const start = Date.now();
    await ensureDaemonRunning();
    expect(Date.now() - start).toBeLessThan(1100);
  });

  it('C6: spawn invoked with correct args (execPath, [argv1, daemon], detached+ignore)', async () => {
    await ensureDaemonRunning();
    expect(mockSpawn).toHaveBeenCalledWith(
      process.execPath,
      [process.argv[1], 'daemon'],
      { detached: true, stdio: 'ignore' },
    );
  });

  it('C7: child.unref() called so daemon outlives the shim', async () => {
    await ensureDaemonRunning();
    expect(mockUnref).toHaveBeenCalledOnce();
  });

  it('C8: socket appears during poll → returns without waiting full deadline', async () => {
    const socketPath = `${tmpDir}/daemon.sock`;
    // Start socket server 200ms after ensureDaemonRunning begins polling
    const timer = setTimeout(async () => {
      const server = net.createServer();
      server.listen(socketPath);
      // leave server running — lazy-start poll will detect it
    }, 200);

    const start = Date.now();
    await ensureDaemonRunning();
    const elapsed = Date.now() - start;
    clearTimeout(timer);

    // Should return well before the 1000ms deadline
    expect(elapsed).toBeLessThan(800);
    expect(mockSpawn).toHaveBeenCalledOnce();
  });
});
