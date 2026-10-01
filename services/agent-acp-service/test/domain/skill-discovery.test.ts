import { readFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it } from "vitest";
import {
  skillDiscoveryTools,
  skillFindInputSchema,
  skillLoadInputSchema,
} from "../../src/domain/skill-discovery.js";

it("publishes the frozen model inputs and rejects mixed refs or chosen authority", async () => {
  const ajv = new Ajv2020({ strict: false });
  for (const file of ["registry-api.schema.json", "discovery-api.schema.json"])
    ajv.addSchema(
      JSON.parse(
        await readFile(
          new URL(`../../../../contracts/skill-registry/${file}`, import.meta.url),
          "utf8",
        ),
      ) as object,
    );
  const ref = {
    kind: "agent",
    agent_id: `agent_${"a".repeat(32)}`,
    name: "test-skill",
    sequence: 1,
  };
  const digest = `sha256:${"b".repeat(64)}`;
  const entries = [
    [
      "find_skill",
      skillFindInputSchema,
      [{ query: "task" }, { query: "task", limit: 50 }],
      [{ query: " " }, { query: "task", limit: 0 }, { query: "task", organization_id: "x" }],
    ],
    [
      "load_skill",
      skillLoadInputSchema,
      [
        { skill_ref: ref, expected_digest: digest },
        {
          skill_ref: { kind: "registry", skill_id: `skill_${"c".repeat(32)}`, version: 1 },
          expected_digest: digest,
        },
      ],
      [
        { skill_ref: { ...ref, version: 1 }, expected_digest: digest },
        { skill_ref: ref, expected_digest: digest, source_url: "http://caller" },
        { skill_ref: ref, expected_digest: "changed" },
      ],
    ],
  ] as const;
  for (const [name, implementation, allowed, denied] of entries) {
    const frozen = ajv.getSchema(
      `https://antnest.local/contracts/skill-registry/discovery-api.schema.json#/$defs/${name}_input`,
    )!;
    const published = ajv.compile(
      skillDiscoveryTools.find((tool) => tool.name === name)!.inputSchema!,
    );
    for (const values of [allowed, denied])
      for (const value of values) {
        const expected = values === allowed;
        expect(frozen(value)).toBe(expected);
        expect(published(value)).toBe(expected);
        expect(implementation.safeParse(value).success).toBe(expected);
      }
  }
});
