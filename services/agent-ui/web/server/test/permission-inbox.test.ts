import assert from "node:assert/strict";
import { test } from "node:test";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk/unstable";
import {
  PermissionInbox,
  PermissionDecisionError,
} from "../src/bridge/permission-inbox.ts";

const request: RequestPermissionRequest = {
  sessionId: "session-1",
  toolCall: {
    toolCallId: "tool-1",
    title: "Edit file",
    rawInput: { path: "notes.txt" },
  },
  options: [
    { optionId: "once", name: "Allow once", kind: "allow_once" },
    { optionId: "no", name: "Reject", kind: "reject_once" },
  ],
};

test("permission stays pending without observers and selected ACP option resolves once", async () => {
  const changes: number[] = [];
  let released = 0;
  const inbox = new PermissionInbox({
    changed: (items) => changes.push(items.length),
    retainWork: () => () => {
      released += 1;
    },
  });
  const pending = inbox.request(request, new AbortController().signal);
  const [item] = inbox.pending;
  assert.equal(item?.sessionId, "session-1");
  assert.equal(item?.toolCall.toolCallId, "tool-1");
  assert.equal(inbox.pending.length, 1);
  inbox.decide(item!.permissionId, item!.generation, "once");
  assert.deepEqual(await pending, {
    outcome: { outcome: "selected", optionId: "once" },
  });
  assert.deepEqual(changes, [1, 0]);
  assert.equal(released, 1);
  assert.equal(inbox.pending.length, 0);
});

test("stale generation and unadvertised option never resolve a newer request", async () => {
  const inbox = new PermissionInbox({
    changed: () => {},
    retainWork: () => () => {},
  });
  const first = inbox.request(request, new AbortController().signal);
  const old = inbox.pending[0]!;
  assert.throws(
    () => inbox.decide(old.permissionId, old.generation, "unknown"),
    PermissionDecisionError,
  );
  inbox.decide(old.permissionId, old.generation, "no");
  await first;
  const second = inbox.request(request, new AbortController().signal);
  const current = inbox.pending[0]!;
  assert.ok(current.generation > old.generation);
  assert.throws(
    () => inbox.decide(current.permissionId, old.generation, "once"),
    PermissionDecisionError,
  );
  assert.equal(inbox.pending.length, 1);
  inbox.decide(current.permissionId, current.generation, "once");
  await second;
});

test("ACP abort withdraws permission and settles work without choosing a default", async () => {
  let released = 0;
  const inbox = new PermissionInbox({
    changed: () => {},
    retainWork: () => () => {
      released += 1;
    },
  });
  const controller = new AbortController();
  const pending = inbox.request(request, controller.signal);
  controller.abort();
  assert.deepEqual(await pending, { outcome: { outcome: "cancelled" } });
  assert.deepEqual(inbox.pending, []);
  assert.equal(released, 1);
});

test("oversized tool input is omitted from browser projection without cancelling ACP request", async () => {
  const inbox = new PermissionInbox({
    changed: () => {},
    retainWork: () => () => {},
  });
  const pending = inbox.request(
    {
      ...request,
      toolCall: {
        ...request.toolCall,
        rawInput: { data: "x".repeat(300_000) },
      },
    },
    new AbortController().signal,
  );
  assert.equal(inbox.pending[0]?.toolCall.rawInput, undefined);
  const item = inbox.pending[0]!;
  inbox.decide(item.permissionId, item.generation, "no");
  assert.deepEqual(await pending, {
    outcome: { outcome: "selected", optionId: "no" },
  });
});

const requestMeta = (runId: string, toolCallId = "tool-1") => ({
  "antnest.dev/permission-request": { version: 1, runId, toolCallId },
});
const correlated = (runId: string, overrides = {}) => ({
  ...request,
  _meta: requestMeta(runId),
  ...overrides,
});
const notice = (overrides = {}) => ({
  version: 1,
  runId: "run-1",
  toolCallId: "tool-1",
  reason: "permission_resolved",
  ...overrides,
});

test("permission resolution notice withdraws the matching pending request once", async () => {
  const changes: number[] = [];
  let released = 0;
  const inbox = new PermissionInbox({
    changed: (items) => changes.push(items.length),
    retainWork: () => () => {
      released += 1;
    },
  });
  const pending = inbox.request(correlated("run-1"), new AbortController().signal);
  assert.equal(inbox.pending.length, 1);
  inbox.resolve("session-1", notice());
  assert.equal(inbox.pending.length, 0);
  assert.equal(released, 1);
  assert.deepEqual(await pending, { outcome: { outcome: "cancelled" } });
  inbox.resolve("session-1", notice());
  assert.equal(released, 1);
  assert.deepEqual(changes, [1, 0]);
});

test("resolution notice cannot choose an outcome and leaves unrelated or legacy requests", async () => {
  const inbox = new PermissionInbox({
    changed: () => {},
    retainWork: () => () => {},
  });
  const matching = inbox.request(correlated("run-1"), new AbortController().signal);
  const legacy = inbox.request(request, new AbortController().signal);
  const otherSession = inbox.request(
    correlated("run-1", { sessionId: "session-2" }),
    new AbortController().signal,
  );
  for (const payload of [
    notice(),
    notice({ reason: "permission_timeout" }),
  ]) {
    inbox.resolve("other-session", payload);
  }
  assert.equal(inbox.pending.length, 3);
  for (const payload of [
    undefined,
    "notice",
    {},
    notice({ version: 2 }),
    notice({ version: "1" }),
    notice({ runId: 3 }),
    notice({ runId: "" }),
    notice({ runId: "x".repeat(201) }),
    notice({ toolCallId: "" }),
    notice({ toolCallId: "y".repeat(201) }),
    notice({ reason: "permission_cancelled" }),
    notice({ reason: 2 }),
    { ...notice(), extra: true },
    (({ runId: _runId, ...rest }) => rest)(notice()),
    notice({ runId: "run-2" }),
    notice({ toolCallId: "tool-2" }),
  ]) {
    inbox.resolve("session-1", payload);
  }
  assert.equal(inbox.pending.length, 3);
  inbox.resolve("session-1", notice());
  assert.deepEqual(await matching, { outcome: { outcome: "cancelled" } });
  assert.equal(inbox.pending.length, 2);
  inbox.resolve("session-2", notice({ reason: "permission_timeout" }));
  assert.deepEqual(await otherSession, { outcome: { outcome: "cancelled" } });
  assert.equal(inbox.pending.length, 1);
  const controller = new AbortController();
  const stale = inbox.request(request, controller.signal);
  inbox.resolve("session-1", notice());
  assert.equal(inbox.pending.length, 2);
  controller.abort();
  assert.deepEqual(await stale, { outcome: { outcome: "cancelled" } });
  inbox.clear();
  assert.deepEqual(await legacy, { outcome: { outcome: "cancelled" } });
});

test("an older run notice cannot withdraw a newer request for the same tool call", async () => {
  const inbox = new PermissionInbox({
    changed: () => {},
    retainWork: () => () => {},
  });
  const pending = inbox.request(correlated("run-2"), new AbortController().signal);
  inbox.resolve("session-1", notice({ runId: "run-1" }));
  assert.equal(inbox.pending.length, 1);
  inbox.resolve("session-1", notice({ runId: "run-2" }));
  assert.deepEqual(await pending, { outcome: { outcome: "cancelled" } });
});

test("untrusted request metadata is not stored as correlation", async () => {
  const inbox = new PermissionInbox({
    changed: () => {},
    retainWork: () => () => {},
  });
  for (const meta of [
    { "antnest.dev/permission-request": { version: 1, runId: "run-1", toolCallId: "other" } },
    { "antnest.dev/permission-request": { version: 2, runId: "run-1", toolCallId: "tool-1" } },
    { "antnest.dev/permission-request": { runId: "run-1", toolCallId: "tool-1" } },
    { "antnest.dev/permission-request": "run-1" },
  ]) {
    const pending = inbox.request(
      { ...request, _meta: meta } as RequestPermissionRequest,
      new AbortController().signal,
    );
    void pending;
    inbox.resolve("session-1", notice());
    assert.equal(inbox.pending.length, 1);
    inbox.clear();
    assert.equal(inbox.pending.length, 0);
  }
});
