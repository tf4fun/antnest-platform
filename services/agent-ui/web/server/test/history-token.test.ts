import assert from "node:assert/strict";
import { test } from "node:test";
import { HistoryTokens } from "../src/bridge/history-token.ts";

const condition = {
  organizationId: "org-1",
  principalId: "user-1",
  agentId: "agent-1",
  sessionId: "session-1",
  epoch: "epoch-1",
  incarnation: "incarnation-1",
  appendVersion: 3,
};

test("history token binds identity, Session, epoch, incarnation and append position", () => {
  const tokens = new HistoryTokens(Buffer.alloc(32, 7));
  const token = tokens.issue(condition);
  assert.equal(tokens.matches(token, condition), true);
  for (const changed of [
    { principalId: "user-2" },
    { agentId: "agent-2" },
    { sessionId: "session-2" },
    { epoch: "epoch-2" },
    { incarnation: "incarnation-2" },
    { appendVersion: 4 },
  ])
    assert.equal(tokens.matches(token, { ...condition, ...changed }), false);
});

test("a changed or malformed token never satisfies If-Match", () => {
  const tokens = new HistoryTokens(Buffer.alloc(32, 7));
  const token = tokens.issue(condition);
  assert.equal(tokens.matches(`${token}x`, condition), false);
  assert.equal(tokens.matches("", condition), false);
  assert.equal(tokens.matches("v1.invalid.invalid", condition), false);
  assert.equal(tokens.matches("x".repeat(4097), condition), false);
});
