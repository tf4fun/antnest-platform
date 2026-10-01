import assert from "node:assert/strict";
import { test } from "node:test";
import { temporaryDecision } from "./temporary-model.mjs";
test("temporary fixture requires exact loaded paths and real read/Bash results before completion", () => {
  const payload = {
      tools: ["find_skill", "load_skill", "read", "bash"].map((name) => ({
        function: { name },
      })),
    },
    prompt = "temporary package use",
    results = [];
  assert.equal(
    temporaryDecision(payload, prompt, results).call.name,
    "find_skill",
  );
  const found = {
    skill_ref: {
      kind: "registry",
      skill_id: `skill_${"1".repeat(32)}`,
      version: 1,
    },
    name: "temporary-procedure",
    content_digest: `sha256:${"a".repeat(64)}`,
  };
  results.push({ role: "tool", content: JSON.stringify({ items: [found] }) });
  assert.equal(
    temporaryDecision(payload, prompt, results).call.name,
    "load_skill",
  );
  const path = `/workspace/.antnest/skill-temporary/v1/${"b".repeat(64)}/${"a".repeat(64)}/package`;
  results.push({
    role: "tool",
    content: JSON.stringify({
      skill_ref: found.skill_ref,
      content_digest: found.content_digest,
      requires_runtime_delivery: true,
      temporary_files: { path },
    }),
  });
  assert.equal(
    temporaryDecision(payload, prompt, results).call.arguments.path,
    `${path}/SKILL.md`,
  );
  results.push({ role: "tool", content: "Run scripts/check.sh" });
  assert.equal(temporaryDecision(payload, prompt, results).call.name, "bash");
  results.push({ role: "tool", content: "temporary-check-ok" });
  assert.equal(temporaryDecision(payload, prompt, results).hold, false);
  assert.equal(
    temporaryDecision(payload, "temporary package cancel", results).hold,
    true,
  );
  results[3].content = "unconfirmed";
  assert.throws(() => temporaryDecision(payload, prompt, results));
});
