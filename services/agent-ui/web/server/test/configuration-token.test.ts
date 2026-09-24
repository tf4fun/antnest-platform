import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigurationTokens } from "../src/bridge/configuration-token.ts";

test("configuration token binds identity, Session, Bridge generation and ACP revision", () => {
  const tokens = new ConfigurationTokens(Buffer.alloc(32, 7));
  const condition = {
    organizationId: "org-1",
    principalId: "user-1",
    agentId: "agent-1",
    sessionId: "session-1",
    epoch: "epoch-1",
    incarnation: "owner-1",
    revision: "a".repeat(64),
  };
  const token = tokens.issue(condition);
  assert.equal(tokens.matches(token, condition), true);
  assert.equal(
    tokens.matches(token, { ...condition, principalId: "user-2" }),
    false,
  );
  assert.equal(
    tokens.matches(token, { ...condition, incarnation: "owner-2" }),
    false,
  );
  assert.equal(
    tokens.matches(token, { ...condition, revision: "b".repeat(64) }),
    false,
  );
  assert.equal(tokens.matches(token + "x", condition), false);
});
