import assert from "node:assert/strict";
import { test } from "node:test";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
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
