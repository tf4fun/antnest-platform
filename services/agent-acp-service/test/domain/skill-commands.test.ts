import { describe, expect, it } from "vitest";
import { skillCommands, skillInvocation } from "../../src/domain/skill-commands.js";
import { runtimeInformation } from "../fixtures/runtime-information.js";

describe("Runtime Skill commands", () => {
  it("lists exact source-qualified identities and omits unsafe or ambiguous names", () => {
    const skill = runtimeInformation().skills[0]!;
    expect(
      skillCommands([skill, { ...skill, source: "personal" }, { ...skill, name: "a/b" }]),
    ).toEqual([
      {
        name: "skill:system:documents",
        description: "Find company documents",
        input: { hint: "Task for this preset Skill" },
      },
      {
        name: "skill:personal:documents",
        description: "Find company documents",
        input: { hint: "Task for this personal Skill" },
      },
    ]);
    expect(skillCommands([skill, { ...skill }])).toEqual([]);
  });
  it("parses only the first user text and preserves the task", () => {
    expect(
      skillInvocation([
        { type: "text", text: " /skill:personal:review Check this diff\nthen explain" },
      ]),
    ).toEqual({
      source: "personal",
      name: "review",
      task: "Check this diff\nthen explain",
      textIndex: 0,
    });
    expect(
      skillInvocation([{ type: "text", text: "Please explain /skill:personal:review" }]),
    ).toBeUndefined();
    expect(() => skillInvocation([{ type: "text", text: "/skill:system:review" }])).toThrow("task");
    expect(() => skillInvocation([{ type: "text", text: "/skill:invalid:review check" }])).toThrow(
      "Skill command",
    );
  });
});
