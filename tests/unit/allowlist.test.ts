import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import { canonicalizeKey } from '../../src/daemon/allowlist.js';

describe('allowlist', () => {
  it('WebFetch: fragment stripped, URL preserved', () => {
    const key = canonicalizeKey('WebFetch', { url: 'https://example.com/blog/post#section' });
    expect(key).toBe('WebFetch:https://example.com/blog/post');
  });

  it('Bash: sha256 hash of normalized command', () => {
    const key1 = canonicalizeKey('Bash', { command: 'ls   -la' });
    const key2 = canonicalizeKey('Bash', { command: 'ls -la' });
    expect(key1).toBe(key2);
    expect(key1).toMatch(/^bash:[a-f0-9]{12}$/);
  });

  it('Read: tilde expanded, path resolved to absolute', () => {
    const key = canonicalizeKey('Read', { file_path: '~/project/src/main.ts' });
    const expected = `Read:${path.join(os.homedir(), 'project/src/main.ts')}`;
    expect(key).toBe(expected);
  });

  it('Edit: path + sha256(old_string) prefix', () => {
    const key = canonicalizeKey('Edit', { file_path: '/tmp/foo.ts', old_string: 'const x = 1' });
    expect(key).toMatch(/^\/tmp\/foo\.ts:edit:[a-f0-9]{12}$/);
  });

  it('unknown tool: falls through to generic sha256 case', () => {
    const key = canonicalizeKey('MyCustomTool', { foo: 'bar' });
    expect(key).toMatch(/^MyCustomTool:[a-f0-9]{12}$/);
  });

  it('two different WebFetch URLs produce different keys', () => {
    const k1 = canonicalizeKey('WebFetch', { url: 'https://a.com/' });
    const k2 = canonicalizeKey('WebFetch', { url: 'https://b.com/' });
    expect(k1).not.toBe(k2);
  });

  it('same WebFetch URL produces same key regardless of timing', () => {
    const k1 = canonicalizeKey('WebFetch', { url: 'https://example.com/page' });
    const k2 = canonicalizeKey('WebFetch', { url: 'https://example.com/page' });
    expect(k1).toBe(k2);
  });

  it('volatile fields (timestamp, requestId) stripped from generic hash input', () => {
    const k1 = canonicalizeKey('Custom', { action: 'run', timestamp: 111 });
    const k2 = canonicalizeKey('Custom', { action: 'run', timestamp: 999 });
    expect(k1).toBe(k2);
  });
});
