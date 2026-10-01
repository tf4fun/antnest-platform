import { readFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it } from "vitest";
import {
  skillProjectionSchema,
  skillSourceArtifactSchema,
  skillSourceInspectSchema,
} from "../../src/domain/skill-source.js";

it("implements the frozen Registry/source JSON schema without admitting mixed refs or caller supplied content/URLs", async () => {
  const schemas = await Promise.all(
    ["registry-api.schema.json", "discovery-api.schema.json"].map(
      async (name) =>
        JSON.parse(
          await readFile(
            new URL(`../../../../contracts/skill-registry/${name}`, import.meta.url),
            "utf8",
          ),
        ) as { $id: string },
    ),
  );
  const ajv = new Ajv2020({ strict: true, validateFormats: false });
  for (const schema of schemas) ajv.addSchema(schema);
  const projection = {
    organization_id: `org_${"a".repeat(32)}`,
    agent_id: `agent_${"b".repeat(32)}`,
    owner_id: `user_${"c".repeat(32)}`,
    name: "inspect-first",
    description: "Inspect first.",
    sequence: 1,
    content_digest: `sha256:${"d".repeat(64)}`,
    active: true,
  };
  const key = { agent_id: projection.agent_id, name: projection.name };
  const inspect = {
    organization_id: projection.organization_id,
    actor_id: projection.owner_id,
    sources: [key],
  };
  const artifact = {
    organization_id: projection.organization_id,
    actor_id: projection.owner_id,
    skill_ref: { kind: "agent", ...key, sequence: 1 },
    expected_digest: projection.content_digest,
  };
  for (const [name, implementation, value] of [
    ["projection", skillProjectionSchema, projection],
    ["inspect_request", skillSourceInspectSchema, inspect],
    ["source_artifact_request", skillSourceArtifactSchema, artifact],
  ] as const) {
    const check = ajv.getSchema(`${schemas[1]!.$id}#/$defs/${name}`)!;
    expect(check(value)).toBe(true);
    expect(implementation.safeParse(value).success).toBe(true);
    for (const patch of [
      { source_url: "http://other" },
      { instructions: "body" },
      { artifact: "ZIP" },
      { organization_id: "other-org" },
    ]) {
      expect(check({ ...value, ...patch })).toBe(false);
      expect(implementation.safeParse({ ...value, ...patch }).success).toBe(false);
    }
  }
  expect(
    skillSourceArtifactSchema.safeParse({
      ...artifact,
      skill_ref: { ...artifact.skill_ref, skill_id: "skill", version: 1 },
    }).success,
  ).toBe(false);
  expect(skillSourceInspectSchema.safeParse({ ...inspect, sources: [key, key] }).success).toBe(
    false,
  );
  expect(
    skillSourceInspectSchema.safeParse({
      ...inspect,
      sources: Array.from({ length: 51 }, (_, i) => ({ ...key, name: `skill-${i}` })),
    }).success,
  ).toBe(false);
});
