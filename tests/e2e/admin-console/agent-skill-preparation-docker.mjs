// Preserve lifecycle progress, organization isolation and DTO redaction checks.
import { runConsoleAcceptance } from "../service-authentication/console/run.mjs";
await runConsoleAcceptance({
  authentication: false,
  preparation: true,
  shutdown: false,
});
