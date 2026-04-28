import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Readable } from 'stream';
import * as fs from 'fs';
import * as path from 'path';
import type { Config } from '../../src/shared/config-schema.js';
import { DEFAULT_CONFIG } from '../../src/shared/config-schema.js';

// Lazy-start is a no-op here — unit-tested in tests/unit/lazy-start.test.ts.
vi.mock('../../src/shim/lazy-start.js', () => ({
  ensureDaemonRunning: vi.fn().mockResolvedValue(undefined),
}));

// Statically import shim after mock registration.
// main() reads env vars and process.argv at call time — safe to import once.
import { main } from '../../src/shim/index.js';
import { ensureDaemonRunning } from '../../src/shim/lazy-start.js';

let tmpDir: string;
let daemon: { stop: () => Promise<void> };
let originalConfigDir: string | undefined;

beforeAll(async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ decision: 'ALLOWED', score: 5, branches: {} }),
    }),
  );

  tmpDir = fs.mkdtempSync('/tmp/vge-shim-test-');
  originalConfigDir = process.env['VGE_CC_GUARD_CONFIG_DIR'];
  process.env['VGE_CC_GUARD_CONFIG_DIR'] = tmpDir;

  const cfg: Config = {
    ...DEFAULT_CONFIG,
    vge: { ...DEFAULT_CONFIG.vge, api_key_input: 'vg_live_abc123def456ghi789jkl012mno345pqr' },
  };
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify(cfg));

  vi.resetModules();
  const { startDaemon } = await import('../../src/daemon/http-server.js');
  daemon = await startDaemon(path.join(tmpDir, 'daemon.sock'));
});

afterAll(async () => {
  await daemon?.stop();
  vi.unstubAllGlobals();
  if (originalConfigDir === undefined) {
    delete process.env['VGE_CC_GUARD_CONFIG_DIR'];
  } else {
    process.env['VGE_CC_GUARD_CONFIG_DIR'] = originalConfigDir;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function runShim(
  event: string,
  payload: unknown,
): Promise<{ exitCode: number; stdout: string }> {
  const origArgv = [...process.argv];
  process.argv = ['node', 'dist/cli.js', 'hook', event];

  const mockStdin = new Readable({ read() {} });
  mockStdin.push(JSON.stringify(payload));
  mockStdin.push(null);

  const origStdin = process.stdin;
  Object.defineProperty(process, 'stdin', { value: mockStdin, configurable: true });

  const writtenChunks: string[] = [];
  const writeStub = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    writtenChunks.push(String(chunk));
    return true;
  });

  let capturedCode = 0;
  const exitStub = vi.spyOn(process, 'exit').mockImplementation((code?: number | string) => {
    capturedCode = Number(code ?? 0);
    throw new Error(`__EXIT__${code ?? 0}`);
  }) as unknown as ReturnType<typeof vi.spyOn>;

  try {
    await main();
  } catch (err) {
    if (!(err instanceof Error && err.message.startsWith('__EXIT__'))) throw err;
  } finally {
    process.argv = origArgv;
    Object.defineProperty(process, 'stdin', { value: origStdin, configurable: true });
    writeStub.mockRestore();
    exitStub.mockRestore();
    mockStdin.destroy();
  }

  return { exitCode: capturedCode, stdout: writtenChunks.join('') };
}

async function runShimDaemonDown(
  event: string,
  payload: unknown,
): Promise<{ exitCode: number; stdout: string }> {
  const orig = process.env['VGE_CC_GUARD_CONFIG_DIR'];
  process.env['VGE_CC_GUARD_CONFIG_DIR'] = '/tmp/vge-no-daemon-xyzzy';
  try {
    return await runShim(event, payload);
  } finally {
    if (orig === undefined) delete process.env['VGE_CC_GUARD_CONFIG_DIR'];
    else process.env['VGE_CC_GUARD_CONFIG_DIR'] = orig;
  }
}

describe('shim-daemon integration', () => {
  it('A1: SessionStart → exit 0, empty stdout', async () => {
    const { exitCode, stdout } = await runShim('sessionstart', {
      session_id: 'shim-a1',
      hook_event_name: 'SessionStart',
    });
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  it('A2: PreToolUse allow → exit 0, permissionDecision=allow', async () => {
    await runShim('sessionstart', { session_id: 'shim-a2', hook_event_name: 'SessionStart' });
    const { exitCode, stdout } = await runShim('pretool', {
      session_id: 'shim-a2',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    expect(exitCode).toBe(0);
    const body = JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision: string } };
    expect(body.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('A3: PreToolUse block → exit 0, permissionDecision=deny', async () => {
    await runShim('sessionstart', { session_id: 'shim-a3', hook_event_name: 'SessionStart' });
    const { exitCode, stdout } = await runShim('pretool', {
      session_id: 'shim-a3',
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/x.ts', content: 'x' },
    });
    expect(exitCode).toBe(0);
    const body = JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision: string } };
    expect(body.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('A4: PreToolUse daemon DOWN → exit 2 (fail-closed)', async () => {
    const { exitCode } = await runShimDaemonDown('pretool', {
      session_id: 'shim-a4',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    expect(exitCode).toBe(2);
  });

  it('A5: PostToolUse daemon DOWN → exit 0 (fail-open)', async () => {
    const { exitCode } = await runShimDaemonDown('posttool', {
      session_id: 'shim-a5',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_response: 'file.txt',
      tool_error: null,
    });
    expect(exitCode).toBe(0);
  });

  it('A6: UserPromptSubmit daemon DOWN → exit 0 (fail-open)', async () => {
    const { exitCode } = await runShimDaemonDown('userprompt', {
      session_id: 'shim-a6',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'hello',
    });
    expect(exitCode).toBe(0);
  });

  it('A7: malformed JSON on stdin, pretool → exit 2 (fail-closed)', async () => {
    const origArgv = [...process.argv];
    process.argv = ['node', 'dist/cli.js', 'hook', 'pretool'];

    const mockStdin = new Readable({ read() {} });
    mockStdin.push('not-json{{{');
    mockStdin.push(null);
    const origStdin = process.stdin;
    Object.defineProperty(process, 'stdin', { value: mockStdin, configurable: true });

    let capturedCode = 0;
    const exitStub = vi.spyOn(process, 'exit').mockImplementation((code?: number | string) => {
      capturedCode = Number(code ?? 0);
      throw new Error(`__EXIT__${code ?? 0}`);
    }) as unknown as ReturnType<typeof vi.spyOn>;

    try {
      await main();
    } catch (err) {
      if (!(err instanceof Error && err.message.startsWith('__EXIT__'))) throw err;
    } finally {
      process.argv = origArgv;
      Object.defineProperty(process, 'stdin', { value: origStdin, configurable: true });
      exitStub.mockRestore();
      mockStdin.destroy();
    }

    expect(capturedCode).toBe(2);
  });

  it('A8: ensureDaemonRunning is called on every hook invocation', async () => {
    vi.mocked(ensureDaemonRunning).mockClear();
    await runShim('sessionstart', { session_id: 'shim-a8', hook_event_name: 'SessionStart' });
    expect(vi.mocked(ensureDaemonRunning)).toHaveBeenCalledOnce();
  });

  it('A9: PostToolUse daemon UP → exit 0, empty stdout', async () => {
    await runShim('sessionstart', { session_id: 'shim-a9', hook_event_name: 'SessionStart' });
    const { exitCode, stdout } = await runShim('posttool', {
      session_id: 'shim-a9',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_response: 'file.txt',
      tool_error: null,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  it('A11 [PR-C2]: pretool with HTML/non-JSON daemon body → exit 2 (fail-closed)', async () => {
    // Spin up a rogue server on a separate temp dir and point the shim there.
    const rogueDir = fs.mkdtempSync('/tmp/vge-rogue-');
    const rogueSocket = path.join(rogueDir, 'daemon.sock');
    const http = await import('http');
    const rogue = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html>internal error</html>');
    });
    await new Promise<void>((resolve) => rogue.listen(rogueSocket, () => resolve()));

    const orig = process.env['VGE_CC_GUARD_CONFIG_DIR'];
    process.env['VGE_CC_GUARD_CONFIG_DIR'] = rogueDir;

    try {
      const { exitCode } = await runShim('pretool', {
        session_id: 'shim-c2',
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      });
      expect(exitCode).toBe(2);
    } finally {
      await new Promise<void>((resolve) => rogue.close(() => resolve()));
      fs.rmSync(rogueDir, { recursive: true, force: true });
      if (orig === undefined) delete process.env['VGE_CC_GUARD_CONFIG_DIR'];
      else process.env['VGE_CC_GUARD_CONFIG_DIR'] = orig;
    }
  });

  it('A12 [PR-C2]: pretool with daemon 500 status → exit 2 (fail-closed)', async () => {
    const rogueDir = fs.mkdtempSync('/tmp/vge-rogue-500-');
    const rogueSocket = path.join(rogueDir, 'daemon.sock');
    const http = await import('http');
    const rogue = http.createServer((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":"boom"}');
    });
    await new Promise<void>((resolve) => rogue.listen(rogueSocket, () => resolve()));

    const orig = process.env['VGE_CC_GUARD_CONFIG_DIR'];
    process.env['VGE_CC_GUARD_CONFIG_DIR'] = rogueDir;

    try {
      const { exitCode } = await runShim('pretool', {
        session_id: 'shim-c2-500',
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      });
      expect(exitCode).toBe(2);
    } finally {
      await new Promise<void>((resolve) => rogue.close(() => resolve()));
      fs.rmSync(rogueDir, { recursive: true, force: true });
      if (orig === undefined) delete process.env['VGE_CC_GUARD_CONFIG_DIR'];
      else process.env['VGE_CC_GUARD_CONFIG_DIR'] = orig;
    }
  });

  it('A10: SessionEnd → exit 0, empty stdout', async () => {
    await runShim('sessionstart', { session_id: 'shim-a10', hook_event_name: 'SessionStart' });
    const { exitCode, stdout } = await runShim('sessionend', {
      session_id: 'shim-a10',
      hook_event_name: 'SessionEnd',
    });
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });
});
