import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/shared/config-schema.js';
import type { Config } from '../../src/shared/config-schema.js';

const LIVE_KEY_CFG: Config = {
  ...DEFAULT_CONFIG,
  vge: { ...DEFAULT_CONFIG.vge, api_key_input: 'vg_live_abc123def456ghi789jkl012mno345pq' },
};

function makeGuardResponse() {
  return {
    decision: 'ALLOWED',
    score: 10,
    branches: {},
    timestamp: new Date().toISOString(),
  };
}

describe('vge-client', () => {
  let getConfig: () => Config;

  beforeEach(() => {
    vi.resetModules();
    getConfig = () => LIVE_KEY_CFG;
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function getClient() {
    const mod = await import('../../src/daemon/vge-client.js');
    mod.initClient(getConfig);
    return mod;
  }

  it('analyzeToolOutput sends correct request body with source=tool_output', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => makeGuardResponse(),
    });
    vi.stubGlobal('fetch', mockFetch);
    const client = await getClient();
    await client.analyzeToolOutput('hello', 'WebFetch', 'https://example.com', 'sess_1');
    expect(mockFetch).toHaveBeenCalledOnce();
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['source']).toBe('tool_output');
    expect((body['metadata'] as Record<string, unknown>)?.['vgeAgentGuard']).toBeTruthy();
    const vgeMeta = (body['metadata'] as Record<string, Record<string, unknown>>)['vgeAgentGuard'];
    expect(vgeMeta?.['resourceId']).toBe('https://example.com');
  });

  it('analyzeToolOutput returns null on 500 error (log and continue)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }),
    );
    const client = await getClient();
    const result = await client.analyzeToolOutput('hello', 'Read', '/tmp/f', 'sess_1');
    expect(result).toBeNull();
  });

  it('analyzeToolOutput returns null on network timeout', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));
    const client = await getClient();
    const result = await client.analyzeToolOutput('hello', 'Read', '/tmp/f', 'sess_1');
    expect(result).toBeNull();
  });

  it('analyzeToolOutput retries up to 3 times on 5xx', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
      .mockResolvedValue({ ok: true, json: async () => makeGuardResponse() });
    vi.stubGlobal('fetch', mockFetch);
    const client = await getClient();
    const result = await client.analyzeToolOutput('text', 'Bash', 'bash:abc', 'sess_1');
    expect(result).not.toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('analyzeToolOutput returns GuardResponseSubset on success', async () => {
    const response = makeGuardResponse();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => response }),
    );
    const client = await getClient();
    const result = await client.analyzeToolOutput('text', 'WebFetch', 'https://x.com', 'sess_1');
    expect(result).not.toBeNull();
    expect(result?.decision).toBe('ALLOWED');
  });

  it('analyzeToolOutput returns null when api_key_input is empty (no VGE call made)', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    getConfig = () => DEFAULT_CONFIG; // empty api_key_input
    const client = await getClient();
    const result = await client.analyzeToolOutput('text', 'Read', '/tmp/f', 'sess_1');
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('postUserPrompt does not throw (fire-and-forget, no await needed)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
    );
    const client = await getClient();
    // Should not throw synchronously
    expect(() => client.postUserPrompt('hello', 'sess_1')).not.toThrow();
  });

  it('vgeAgentGuard.resourceId is included in metadata', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => makeGuardResponse(),
    });
    vi.stubGlobal('fetch', mockFetch);
    const client = await getClient();
    await client.analyzeToolOutput('text', 'WebFetch', 'https://target.com/path', 'sess_1');
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, Record<string, Record<string, unknown>>>;
    expect(body['metadata']['vgeAgentGuard']['resourceId']).toBe('https://target.com/path');
  });
});
