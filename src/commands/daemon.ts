import { startDaemon } from '../daemon/http-server.js';

startDaemon().catch((err: unknown) => {
  process.stderr.write(`Daemon failed to start: ${String(err)}\n`);
  process.exit(1);
});
