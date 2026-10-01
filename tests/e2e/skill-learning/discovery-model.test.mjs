import assert from "node:assert/strict";
import { test } from "node:test";
import { decide } from "./automatic-model.mjs";

test("discovery fixture asks the real model tools and verifies the returned guidance", () => {
  const payload = {
    model: "stage3-model",
    tools: [
      { function: { name: "find_skill" } },
      { function: { name: "load_skill" } },
    ],
    messages: [
      { role: "user", content: "discover reusable fixture-procedure" },
    ],
  };
  assert.equal(decide(payload).call.name, "find_skill");
  const item = {
    skill_ref: {
      kind: "agent",
      agent_id: `agent_${"a".repeat(32)}`,
      name: "fixture-procedure",
      sequence: 2,
    },
    name: "fixture-procedure",
    description: "A procedure",
    content_digest: `sha256:${"b".repeat(64)}`,
  };
  payload.messages.push({
    role: "tool",
    content: JSON.stringify({ items: [item] }),
  });
  assert.deepEqual(decide(payload).call, {
    name: "load_skill",
    arguments: {
      skill_ref: item.skill_ref,
      expected_digest: item.content_digest,
    },
  });
  payload.messages.push({
    role: "tool",
    content: JSON.stringify({
      skill_ref: item.skill_ref,
      content_digest: item.content_digest,
      temporary_files: null,
      requires_runtime_delivery: false,
      skill_text:
        "For the fixture task, inspect the target before editing it.\nFor the fixture task, check the result after editing it.",
    }),
  });
  assert.equal(decide(payload).kind, "foreground-discovery-reply");
  payload.messages[2].content = JSON.stringify({
    error: { code: "source_unavailable" },
  });
  assert.throws(() => decide(payload));
});
