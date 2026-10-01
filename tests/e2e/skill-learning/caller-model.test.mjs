import assert from "node:assert/strict";
import { test } from "node:test";
import { decide } from "./automatic-model.mjs";

const first = "For the fixture task, inspect the target before editing it.";
const second = "For the fixture task, check the result after editing it.";
const selection = {
  caller_agent_id: `agent_${"1".repeat(32)}`,
  peer_agent_id: `agent_${"2".repeat(32)}`,
  peer_digest: `sha256:${"a".repeat(64)}`,
  formal_ref: {
    kind: "registry",
    skill_id: `skill_${"3".repeat(32)}`,
    version: 2,
  },
  formal_digest: `sha256:${"b".repeat(64)}`,
};
const peerRef = {
  kind: "agent",
  agent_id: selection.peer_agent_id,
  name: "fixture-procedure",
  sequence: 1,
};
const search = {
  items: [
    { skill_ref: peerRef, content_digest: selection.peer_digest },
    {
      skill_ref: selection.formal_ref,
      content_digest: selection.formal_digest,
    },
  ],
};
const formal = {
  skill_ref: selection.formal_ref,
  content_digest: selection.formal_digest,
  skill_text: `${first}\n${second}`,
  temporary_files: null,
  requires_runtime_delivery: false,
};
const peer = {
  skill_ref: peerRef,
  content_digest: selection.peer_digest,
  skill_text: first,
  temporary_files: null,
  requires_runtime_delivery: false,
};
const payload = (...results) => ({
  model: "stage3-model",
  tools: ["find_skill", "load_skill"].map((name) => ({ function: { name } })),
  messages: [
    {
      role: "user",
      content: `discover excluding self ${JSON.stringify(selection)}`,
    },
    ...results.map((result) => ({
      role: "tool",
      content: JSON.stringify(result),
    })),
  ],
});

test("caller fixture searches without model authority and loads exact formal and peer identities", () => {
  const decisions = [
    decide(payload()),
    decide(payload(search)),
    decide(payload(search, formal)),
    decide(payload(search, formal, peer)),
  ];
  assert.deepEqual(decisions[0].call, {
    name: "find_skill",
    arguments: { query: "fixture-procedure", limit: 2 },
  });
  assert.deepEqual(decisions[1].call, {
    name: "load_skill",
    arguments: {
      skill_ref: selection.formal_ref,
      expected_digest: selection.formal_digest,
    },
  });
  assert.deepEqual(decisions[2].call, {
    name: "load_skill",
    arguments: { skill_ref: peerRef, expected_digest: selection.peer_digest },
  });
  assert.equal(
    decisions[3].text,
    "Caller search loaded the formal and peer Skills.",
  );
  assert.equal(new Set(decisions.map((decision) => decision.kind)).size, 4);
});

test("caller fixture cannot succeed with a self projection, busy error or stale/missing source", () => {
  const own = { ...peerRef, agent_id: selection.caller_agent_id };
  for (const invalid of [
    { error: { code: "source_unavailable" } },
    { items: search.items.filter((item) => item.skill_ref.kind !== "agent") },
    {
      items: search.items.map((item, index) =>
        index === 0 ? { ...item, skill_ref: own } : item,
      ),
    },
    {
      items: search.items.map((item, index) =>
        index === 1 ? { ...item, content_digest: selection.peer_digest } : item,
      ),
    },
  ])
    assert.throws(() => decide(payload(invalid)));
  assert.throws(() =>
    decide(payload(search, { ...formal, skill_text: first })),
  );
  assert.throws(() =>
    decide(
      payload(search, formal, { ...peer, skill_text: `${first}\n${second}` }),
    ),
  );
  assert.throws(() =>
    decide(
      payload(search, formal, {
        ...peer,
        content_digest: selection.formal_digest,
      }),
    ),
  );
});

test("second automatic source has distinct foreground and review request identities", () => {
  const text = `learn: peer source: ${first}`;
  const calls = [];
  for (let round = 0; round < 4; round++) {
    const value = {
      model: "stage3-model",
      tools: [{ function: { name: "bash" } }],
      messages: [
        { role: "user", content: text },
        ...Array.from({ length: round }, () => ({
          role: "tool",
          content: "{}",
        })),
      ],
    };
    const decision = decide(value);
    assert(decision.kind.startsWith("foreground-peer-create-"));
    calls.push(decision.kind);
  }
  const review = decide({
    model: "stage3-model",
    tools: [],
    messages: [
      { role: "system", content: "You are reviewing one completed Agent run" },
      {
        role: "user",
        content: JSON.stringify({
          items: [
            {
              kind: "authenticated_user",
              evidenceId: "peer-user-message",
              text,
            },
          ],
        }),
      },
    ],
  });
  assert.equal(review.kind, "review-peer-create");
  assert.equal(JSON.parse(review.text).name, "fixture-procedure");
  calls.push(review.kind);
  assert.equal(new Set(calls).size, 5);
});
