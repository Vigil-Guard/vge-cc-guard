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
  case 'hook': {
    const { main } = await import('./shim/index.js');
    await main();
    break;
  }
  case 'daemon': {
    const { startDaemon } = await import('./daemon/http-server.js');
    await startDaemon();
    break;
  }
  case 'install': {
    const { runInstall } = await import('./commands/install.js');
    await runInstall(process.argv.slice(3));
    break;
  }
  case 'uninstall': {
    const { runUninstall } = await import('./commands/uninstall.js');
    await runUninstall(process.argv.slice(3));
    break;
  }
  case 'reset-session': {
    const { runResetSession } = await import('./commands/reset-session.js');
    await runResetSession();
    break;
  }
  case 'config':
    console.log('[stub] config — not yet implemented (Sprint 4)');
    break;
  default:
    console.log(usage);
    process.exit(command === '--help' || command === '-h' ? 0 : 1);
}
