import assert from "node:assert/strict";
import test from "node:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { applySessionUpdate, resetConversationReplay } from "./acp-state.ts";
import { formatSessionCost } from "./usage.ts";
import type { Conversation } from "./types.ts";

const base: Conversation = { id: "s1", agentId: "a1", title: "Chat", updatedAt: "2026-09-09T00:00:00Z", messages: [] };
const update = (cost?: unknown, used = 100, size = 1000) => ({ sessionUpdate: "usage_update", used, size, cost }) as SessionUpdate;

test("usage snapshots replace cumulative cost, including duplicates and lower authoritative values", () => {
  let state = base;
  for (const amount of [0.01, 0.03, 0.03, 0.02]) {
    state = applySessionUpdate(state, update({ amount, currency: "USD", _meta: { private: "secret" } }));
    assert.deepEqual(state.usage, { used: 100, size: 1000, cost: { amount, currency: "USD" } });
    assert.equal(state.updatedAt, base.updatedAt);
    assert.deepEqual(state.messages, []);
  }
  assert.equal(base.usage, undefined);
});

test("unknown, context-only and explicit zero costs remain distinct", () => {
  for (const absent of [undefined, null]) {
    assert.deepEqual(applySessionUpdate(base, update(absent)).usage, { used: 100, size: 1000 });
    const paid = applySessionUpdate(base, update({ amount: 0.01, currency: "USD" }));
    assert.deepEqual(applySessionUpdate(paid, update(absent, 20, 2000)).usage, { used: 20, size: 2000, cost: { amount: 0.01, currency: "USD" } });
  }
  assert.deepEqual(applySessionUpdate(base, update({ amount: 0, currency: "USD" })).usage?.cost, { amount: 0, currency: "USD" });
});

test("usage projection rejects invalid counters and strips invalid costs without inventing free usage", () => {
  const paid = applySessionUpdate(base, update({ amount: 0.01, currency: "USD" }));
  for (const value of [-1, Infinity, NaN, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(applySessionUpdate(paid, update(undefined, value)), paid);
    assert.equal(applySessionUpdate(paid, update(undefined, 100, value)), paid);
  }
  assert.deepEqual(applySessionUpdate(base, update({ amount: 0.03, currency: "USD" }, 0, 0)).usage,
    { used: 0, size: 0, cost: { amount: 0.03, currency: "USD" } });
  for (const cost of [{ amount: -1, currency: "USD" }, { amount: Infinity, currency: "USD" },
    { amount: NaN, currency: "USD" }, { amount: "0", currency: "USD" }, { amount: 1 },
    { amount: 1, currency: "<script>" }, { amount: 1, currency: "usd" }, { amount: 1, currency: "USD\n" }]) {
    assert.deepEqual(applySessionUpdate(paid, update(cost, 200)).usage, { ...paid.usage, used: 200 });
    assert.equal(applySessionUpdate(base, update(cost)).usage?.cost, undefined);
  }
  const changedCurrency = applySessionUpdate(paid, update({ amount: 2, currency: "EUR" }));
  assert.deepEqual(changedCurrency.usage?.cost, { amount: 2, currency: "EUR" });
  assert.equal(applySessionUpdate(base, update(undefined, 2000, 1000)).usage?.used, 2000);
});

test("configuration and local history do not reset cost; replay explicitly starts from unknown", () => {
  const paid = applySessionUpdate(base, update({ amount: 0.01, currency: "USD" }));
  const changed = applySessionUpdate(paid, { sessionUpdate: "config_option_update", configOptions: [] });
  assert.deepEqual(changed.usage, paid.usage);
  const history = { ...changed, messages: [{ id: "m1", role: "assistant" as const, content: "Done", createdAt: base.updatedAt }] };
  const empty = resetConversationReplay(history);
  assert.deepEqual(empty.messages, []);
  assert.equal(empty.usage, undefined);
  assert.deepEqual(empty.configOptions, []);
  assert.deepEqual(applySessionUpdate(empty, update()).usage, { used: 100, size: 1000 });
  assert.deepEqual(applySessionUpdate(applySessionUpdate(empty, update(paid.usage?.cost)), update(paid.usage?.cost)).usage, paid.usage);
});

test("cost formatting labels currency and never rounds a positive amount to zero", () => {
  assert.equal(formatSessionCost(undefined), "Not reported");
  assert.equal(formatSessionCost({ amount: 0, currency: "USD" }), "USD 0");
  assert.equal(formatSessionCost({ amount: 0.01234, currency: "EUR" }), "EUR 0.01234");
  for (const amount of [Number.MIN_VALUE, 1e-15, Number.MAX_VALUE]) {
    const formatted = formatSessionCost({ amount, currency: "USD" });
    assert.ok(formatted.length < 30);
    assert.notEqual(formatted, "USD 0");
    assert.equal(formatted, `USD ${amount}`);
  }
});
