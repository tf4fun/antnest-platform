import assert from "node:assert/strict";
import { validAgentView } from "../../../services/agent-ui/web/server/src/protocol/agent-view-delta.ts";
import { assertState } from "./evidence.mjs";

export function c4RebuildReady(before, after, view, agentId, sessionId) {
  assert(
    typeof sessionId === "string" && sessionId.trim().length > 0,
    "original C4 Session required before Rebuild",
  );
  assertState(before, agentId);
  assertState(after, agentId);
  assert.equal(before.access_allowed, true);
  assert.equal(before.availability, "ready");
  assert.equal(
    after.access_allowed,
    true,
    "C4 member lost access during Rebuild",
  );
  assert(validAgentView(view), "invalid complete C4 Rebuild Bridge view");
  assert.equal(view.agentId, agentId, "foreign C4 Rebuild Bridge Agent");
  assert.equal(
    view.selectedSessionId,
    sessionId,
    "foreign C4 Rebuild Bridge Session",
  );
  return (
    after.configuration_revision !== before.configuration_revision &&
    after.availability === "ready" &&
    after.active_session_id === null &&
    view.availability === "ready" &&
    view.activeSessionId === null
  );
}
