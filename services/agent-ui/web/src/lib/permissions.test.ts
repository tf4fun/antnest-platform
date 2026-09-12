import assert from "node:assert/strict";
import test from "node:test";
import { PermissionInbox } from "./permissions.ts";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";

const request: RequestPermissionRequest = { sessionId: "s1", toolCall: { toolCallId: "t1", title: "Write file", rawInput: { path: "notes.txt" } },
  options: [{ optionId: "yes", name: "Allow once", kind: "allow_once" }, { optionId: "no", name: "Reject once", kind: "reject_once" }] };

test("permission decisions require an active request and offered option", async () => {
  const inbox = new PermissionInbox(() => {});
  const wait = inbox.request(request, new AbortController().signal);
  const pending = inbox.pending[0]!;
  assert.deepEqual(pending.request, request);
  assert.equal(inbox.answer(pending.id, "invented"), false);
  assert.equal(inbox.answer(pending.id, "yes"), true);
  assert.deepEqual(await wait, { outcome: {outcome: "selected", optionId: "yes"} });
  assert.equal(inbox.answer(pending.id, "yes"), false);
  assert.equal(inbox.pending.length, 0);
});
test("cancellation removes stale controls; reissued calls get independent identities", async () => {
  const inbox = new PermissionInbox(() => {});
  const signal = new AbortController();
  const old = inbox.request(request, signal.signal);
  const oldID = inbox.pending[0]!.id;
  signal.abort();
  assert.deepEqual(await old, {outcome: {outcome: "cancelled"}});
  const next = inbox.request(request, new AbortController().signal);
  assert.notEqual(inbox.pending[0]!.id, oldID);
  assert.equal(inbox.answer(oldID, "yes"), false);
  inbox.clear();
  assert.deepEqual(await next, {outcome: {outcome: "cancelled"}});
});
test("connection cleanup clears all Sessions and already cancelled requests never appear", async () => {
  const updates: number[] = [];
  const inbox = new PermissionInbox((items) => updates.push(items.length));
  const first = inbox.request(request, new AbortController().signal);
  const second = inbox.request({...request, sessionId: "s2"}, new AbortController().signal);
  inbox.clear();
  assert.deepEqual(await Promise.all([first, second]), Array(2).fill({outcome: {outcome: "cancelled"}}));
  assert.equal(inbox.pending.length, 0);
  const signal = AbortSignal.abort();
  await inbox.request(request, signal);
  assert.equal(updates.at(-1), 0);
});
