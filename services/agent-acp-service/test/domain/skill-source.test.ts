import { readFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it } from "vitest";
import {
  skillProjectionSchema,
  skillSourceArtifactSchema,
  skillSourceInspectSchema,
} from "../../src/domain/skill-source.js";

const readJson = async (path: string) =>
  JSON.parse(await readFile(new URL(path, import.meta.url), "utf8")) as { $id: string };

it("implements the frozen Registry/source JSON schema without admitting mixed refs or caller supplied content/URLs", async () => {
  const schemas = await Promise.all(
    ["registry-api.ids-v2.schema.json", "discovery-api.ids-v2.schema.json"].map(async (name) =>
      readJson(`../../../../contracts/skill-registry/${name}`),
    ),
  );
  const ajv = new Ajv2020({ strict: true, validateFormats: false });
  ajv.addSchema(await readJson("../../../../contracts/common/ids.schema.json"));
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
      { organization_id: "other/org" },
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

it("matches the shared opaque-ID vectors on every public identity field", async () => {
  const vectors = (await readJson(
    "../../../../contracts/common/id-vectors.json",
  )) as unknown as Record<string, { accept: string[]; reject: string[] }>;
  const base = {
    organization_id: "tenant.42",
    agent_id: "Legacy.Agent_9",
    owner_id: "jdoe.1999",
    name: "inspect-first",
    description: "Inspect first.",
    sequence: 1,
    content_digest: `sha256:${"d".repeat(64)}`,
    active: true,
  };
  const projectionFields = {
    organizationId: "organization_id",
    agentId: "agent_id",
    userId: "owner_id",
  } as const;
  for (const [kind, field] of Object.entries(projectionFields)) {
    for (const value of vectors[kind]!.accept)
      expect(
        skillProjectionSchema.safeParse({ ...base, [field]: value }).success,
        `${kind} accept ${JSON.stringify(value)}`,
      ).toBe(true);
    for (const value of vectors[kind]!.reject)
      expect(
        skillProjectionSchema.safeParse({ ...base, [field]: value }).success,
        `${kind} reject ${JSON.stringify(value)}`,
      ).toBe(false);
  }
  const inspect = {
    organization_id: base.organization_id,
    actor_id: base.owner_id,
    sources: [{ agent_id: base.agent_id, name: base.name }],
  };
  for (const value of vectors.userId!.accept)
    expect(skillSourceInspectSchema.safeParse({ ...inspect, actor_id: value }).success).toBe(true);
  for (const value of vectors.userId!.reject)
    expect(skillSourceInspectSchema.safeParse({ ...inspect, actor_id: value }).success).toBe(false);
  for (const value of vectors.agentId!.accept)
    expect(
      skillSourceInspectSchema.safeParse({
        ...inspect,
        sources: [{ agent_id: value, name: base.name }],
      }).success,
    ).toBe(true);
  for (const value of vectors.agentId!.reject)
    expect(
      skillSourceInspectSchema.safeParse({
        ...inspect,
        sources: [{ agent_id: value, name: base.name }],
      }).success,
    ).toBe(false);
  const artifact = {
    organization_id: base.organization_id,
    actor_id: base.owner_id,
    skill_ref: { kind: "agent", agent_id: base.agent_id, name: base.name, sequence: 1 },
    expected_digest: base.content_digest,
  };
  for (const value of vectors.agentId!.accept)
    expect(
      skillSourceArtifactSchema.safeParse({
        ...artifact,
        skill_ref: { ...artifact.skill_ref, agent_id: value },
      }).success,
    ).toBe(true);
  for (const value of vectors.agentId!.reject)
    expect(
      skillSourceArtifactSchema.safeParse({
        ...artifact,
        skill_ref: { ...artifact.skill_ref, agent_id: value },
      }).success,
    ).toBe(false);
});
