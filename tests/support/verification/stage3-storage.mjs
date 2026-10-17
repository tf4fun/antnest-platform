import assert from "node:assert/strict";
import { shellStoragePreflight, temporaryStorageRoot } from "../storage.mjs";

// Check host evidence before network discovery or service setup. Profile
// compatibility remains the responsibility of e2e-stage3a.sh.
const project = process.argv[2];
temporaryStorageRoot();
assert(
  /^antnest-stage3-e2e-[0-9]+$/.test(project),
  "disposable project required",
);
const profiles = {
  MANAGED_MCP: "managed-mcp",
  RPC_RESPONSE_LOSS: "rpc-response-loss",
  ACP_PERSISTENCE: "acp-persistence",
  ACP_RESTART: "acp-restart",
  ACP_SESSION: "identity-session",
  IDENTITY_CORE: "identity-http",
  IDENTITY_ACCESS: "identity-http",
  AGENT_ACCESS: "identity-agent",
  ACP_CLOSEOUT: "acp-closeout-normal",
  TOOL_PROGRESS: "acp-progress",
  FILE_OBSERVATIONS: "acp-files",
  STRUCTURED_PLAN: "acp-plan",
  SLASH_COMMANDS: "acp-commands",
  MULTIMODAL: "acp-multimodal",
  SESSION_COST: "acp-cost",
  TOOL_PERMISSIONS: "acp-permissions",
};
let selected = false;
for (const [flag, directory] of Object.entries(profiles)) {
  if (process.env[`ANTNEST_E2E_${flag}`] !== "true") continue;
  selected = true;
  if (directory)
    shellStoragePreflight(`artifacts/verification/${directory}/${project}`);
}
if (!selected)
  shellStoragePreflight(`artifacts/verification/stage3-base/${project}`);
