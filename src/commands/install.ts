import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_CONFIG } from '../shared/config-schema.js';

const HOOK_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SessionStart', 'SessionEnd'] as const;
const HOOK_COMMANDS: Record<string, string> = {
  UserPromptSubmit: 'vge-cc-guard hook userprompt',
  PreToolUse: 'vge-cc-guard hook pretool',
  PostToolUse: 'vge-cc-guard hook posttool',
  SessionStart: 'vge-cc-guard hook sessionstart',
  SessionEnd: 'vge-cc-guard hook sessionend',
};

function resolveClaudeDir(scope: 'user' | 'project'): string {
  if (scope === 'project') return path.join(process.cwd(), '.claude');
  return process.env['CLAUDE_CONFIG_HOME'] ?? path.join(os.homedir(), '.claude');
}

function resolveVgeDir(): string {
  return process.env['VGE_CC_GUARD_CONFIG_DIR'] ?? path.join(os.homedir(), '.vge-cc-guard');
}

function readSettings(settingsPath: string): Record<string, unknown> {
  if (!fs.existsSync(settingsPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    throw new Error(`settings.json at ${settingsPath} is not valid JSON — aborting to avoid data loss.`);
  }
}

function isHookPresent(settings: Record<string, unknown>, event: string): boolean {
  const hooks = settings['hooks'] as Record<string, unknown[]> | undefined;
  if (!hooks?.[event]) return false;
  const entries = hooks[event] as Array<{ hooks?: Array<{ command?: string }> }>;
  return entries.some((e) => e.hooks?.some((h) => h.command?.includes('vge-cc-guard hook')));
}

function mergeHooks(settings: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...settings };
  const existingHooks = (settings['hooks'] as Record<string, unknown[]> | undefined) ?? {};
  const newHooks: Record<string, unknown[]> = { ...existingHooks };

  for (const event of HOOK_EVENTS) {
    if (isHookPresent(settings, event)) continue;
    const existing = (newHooks[event] as unknown[]) ?? [];
    newHooks[event] = [
      ...existing,
      { matcher: '*', hooks: [{ type: 'command', command: HOOK_COMMANDS[event] }] },
    ];
  }

  return { ...merged, hooks: newHooks };
}

// PR-review S2: crash-safe atomic write — fsync the file before rename so a power
// loss between rename and the next OS flush can't leave a zero-length settings.json.
function writeAtomic(filePath: string, content: string): void {
  const tmp = filePath + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}

function printDiff(current: Record<string, unknown>, updated: Record<string, unknown>): void {
  console.log('\n[dry-run] Changes that would be applied to settings.json:');
  const updatedHooks = (updated['hooks'] as Record<string, unknown[]>) ?? {};
  let hasChanges = false;
  for (const event of HOOK_EVENTS) {
    if (!isHookPresent(current, event) && updatedHooks[event]) {
      console.log(`  + ${event}: ${HOOK_COMMANDS[event]}`);
      hasChanges = true;
    }
  }
  if (!hasChanges) console.log('  (already installed — no changes needed)');
  console.log('\nRun with --apply to apply changes.\n');
}

export async function runInstall(args: string[]): Promise<void> {
  const scope: 'user' | 'project' = args.includes('--scope=project') ? 'project' : 'user';
  const dryRun = args.includes('--dry-run');
  const apply = args.includes('--apply');

  const claudeDir = resolveClaudeDir(scope);
  const settingsPath = path.join(claudeDir, 'settings.json');
  const vgeDir = resolveVgeDir();

  const currentSettings = readSettings(settingsPath);
  const updatedSettings = mergeHooks(currentSettings);

  const alreadyInstalled = HOOK_EVENTS.every((e) => isHookPresent(currentSettings, e));

  if (dryRun) {
    printDiff(currentSettings, updatedSettings);
    return;
  }

  if (!apply) {
    // Non-interactive: require --apply flag; interactive mode would prompt here (Sprint 4 TUI)
    console.log('Use --apply to apply changes or --dry-run to preview.');
    return;
  }

  if (alreadyInstalled) {
    console.log('vge-cc-guard hooks already installed. Nothing to do.');
    return;
  }

  // Create vge directories
  fs.mkdirSync(vgeDir, { recursive: true });
  fs.mkdirSync(path.join(vgeDir, 'sessions'), { recursive: true });

  // Write pre-install backup only on first install
  const backupPath = path.join(vgeDir, '.pre-install-settings.backup');
  if (!fs.existsSync(backupPath)) {
    fs.writeFileSync(backupPath, JSON.stringify(currentSettings, null, 2), 'utf-8');
  }

  // Write config.json only if not already present
  const configPath = path.join(vgeDir, 'config.json');
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8');
  }

  // Write updated settings (atomic)
  fs.mkdirSync(claudeDir, { recursive: true });
  writeAtomic(settingsPath, JSON.stringify(updatedSettings, null, 2));

  console.log(`vge-cc-guard hooks installed to ${settingsPath}`);
  console.log('Restart Claude Code to activate. Run `vge-cc-guard config` to set your API key.');
  // PR-review W5: Write/Edit ship as gate=block by design (PRD §7.5).
  // Until the TUI lands in Sprint 4, the only way to flip them to allow is
  // to edit ~/.vge-cc-guard/config.json directly. Warn explicitly.
  console.log('');
  console.log('NOTE: Write and Edit are gated as `block` by default for safety.');
  console.log('      Edit ~/.vge-cc-guard/config.json (tools.Write.gate / tools.Edit.gate)');
  console.log('      to set them to `allow` per project. TUI configurator ships in Sprint 4.');
}
