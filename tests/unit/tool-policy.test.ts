import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_CONFIG } from '../../src/shared/config-schema.js';

describe('tool-policy', () => {
  let tmpDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vge-policy-test-'));
    originalEnv = process.env['VGE_CC_GUARD_CONFIG_DIR'];
    process.env['VGE_CC_GUARD_CONFIG_DIR'] = tmpDir;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env['VGE_CC_GUARD_CONFIG_DIR'];
    } else {
      process.env['VGE_CC_GUARD_CONFIG_DIR'] = originalEnv;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeConfig(cfg: object) {
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify(cfg));
  }

  it('returns correct policy for known tool (Bash → allow + analyze_output=true)', async () => {
    writeConfig(DEFAULT_CONFIG);
    const { loadConfig, resolveToolPolicy } = await import('../../src/daemon/tool-policy.js');
    loadConfig();
    expect(resolveToolPolicy('Bash')).toEqual({ gate: 'allow', analyze_output: true });
  });

  it('falls back to * for unknown tool', async () => {
    writeConfig(DEFAULT_CONFIG);
    const { loadConfig, resolveToolPolicy } = await import('../../src/daemon/tool-policy.js');
    loadConfig();
    expect(resolveToolPolicy('SomeUnknownTool')).toEqual({ gate: 'ask', analyze_output: false });
  });

  it('falls back to ask+false when * is absent', async () => {
    const cfg = { ...DEFAULT_CONFIG, tools: { Bash: { gate: 'allow', analyze_output: true } } };
    writeConfig(cfg);
    const { loadConfig, resolveToolPolicy } = await import('../../src/daemon/tool-policy.js');
    loadConfig();
    expect(resolveToolPolicy('SomeUnknownTool')).toEqual({ gate: 'ask', analyze_output: false });
  });

  it('rejects invalid config file and keeps last-valid config', async () => {
    writeConfig(DEFAULT_CONFIG);
    const { loadConfig, resolveToolPolicy, startWatcher, stopWatcher } = await import(
      '../../src/daemon/tool-policy.js'
    );
    loadConfig();
    startWatcher();

    fs.writeFileSync(path.join(tmpDir, 'config.json'), '{ "version": "99.0.0" }');

    await vi.waitFor(
      () => {
        expect(resolveToolPolicy('Bash')).toEqual({ gate: 'allow', analyze_output: true });
      },
      { timeout: 500 },
    );

    stopWatcher();
  });

  it('hot-reload: detects config change and updates policy', async () => {
    writeConfig(DEFAULT_CONFIG);
    const { loadConfig, resolveToolPolicy, startWatcher, stopWatcher } = await import(
      '../../src/daemon/tool-policy.js'
    );
    loadConfig();
    startWatcher();

    const updated = {
      ...DEFAULT_CONFIG,
      tools: { ...DEFAULT_CONFIG.tools, Bash: { gate: 'block', analyze_output: false } },
    };
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify(updated));

    await vi.waitFor(
      () => {
        expect(resolveToolPolicy('Bash')).toEqual({ gate: 'block', analyze_output: false });
      },
      { timeout: 1000 },
    );

    stopWatcher();
  });

  it('VGE_CC_GUARD_CONFIG_DIR overrides the config path', async () => {
    const altDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vge-alt-'));
    try {
      const altCfg = {
        ...DEFAULT_CONFIG,
        tools: { ...DEFAULT_CONFIG.tools, Read: { gate: 'block', analyze_output: false } },
      };
      fs.writeFileSync(path.join(altDir, 'config.json'), JSON.stringify(altCfg));
      process.env['VGE_CC_GUARD_CONFIG_DIR'] = altDir;

      const { loadConfig, resolveToolPolicy } = await import('../../src/daemon/tool-policy.js');
      loadConfig();
      expect(resolveToolPolicy('Read')).toEqual({ gate: 'block', analyze_output: false });
    } finally {
      fs.rmSync(altDir, { recursive: true, force: true });
    }
  });
});
