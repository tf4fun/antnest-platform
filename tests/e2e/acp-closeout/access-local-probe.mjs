import assert from "node:assert/strict";
import { inspect } from "node:util";

// A local safety probe follows the separately proved remote browser closure and
// joined private connection. It is never recorded as a new business/wire request.
export async function probeClosedPrompt(raw, recorder, sessionId) {
  const before = recorder.snapshot();
  assert.equal(
    before.closed,
    true,
    "local probe requires a joined private connection",
  );
  const method = "prompt",
    params = { sessionId, prompt: [{ type: "text", text: "revoked-owner" }] };
  let rejected = false,
    failure;
  try {
    await raw.request(method, params);
  } catch (error) {
    rejected = true;
    failure = inspect(error, { depth: 8 });
  }
  const after = recorder.snapshot();
  assert(rejected, "closed private connection accepted a prompt");
  assert.deepEqual(
    after,
    before,
    "local post-close probe changed original wire inventory",
  );
  return {
    connectionTraceID: before.connectionTraceID,
    method,
    params,
    outcome: "rejected",
    failure,
    before,
    after,
  };
}
