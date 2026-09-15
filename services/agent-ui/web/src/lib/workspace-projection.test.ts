import assert from "node:assert/strict";
import test from "node:test";
import {
  applyDiscovery,
  applyConversation,
  applySessionCatalog,
} from "./workspace-projection.ts";
import { previewWorkspace } from "./preview.ts";

test("global discovery retains current selection, never silently chooses a different Agent", () => {
  const current = previewWorkspace();
  const next = applyDiscovery(current, {
    ...current,
    activeAgentId: "agent-finance",
    conversations: [],
  });
  assert.equal(next.activeAgentId, current.activeAgentId);
  assert.deepEqual(next.conversations, current.conversations);
  const removed = applyDiscovery(current, { ...current, agents: [] });
  assert.equal(removed.activeAgentId, "");
  assert.deepEqual(removed.conversations, []);
});

test("identity change invalidates all private memory even when Agent identifiers overlap", () => {
  const current = previewWorkspace();
  const next = applyDiscovery(current, {
    ...current,
    principal: { ...current.principal, userId: "new-user" },
  });
  assert.equal(next.activeAgentId, "");
  assert.equal(next.activeConversationId, null);
  assert.deepEqual(next.conversations, []);
});

test("Session catalog refresh keeps exact selection and failed replay retains readable memory", () => {
  const current = previewWorkspace();
  const previous = {
    ...current.conversations[0],
    plan: [
      {
        content: "Review",
        status: "in_progress" as const,
        priority: "medium" as const,
      },
    ],
  };
  current.conversations[0] = previous;
  const listed = { ...previous, messages: [], plan: undefined };
  const next = applySessionCatalog(current, current.activeAgentId, [
    { ...listed, historyState: "loading" },
  ]);
  assert.equal(next.activeConversationId, current.activeConversationId);
  assert.deepEqual(next.conversations[0].messages, previous.messages);
  const failed = applyConversation(next, { ...listed, historyState: "failed" });
  assert.deepEqual(failed.conversations[0].messages, previous.messages);
  assert.deepEqual(failed.conversations[0].plan, previous.plan);
  assert.deepEqual(
    applyConversation(failed, listed).conversations[0].messages,
    [],
  );
  assert.equal(
    applyConversation(failed, { ...listed, plan: undefined }).conversations[0]
      .plan,
    undefined,
  );
});
