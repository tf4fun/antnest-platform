import assert from "node:assert/strict";

export function propagationDecision(payload, prompt, messagesAfter) {
  const match =
    /^verify propagated preset v([12]) (created|offline|frozen|rebuilt-existing|rebuilt-new|independent|source-disabled|source-deleted)$/u.exec(
      prompt,
    );
  if (!match) return null;
  assert.equal(
    ["created", "offline", "frozen"].includes(match[2]),
    match[1] === "1",
  );
  assert(payload.tools.some((tool) => tool.function.name === "read"));
  const results = messagesAfter.filter((message) => message.role === "tool");
  if (results.length === 0)
    return {
      kind: `foreground-preset-${match[2]}-read`,
      call: {
        name: "read",
        arguments: { path: "/skills/fixture-procedure/SKILL.md" },
      },
    };
  const result = JSON.parse(results.at(-1).content);
  assert.equal(typeof result.content, "string");
  assert(
    result.content.includes(
      "For the fixture task, inspect the target before editing it.",
    ),
  );
  assert.equal(
    result.content.includes(
      "For the fixture task, check the result after editing it.",
    ),
    match[1] === "2",
    "the Runtime must serve the frozen preset version",
  );
  return {
    kind: `foreground-preset-${match[2]}-reply`,
    text: `Preset v${match[1]} verified.`,
  };
}
