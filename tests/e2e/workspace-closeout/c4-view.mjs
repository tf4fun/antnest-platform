import assert from "node:assert/strict";
import { gatewayBrowserRequest } from "../../support/gateway-browser-request.mjs";
import { validAgentView } from "../../../services/agent-ui/web/server/src/protocol/agent-view-delta.ts";

export async function readC4View(
  context,
  { gateway, agentId, sessionId = null, frames = [] },
) {
  assert(typeof agentId === "string" && agentId.length > 0);
  assert(
    sessionId === null ||
      (typeof sessionId === "string" && sessionId.length > 0),
  );
  const url = new URL(
    `/api/app/workspace/v1/agents/${encodeURIComponent(agentId)}/view`,
    gateway,
  );
  if (sessionId !== null) url.searchParams.set("sessionId", sessionId);
  const response = await gatewayBrowserRequest(context, url.href);
  assert.equal(response.status(), 200);
  const body = await response.json();
  frames.push(JSON.stringify(body));
  assert(validAgentView(body), "invalid complete C4 Bridge view");
  assert.equal(body.agentId, agentId, "foreign C4 Bridge Agent");
  assert.equal(
    body.selectedSessionId,
    sessionId,
    "foreign C4 Bridge selected Session",
  );
  return body;
}
