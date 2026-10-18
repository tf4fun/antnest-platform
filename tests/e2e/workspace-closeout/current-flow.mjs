import { runPrivateWorkspace } from "./private-flow.mjs";
import { workspaceProtocolBusiness } from "./protocol-business.mjs";

export function workspaceProtocol(input, overrides = {}) {
  return runPrivateWorkspace(input, workspaceProtocolBusiness, overrides);
}
