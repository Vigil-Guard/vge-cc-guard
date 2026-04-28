import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function resolveVgeDir(): string {
  return process.env['VGE_CC_GUARD_CONFIG_DIR'] ?? path.join(os.homedir(), '.vge-cc-guard');
}

function resolveClaudeSettingsPath(): string {
  const claudeDir =
    process.env['CLAUDE_CONFIG_HOME'] ?? path.join(os.homedir(), '.claude');
  return path.join(claudeDir, 'settings.json');
}

function removeVgeHooks(settings: Record<string, unknown>): Record<string, unknown> {
  const hooks = settings['hooks'] as Record<string, unknown[]> | undefined;
  if (!hooks) return settings;

  const filtered: Record<string, unknown[]> = {};
  for (const [event, entries] of Object.entries(hooks)) {
    const kept = (entries as Array<{ hooks?: Array<{ command?: string }> }>).filter(
      (e) => !e.hooks?.some((h) => h.command?.includes('vge-cc-guard hook')),
    );
    if (kept.length > 0) filtered[event] = kept;
  }

  return { ...settings, hooks: filtered };
}

// PR-review S2: crash-safe atomic write — see install.ts for rationale.
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

export async function runUninstall(args: string[]): Promise<void> {
  const vgeDir = resolveVgeDir();
  const settingsPath = resolveClaudeSettingsPath();

  if (!fs.existsSync(vgeDir)) {
    console.log('vge-cc-guard is not installed. Nothing to do.');
    return;
  }

  if (!args.includes('--yes')) {
    // In Sprint 4, this will be an interactive prompt.
    // For now, require --yes for non-interactive uninstall.
    console.error('Use --yes to confirm uninstall, or run interactively (Sprint 4).');
    process.exit(1);
  }

  const backupPath = path.join(vgeDir, '.pre-install-settings.backup');

  if (fs.existsSync(backupPath)) {
    // PR-review W2: warn that backup-restore overwrites any settings the user
    // added after install. Sprint 4 TUI will offer hook-filter as the default.
    console.log('NOTE: restoring pre-install settings.json — any settings you added');
    console.log('      after the initial install will be replaced by the snapshot.');
    const backup = fs.readFileSync(backupPath, 'utf-8');
    const claudeDir = path.dirname(settingsPath);
    fs.mkdirSync(claudeDir, { recursive: true });
    writeAtomic(settingsPath, backup);
  } else if (fs.existsSync(settingsPath)) {
    let current: Record<string, unknown>;
    try {
      current = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      current = {};
    }
    const cleaned = removeVgeHooks(current);
    writeAtomic(settingsPath, JSON.stringify(cleaned, null, 2));
  }

  fs.rmSync(vgeDir, { recursive: true, force: true });
  console.log('Uninstall complete. Restart Claude Code to apply.');
}
