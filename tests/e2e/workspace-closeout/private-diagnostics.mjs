import { privateACPStrictOutcome } from "../observability/private-acp-inventory.mjs";

export const workspacePrivateErrorReasons = new Set([
  "command-rejection",
  "managed-busy-rejection",
  "progress-barrier-rejection",
  "workspace-prompt-disconnect",
  "workspace-run-unresolved",
  "workspace-tool-cancelled",
  "completed-runtime-tool-http-disconnect",
  "completed-initialize-mcp-read-disconnect",
  "workspace-private-watch-local-close",
  "workspace-identity-denied-client",
  "workspace-identity-denied-server",
]);

export const workspacePrivateTraceOutcome = (reports) =>
  privateACPStrictOutcome(reports, workspacePrivateErrorReasons);
