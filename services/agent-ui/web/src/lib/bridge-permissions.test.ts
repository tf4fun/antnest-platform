import assert from "node:assert/strict";
import test from "node:test";
import { BridgePermissionStore } from "./bridge-permissions.ts";

const permission = (generation: number) => ({
  permissionId: "permission-1", sessionId: "session-1", generation,
  toolCall: { toolCallId: "tool-1", title: "Read file", rawInput: { path: "notes.md" } },
  options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }],
});

test("Bridge permission decision uses current generation and offered option", async () => {
  const calls: unknown[][] = [];
  const store = new BridgePermissionStore("agent-1", {
    decidePermission: async (...args) => { calls.push(args); return {}; },
  });
  store.observe([permission(2)]);
  assert.equal(store.pending[0]?.request.toolCall.title, "Read file");
  await store.decide("permission-1", "allow");
  assert.deepEqual(calls, [["agent-1", "permission-1", 2, "allow", undefined]]);
});

test("Bridge permission decision rejects stale generation and unknown option", async () => {
  let release!: () => void;
  const store = new BridgePermissionStore("agent-1", {
    decidePermission: async () => new Promise((resolve) => { release = () => resolve({}); }),
  });
  store.observe([permission(3)]);
  await assert.rejects(store.decide("permission-1", "unknown"), /option/u);
  const prior = store.decide("permission-1", "allow");
  store.observe([permission(4)]);
  release();
  await assert.rejects(prior, /no longer current/u);
});

test("one permission generation sends one decision despite repeated clicks", async () => {
  let release!: () => void;
  let calls = 0;
  const store = new BridgePermissionStore("agent-1", {
    decidePermission: async () => { calls += 1;
      return new Promise((resolve) => { release = () => resolve({}); }); },
  });
  store.observe([permission(5)]);
  const first = store.decide("permission-1", "allow");
  const second = store.decide("permission-1", "allow");
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second]);
  await assert.rejects(store.decide("permission-1", "allow"), /already decided/u);
  assert.equal(calls, 1);
  store.observe([permission(6)]);
  const third = store.decide("permission-1", "allow");
  assert.equal(calls, 2);
  release();
  await third;
});
