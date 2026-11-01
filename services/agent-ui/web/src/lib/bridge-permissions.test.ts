import assert from "node:assert/strict";
import test from "node:test";
import { BridgePermissionStore } from "./bridge-permissions.ts";
import { WorkspaceApiError } from "./workspace-api-client.ts";

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

test("a stale decision removes only the same observed generation and reports the failure", async () => {
  const store = new BridgePermissionStore("agent-1", {
    decidePermission: async () => {
      throw new WorkspaceApiError("Permission request is no longer current", 409, "permission_stale", "refresh");
    },
  });
  store.observe([permission(3)]);
  await assert.rejects(store.decide("permission-1", "allow"), /no longer current/u);
  assert.equal(store.pending.length, 0);
});

test("a stale decision in flight cannot remove a newer observed generation", async () => {
  let release!: (error: unknown) => void;
  const store = new BridgePermissionStore("agent-1", {
    decidePermission: async () =>
      new Promise((_resolve, reject) => {
        release = reject;
      }),
  });
  store.observe([permission(3)]);
  const stale = store.decide("permission-1", "allow");
  store.observe([permission(4)]);
  release(new WorkspaceApiError("Permission request is no longer current", 409, "permission_stale", "refresh"));
  await assert.rejects(stale, /no longer current/u);
  assert.equal(store.pending.length, 1);
  assert.equal(store.pending[0]?.request.options[0]?.optionId, "allow");
});

test("an unrelated decision failure keeps the pending request observed", async () => {
  const store = new BridgePermissionStore("agent-1", {
    decidePermission: async () => {
      throw new WorkspaceApiError("Workspace is unavailable", 503, "upstream_unavailable", "retry_read");
    },
  });
  store.observe([permission(3)]);
  await assert.rejects(store.decide("permission-1", "allow"));
  assert.equal(store.pending.length, 1);
});
