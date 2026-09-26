import assert from "node:assert/strict";
import { assertV2PromptAcknowledged } from "../../support/acp-v2-prompt.mjs";
import {
  assertPromptComplete,
  assertStillRunning,
} from "../managed-mcp/protocol.mjs";
// v2 observes durable output independently of the executor's COMMIT receipt.
// A committed terminal notification is valid, but cannot free the active slot.
export function assertHeldCompletion({
  version,
  resolved,
  response,
  updates,
  phase,
  sessionId,
  availability,
}) {
  assert.equal(
    availability,
    "busy",
    "executor advanced beyond held persistence",
  );
  if (version === 1) {
    assert.equal(resolved, false);
    return false;
  }
  assertV2PromptAcknowledged(response, updates, sessionId);
  if (
    updates.some(
      (u) =>
        u.update.sessionUpdate === "state_update" && u.update.state === "idle",
    )
  ) {
    assertPromptComplete(version, response, updates, phase, sessionId);
    return true;
  }
  assertStillRunning(version, updates, sessionId);
  return false;
}
