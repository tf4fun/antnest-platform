import assert from "node:assert/strict";

const first = "For the fixture task, inspect the target before editing it.";
const second = "For the fixture task, check the result after editing it.";

export function callerDecision(payload, prompt, messagesAfter) {
  const prefix = "discover excluding self ";
  if (!prompt.startsWith(prefix)) return null;
  const selected = JSON.parse(prompt.slice(prefix.length));
  assert.notEqual(selected.caller_agent_id, selected.peer_agent_id);
  for (const name of ["find_skill", "load_skill"])
    assert(payload.tools.some((tool) => tool.function.name === name));
  const results = messagesAfter.filter((message) => message.role === "tool");
  if (results.length === 0)
    return {
      kind: "foreground-caller-search",
      call: {
        name: "find_skill",
        arguments: { query: "fixture-procedure", limit: 2 },
      },
    };
  const items = JSON.parse(results[0].content).items;
  assert(Array.isArray(items));
  assert.equal(items.length, 2);
  assert(
    items.every((item) => item.skill_ref.agent_id !== selected.caller_agent_id),
  );
  const formal = items.find(
    (item) =>
      item.skill_ref.kind === "registry" &&
      item.skill_ref.skill_id === selected.formal_ref.skill_id &&
      item.skill_ref.version === selected.formal_ref.version,
  );
  const peer = items.find(
    (item) =>
      item.skill_ref.kind === "agent" &&
      item.skill_ref.agent_id === selected.peer_agent_id &&
      item.skill_ref.name === "fixture-procedure" &&
      item.skill_ref.sequence === 1,
  );
  assert(
    formal && peer,
    "search must return the actual formal and other Agent sources",
  );
  assert.deepEqual(formal.skill_ref, selected.formal_ref);
  assert.equal(formal.content_digest, selected.formal_digest);
  assert.equal(peer.content_digest, selected.peer_digest);
  const load = (item, kind) => ({
    kind,
    call: {
      name: "load_skill",
      arguments: {
        skill_ref: item.skill_ref,
        expected_digest: item.content_digest,
      },
    },
  });
  if (results.length === 1)
    return load(formal, "foreground-caller-load-formal");
  const check = (result, item, updated) => {
    assert.deepEqual(result.skill_ref, item.skill_ref);
    assert.equal(result.content_digest, item.content_digest);
    assert.equal(result.temporary_files, null);
    assert.equal(result.requires_runtime_delivery, false);
    assert(result.skill_text?.includes(first));
    assert.equal(result.skill_text.includes(second), updated);
  };
  check(JSON.parse(results[1].content), formal, true);
  if (results.length === 2) return load(peer, "foreground-caller-load-peer");
  assert.equal(results.length, 3);
  check(JSON.parse(results[2].content), peer, false);
  return {
    kind: "foreground-caller-reply",
    text: "Caller search loaded the formal and peer Skills.",
  };
}
