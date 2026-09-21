import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertScopeDenial,
  assertReplayMetadata,
  assertExecutionBinding,
} from "./access-evidence.mjs";

for (const scope of ["principal", "Agent"]) {
  const denial = () => ({
    code: -32020,
    message: `Session belongs to another ${scope}`,
    data: { code: "session_access_denied", retryable: false },
  });
  test(`same-organization ${scope} denial requires exact error and no private data`, () => {
    assertScopeDenial(denial(), scope);
    for (const mutate of [
      (e) => {
        e.message = "Session belongs to another organization";
      },
      (e) => {
        e.code = 503;
      },
      (e) => {
        e.data.code = "access_denied";
      },
      (e) => {
        e.data.retryable = true;
      },
      (e) => {
        e.data.session_id = "private";
      },
    ]) {
      const e = denial();
      mutate(e);
      assert.throws(() => assertScopeDenial(e, scope));
    }
    assert.throws(() => assertScopeDenial(new Error("socket closed"), scope));
  });
}
test("fresh replay metadata is tied to the stored Session and rejects leaks or duplicates", () => {
  const session = {
    id: "session-a",
    title: "Private owner history",
    updated_at: "2026-09-21T00:00:00.000Z",
  };
  const update = {
    sessionId: session.id,
    update: {
      sessionUpdate: "session_info_update",
      title: session.title,
      updatedAt: session.updated_at,
    },
  };
  assertReplayMetadata([update], session);
  assert.throws(() => assertReplayMetadata([], session));
  assert.throws(() => assertReplayMetadata([update, update], session));
  assert.throws(() =>
    assertReplayMetadata([{ ...update, sessionId: "foreign" }], session),
  );
  assert.throws(() =>
    assertReplayMetadata(
      [{ ...update, update: { ...update.update, title: "foreign history" } }],
      session,
    ),
  );
  assert.throws(() =>
    assertReplayMetadata(
      [{ ...update, update: { ...update.update, secret: "private" } }],
      session,
    ),
  );
});

test("wire request and durable Run identities must both match without equating them", () => {
  const expected = { requestId: "2", runId: "run-a" };
  assertExecutionBinding({ request_id: "2", run_id: "run-a" }, expected);
  assert.throws(() =>
    assertExecutionBinding({ request_id: "other", run_id: "run-a" }, expected),
  );
  assert.throws(() =>
    assertExecutionBinding({ request_id: "2", run_id: "run-b" }, expected),
  );
  assert.throws(() => assertExecutionBinding({ request_id: "2" }, expected));
});
