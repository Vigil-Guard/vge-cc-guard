import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_CONFIG } from '../../src/shared/config-schema.js';

// runInstall / runUninstall read paths from env vars at call time, so no module resets needed.
import { runInstall } from '../../src/commands/install.js';
import { runUninstall } from '../../src/commands/uninstall.js';

const HOOK_MARKER = 'vge-cc-guard hook';

const EXPECTED_HOOK_EVENTS = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'SessionStart',
  'SessionEnd',
] as const;

let tmpHome: string;
let claudeDir: string;
let vgeDir: string;
let originalConfigDir: string | undefined;
let originalClaudeHome: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync('/tmp/vge-install-test-');
  claudeDir = path.join(tmpHome, '.claude');
  vgeDir = path.join(tmpHome, '.vge-cc-guard');
  fs.mkdirSync(claudeDir, { recursive: true });

  originalConfigDir = process.env['VGE_CC_GUARD_CONFIG_DIR'];
  originalClaudeHome = process.env['CLAUDE_CONFIG_HOME'];
  process.env['VGE_CC_GUARD_CONFIG_DIR'] = vgeDir;
  process.env['CLAUDE_CONFIG_HOME'] = claudeDir;
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env['VGE_CC_GUARD_CONFIG_DIR'];
  else process.env['VGE_CC_GUARD_CONFIG_DIR'] = originalConfigDir;

  if (originalClaudeHome === undefined) delete process.env['CLAUDE_CONFIG_HOME'];
  else process.env['CLAUDE_CONFIG_HOME'] = originalClaudeHome;

  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function readSettings(): Record<string, unknown> {
  const p = path.join(claudeDir, 'settings.json');
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>;
}

function countHookEntries(settings: Record<string, unknown>): number {
  const hooks = settings['hooks'] as Record<string, unknown[]> | undefined;
  if (!hooks) return 0;
  return Object.values(hooks)
    .flat()
    .filter((entry) => {
      const e = entry as { hooks?: Array<{ command?: string }> };
      return e.hooks?.some((h) => h.command?.includes(HOOK_MARKER));
    }).length;
}

describe('install', () => {
  it('E1: creates settings.json with all 5 hook entries', async () => {
    await runInstall(['--apply', '--scope=user']);
    const settings = readSettings();
    const hooks = settings['hooks'] as Record<string, unknown[]>;
    expect(hooks).toBeDefined();
    for (const event of EXPECTED_HOOK_EVENTS) {
      expect(hooks[event]).toBeDefined();
      const entry = (hooks[event] as Array<{ hooks: Array<{ command: string }> }>)[0];
      expect(entry?.hooks[0]?.command).toContain(HOOK_MARKER);
    }
  });

  it('E2: creates ~/.vge-cc-guard/config.json with DEFAULT_CONFIG', async () => {
    await runInstall(['--apply', '--scope=user']);
    const cfgPath = path.join(vgeDir, 'config.json');
    expect(fs.existsSync(cfgPath)).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as Record<string, unknown>;
    expect(cfg['version']).toBe(DEFAULT_CONFIG.version);
  });

  it('E3: creates ~/.vge-cc-guard/sessions/ directory', async () => {
    await runInstall(['--apply', '--scope=user']);
    expect(fs.existsSync(path.join(vgeDir, 'sessions'))).toBe(true);
    expect(fs.statSync(path.join(vgeDir, 'sessions')).isDirectory()).toBe(true);
  });

  it('E4: creates pre-install backup of settings.json', async () => {
    await runInstall(['--apply', '--scope=user']);
    expect(fs.existsSync(path.join(vgeDir, '.pre-install-settings.backup'))).toBe(true);
  });

  it('E5: install × 2 does not duplicate hook entries (idempotent)', async () => {
    await runInstall(['--apply', '--scope=user']);
    await runInstall(['--apply', '--scope=user']);
    expect(countHookEntries(readSettings())).toBe(5);
  });

  it('E6: --dry-run prints diff but does not write any files', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await runInstall(['--dry-run', '--scope=user']);
    } finally {
      consoleSpy.mockRestore();
    }
    expect(fs.existsSync(path.join(claudeDir, 'settings.json'))).toBe(false);
    expect(fs.existsSync(vgeDir)).toBe(false);
  });

  it('E11: second install does NOT overwrite pre-install backup', async () => {
    await runInstall(['--apply', '--scope=user']);
    const backupPath = path.join(vgeDir, '.pre-install-settings.backup');
    const firstBackup = fs.readFileSync(backupPath, 'utf-8');
    await runInstall(['--apply', '--scope=user']);
    expect(fs.readFileSync(backupPath, 'utf-8')).toBe(firstBackup);
  });

  it('E12: existing non-vge hooks are preserved after install', async () => {
    const existing = {
      hooks: {
        PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'other-tool hook' }] }],
      },
    };
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify(existing));
    await runInstall(['--apply', '--scope=user']);
    const settings = readSettings();
    const preTool = settings['hooks'] as Record<string, unknown[]>;
    const preToolEntries = preTool['PreToolUse'] as Array<{ hooks: Array<{ command: string }> }>;
    const commands = preToolEntries.flatMap((e) => e.hooks.map((h) => h.command));
    expect(commands).toContain('other-tool hook');
    expect(commands.some((c) => c.includes(HOOK_MARKER))).toBe(true);
  });

  it('E13: --scope=project writes to ./.claude/settings.json (CWD)', async () => {
    const origCwd = process.cwd();
    process.chdir(tmpHome);
    try {
      await runInstall(['--apply', '--scope=project']);
    } finally {
      process.chdir(origCwd);
    }
    const projectSettings = path.join(tmpHome, '.claude', 'settings.json');
    expect(fs.existsSync(projectSettings)).toBe(true);
    const s = JSON.parse(fs.readFileSync(projectSettings, 'utf-8')) as Record<string, unknown>;
    expect(countHookEntries(s)).toBe(5);
  });
});

describe('uninstall', () => {
  it('E7: uninstall restores settings.json from backup', async () => {
    const original = { myProp: 'preserved' };
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify(original));
    await runInstall(['--apply', '--scope=user']);
    await runUninstall(['--yes']);
    const restored = readSettings();
    expect(restored['myProp']).toBe('preserved');
    expect(countHookEntries(restored)).toBe(0);
  });

  it('E8: uninstall removes ~/.vge-cc-guard/', async () => {
    await runInstall(['--apply', '--scope=user']);
    await runUninstall(['--yes']);
    expect(fs.existsSync(vgeDir)).toBe(false);
  });

  it('E9: uninstall × 2 exits cleanly (idempotent)', async () => {
    await runInstall(['--apply', '--scope=user']);
    await runUninstall(['--yes']);
    await expect(runUninstall(['--yes'])).resolves.toBeUndefined();
  });

  it('E10: uninstall without backup removes only vge-cc-guard hooks, preserves others', async () => {
    const withOtherHooks = {
      hooks: {
        PreToolUse: [
          { matcher: '*', hooks: [{ type: 'command', command: 'other-tool hook' }] },
          { matcher: '*', hooks: [{ type: 'command', command: 'vge-cc-guard hook pretool' }] },
        ],
      },
    };
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify(withOtherHooks));
    // No install → no backup; create vgeDir manually to make uninstall think it's installed
    fs.mkdirSync(vgeDir, { recursive: true });

    await runUninstall(['--yes']);

    const settings = readSettings();
    const hooks = settings['hooks'] as Record<string, unknown[]>;
    const preTool = hooks?.['PreToolUse'] as Array<{ hooks: Array<{ command: string }> }>;
    const commands = (preTool ?? []).flatMap((e) => e.hooks.map((h) => h.command));
    expect(commands).toContain('other-tool hook');
    expect(commands.some((c) => c.includes(HOOK_MARKER))).toBe(false);
  });
});
