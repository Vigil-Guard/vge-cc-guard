#!/usr/bin/env node

const command = process.argv[2];

const usage = `
vge-cc-guard <command>

Commands:
  install        Register hooks in Claude Code settings
  uninstall      Remove hooks and delete ~/.vge-cc-guard/
  config         Open TUI configurator
  hook <event>   Handle a Claude Code hook event (called by CC, not the user)
  daemon         Start the daemon in foreground (development)
  reset-session  Clear allowlist and pending escalations for active session
`.trim();

switch (command) {
  case 'install':
  case 'uninstall':
  case 'config':
  case 'hook':
  case 'daemon':
  case 'reset-session':
    console.log(`[stub] ${command} — not yet implemented`);
    break;
  default:
    console.log(usage);
    process.exit(command === '--help' || command === '-h' ? 0 : 1);
}
