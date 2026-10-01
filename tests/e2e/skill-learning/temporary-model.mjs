import assert from "node:assert/strict";
export function temporaryDecision(payload, prompt, messagesAfter) {
  if (prompt === "temporary clean admission")
    return {
      kind: "temporary-clean-admission",
      text: "Next Run admitted after cleanup.",
    };
  if (!/^temporary package (use|cancel|restart)$/u.test(prompt)) return null;
  const mode = prompt.split(" ").at(-1),
    prefix = `temporary-${mode}`;
  for (const name of ["find_skill", "load_skill", "read", "bash"])
    assert(payload.tools.some((tool) => tool.function.name === name));
  const results = messagesAfter.filter((message) => message.role === "tool");
  if (!results.length)
    return {
      kind: `${prefix}-find`,
      call: {
        name: "find_skill",
        arguments: { query: "temporary-procedure", limit: 5 },
      },
    };
  const found = JSON.parse(results[0].content).items?.find(
    (item) =>
      item.skill_ref.kind === "registry" && item.name === "temporary-procedure",
  );
  assert(found, "formal multi-file fixture must be searchable");
  if (results.length === 1)
    return {
      kind: `${prefix}-load`,
      call: {
        name: "load_skill",
        arguments: {
          skill_ref: found.skill_ref,
          expected_digest: found.content_digest,
        },
      },
    };
  const loaded = JSON.parse(results[1].content);
  assert.deepEqual(loaded.skill_ref, found.skill_ref);
  assert.equal(loaded.content_digest, found.content_digest);
  assert.equal(loaded.requires_runtime_delivery, true);
  const path = loaded.temporary_files?.path;
  assert.match(
    path,
    /^\/workspace\/\.antnest\/skill-temporary\/v1\/[a-f0-9]{64}\/[a-f0-9]{64}\/package$/u,
  );
  if (results.length === 2)
    return {
      kind: `${prefix}-read`,
      call: { name: "read", arguments: { path: `${path}/SKILL.md` } },
    };
  assert(
    results[2].content.includes("Run scripts/check.sh"),
    "read must see actual installed files",
  );
  if (results.length === 3)
    return {
      kind: `${prefix}-bash`,
      call: {
        name: "bash",
        arguments: { command: `sh ${path}/scripts/check.sh` },
      },
    };
  assert(
    results[3].content.includes("temporary-check-ok"),
    "ordinary Bash must execute the installed script",
  );
  return {
    kind: `${prefix}-reply`,
    hold: mode !== "use",
    text: "Temporary package files were read and executed in this Run.",
  };
}
