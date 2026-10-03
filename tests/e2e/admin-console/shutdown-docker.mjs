// Real Console image, authenticated dependencies, SIGTERM/SIGINT and restart.
import { runConsoleAcceptance } from "../service-authentication/console/run.mjs";
await runConsoleAcceptance({
  authentication: false,
  preparation: false,
  shutdown: true,
});
