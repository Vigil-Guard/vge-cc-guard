import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { configSchema, type Config, type ToolPolicy } from '../shared/config-schema.js';

export function getConfigPath(): string {
  const dir = process.env['VGE_CC_GUARD_CONFIG_DIR'];
  return dir
    ? path.join(dir, 'config.json')
    : path.join(os.homedir(), '.vge-cc-guard', 'config.json');
}

let currentConfig: Config | undefined;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let watcher: fs.FSWatcher | undefined;

export function loadConfig(): void {
  const raw = fs.readFileSync(getConfigPath(), 'utf-8');
  currentConfig = configSchema.parse(JSON.parse(raw));
}

export function getCurrentConfig(): Config | undefined {
  return currentConfig;
}

export function resolveToolPolicy(toolName: string): ToolPolicy {
  const tools = currentConfig?.tools ?? {};
  return tools[toolName] ?? tools['*'] ?? { gate: 'ask', analyze_output: false };
}

export function startWatcher(): void {
  const configPath = getConfigPath();
  const configDir = path.dirname(configPath);
  const configFile = path.basename(configPath);

  // Watch the directory — more reliable than watching the file directly on macOS
  // (writeFileSync may replace the inode, causing a file watcher to go silent)
  watcher = fs.watch(configDir, { persistent: false }, (_event, filename) => {
    if (filename !== configFile) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      try {
        const raw = fs.readFileSync(configPath, 'utf-8');
        currentConfig = configSchema.parse(JSON.parse(raw));
      } catch {
        console.warn('[tool-policy] Config reload failed — keeping last valid config');
      }
    }, 100);
  });
}

export function stopWatcher(): void {
  clearTimeout(debounceTimer);
  watcher?.close();
  watcher = undefined;
}
