import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { DEFAULT_CONFIG } from '../../src/shared/config-schema.js';
import type { Config } from '../../src/shared/config-schema.js';

// Minimal fetch over unix socket
function socketPost(socketPath: string, route: string, body: unknown): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        socketPath,
        path: route,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          try { resolve({ status: res.statusCode ?? 0, json: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode ?? 0, json: data }); }
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

describe('http-server', () => {
  let tmpDir: string;
  let socketPath: string;
  let server: { stop: () => Promise<void> };
  let originalEnv: string | undefined;

  beforeAll(async () => {
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ decision: 'ALLOWED', score: 5, branches: {} }) }));

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vge-server-test-'));
    originalEnv = process.env['VGE_CC_GUARD_CONFIG_DIR'];
    process.env['VGE_CC_GUARD_CONFIG_DIR'] = tmpDir;
    socketPath = path.join(tmpDir, 'daemon.sock');

    // Write config with Bash=allow and Write=block
    const cfg: Config = {
      ...DEFAULT_CONFIG,
      vge: { ...DEFAULT_CONFIG.vge, api_key_input: 'vg_live_abc123def456ghi789jkl012mno345pqr' },
    };
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify(cfg));

    const mod = await import('../../src/daemon/http-server.js');
    server = await mod.startDaemon(socketPath);
  });

  afterAll(async () => {
    await server?.stop();
    vi.unstubAllGlobals();
    if (originalEnv === undefined) {
      delete process.env['VGE_CC_GUARD_CONFIG_DIR'];
    } else {
      process.env['VGE_CC_GUARD_CONFIG_DIR'] = originalEnv;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('/health returns 200 { ok: true }', async () => {
    const res = await socketPost(socketPath, '/health', {});
    expect(res.status).toBe(200);
    expect((res.json as Record<string, unknown>)['ok']).toBe(true);
  });

  it('SessionStart → creates session', async () => {
    const res = await socketPost(socketPath, '/v1/hooks/sessionstart', {
      session_id: 'test_sess_start',
      hook_event_name: 'SessionStart',
    });
    expect(res.status).toBe(200);
  });

  it('SessionEnd → deletes session', async () => {
    await socketPost(socketPath, '/v1/hooks/sessionstart', { session_id: 'test_sess_end', hook_event_name: 'SessionStart' });
    const res = await socketPost(socketPath, '/v1/hooks/sessionend', { session_id: 'test_sess_end', hook_event_name: 'SessionEnd' });
    expect(res.status).toBe(200);
  });

  it('PreToolUse with gate=allow + clean session → allow', async () => {
    await socketPost(socketPath, '/v1/hooks/sessionstart', { session_id: 'sess_allow', hook_event_name: 'SessionStart' });
    const res = await socketPost(socketPath, '/v1/hooks/pretool', {
      session_id: 'sess_allow',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    const body = res.json as Record<string, Record<string, Record<string, string>>>;
    expect(body['hookSpecificOutput']['permissionDecision']).toBe('allow');
  });

  it('PreToolUse with gate=block → deny', async () => {
    await socketPost(socketPath, '/v1/hooks/sessionstart', { session_id: 'sess_block', hook_event_name: 'SessionStart' });
    const res = await socketPost(socketPath, '/v1/hooks/pretool', {
      session_id: 'sess_block',
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/test.ts', content: 'x' },
    });
    const body = res.json as Record<string, Record<string, Record<string, string>>>;
    expect(body['hookSpecificOutput']['permissionDecision']).toBe('deny');
  });

  it('PreToolUse on credential path → deny with credential deny message', async () => {
    await socketPost(socketPath, '/v1/hooks/sessionstart', { session_id: 'sess_cred', hook_event_name: 'SessionStart' });
    const res = await socketPost(socketPath, '/v1/hooks/pretool', {
      session_id: 'sess_cred',
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: `${os.homedir()}/.aws/credentials` },
    });
    const body = res.json as Record<string, Record<string, Record<string, string>>>;
    expect(body['hookSpecificOutput']['permissionDecision']).toBe('deny');
    expect(body['hookSpecificOutput']['permissionDecisionReason']).toContain('credential');
  });

  it('PreToolUse on tainted session + Bash → deny', async () => {
    await socketPost(socketPath, '/v1/hooks/sessionstart', { session_id: 'sess_tainted', hook_event_name: 'SessionStart' });
    // Force taint via PostToolUse returning HARD_TAINT (score >= 2 branches)
    // Simpler: send a PostToolUse where VGE mock returns BLOCKED
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ decision: 'BLOCKED', score: 90, branches: { heuristics: { score: 55 }, semantic: { score: 55 } } }),
    }));
    await socketPost(socketPath, '/v1/hooks/posttool', {
      session_id: 'sess_tainted',
      hook_event_name: 'PostToolUse',
      tool_name: 'WebFetch',
      tool_input: { url: 'https://evil.com' },
      tool_response: 'bad content',
      tool_error: null,
    });

    const res = await socketPost(socketPath, '/v1/hooks/pretool', {
      session_id: 'sess_tainted',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /' },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ decision: 'ALLOWED', score: 5, branches: {} }) }));
    const body = res.json as Record<string, Record<string, Record<string, string>>>;
    expect(body['hookSpecificOutput']['permissionDecision']).toBe('deny');
  });

  it('PreToolUse with pending escalation → deny with dialog text', async () => {
    await socketPost(socketPath, '/v1/hooks/sessionstart', { session_id: 'sess_esc', hook_event_name: 'SessionStart' });
    // Trigger an escalation via PostToolUse (single branch, mid-score)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ decision: 'ALLOWED', score: 72, branches: { semantic: { score: 72 } } }),
    }));
    await socketPost(socketPath, '/v1/hooks/posttool', {
      session_id: 'sess_esc',
      hook_event_name: 'PostToolUse',
      tool_name: 'WebFetch',
      tool_input: { url: 'https://suspicious.com' },
      tool_response: 'injection attempt',
      tool_error: null,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ decision: 'ALLOWED', score: 5, branches: {} }) }));

    const res = await socketPost(socketPath, '/v1/hooks/pretool', {
      session_id: 'sess_esc',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    const body = res.json as Record<string, Record<string, Record<string, string>>>;
    expect(body['hookSpecificOutput']['permissionDecision']).toBe('deny');
    expect(body['hookSpecificOutput']['permissionDecisionReason']).toContain('VGE Agent Guard');
  });

  it('PostToolUse with analyze_output=false → no VGE call', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ decision: 'ALLOWED', score: 0, branches: {} }) });
    vi.stubGlobal('fetch', mockFetch);
    await socketPost(socketPath, '/v1/hooks/sessionstart', { session_id: 'sess_noanalyze', hook_event_name: 'SessionStart' });
    await socketPost(socketPath, '/v1/hooks/posttool', {
      session_id: 'sess_noanalyze',
      hook_event_name: 'PostToolUse',
      tool_name: 'Glob', // analyze_output: false in DEFAULT_CONFIG
      tool_input: { pattern: '**/*.ts' },
      tool_response: 'src/index.ts\nsrc/app.ts',
      tool_error: null,
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('PostToolUse with VGE error → returns null (no crash)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('VGE down')));
    await socketPost(socketPath, '/v1/hooks/sessionstart', { session_id: 'sess_vgeerr', hook_event_name: 'SessionStart' });
    const res = await socketPost(socketPath, '/v1/hooks/posttool', {
      session_id: 'sess_vgeerr',
      hook_event_name: 'PostToolUse',
      tool_name: 'WebFetch',
      tool_input: { url: 'https://example.com' },
      tool_response: 'content',
      tool_error: null,
    });
    expect(res.status).toBe(200);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ decision: 'ALLOWED', score: 5, branches: {} }) }));
  });

  it('PreToolUse on allowlisted resource → allow (even with session in caution)', async () => {
    await socketPost(socketPath, '/v1/hooks/sessionstart', { session_id: 'sess_wl', hook_event_name: 'SessionStart' });
    // First: trigger escalation with semantic=72 so it queues
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ decision: 'ALLOWED', score: 72, branches: { semantic: { score: 72 } } }),
    }));
    await socketPost(socketPath, '/v1/hooks/posttool', {
      session_id: 'sess_wl',
      hook_event_name: 'PostToolUse',
      tool_name: 'WebFetch',
      tool_input: { url: 'https://trusted.com/page' },
      tool_response: 'trusted content',
      tool_error: null,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ decision: 'ALLOWED', score: 5, branches: {} }) }));

    // Resolve escalation with 'session' decision via UserPromptSubmit
    await socketPost(socketPath, '/v1/hooks/userprompt', {
      session_id: 'sess_wl',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'session',
    });

    // Now same resource should be allowed
    const res = await socketPost(socketPath, '/v1/hooks/pretool', {
      session_id: 'sess_wl',
      hook_event_name: 'PreToolUse',
      tool_name: 'WebFetch',
      tool_input: { url: 'https://trusted.com/page' },
    });
    const body = res.json as Record<string, Record<string, Record<string, string>>>;
    expect(body['hookSpecificOutput']['permissionDecision']).toBe('allow');
  });
});
