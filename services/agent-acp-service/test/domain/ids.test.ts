import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  agentIdSchema,
  organizationIdSchema,
  scopedIdPattern,
  userIdSchema,
} from "../../src/domain/ids.js";
import { learningScopedId } from "../../src/domain/learning-policy.js";
import { ownershipScope } from "../../src/domain/agent-ownership.js";
import {
  parseRuntimeBarrierQuery,
  parseRuntimeBarrierQueryResult,
} from "../../src/domain/runtime-barrier-query.js";

const vectors = JSON.parse(
  readFileSync(new URL("../../../../contracts/common/id-vectors.json", import.meta.url), "utf8"),
) as Record<string, { accept: string[]; reject: string[] }>;
const shared = JSON.parse(
  readFileSync(new URL("../../../../contracts/common/ids.schema.json", import.meta.url), "utf8"),
) as { $id: string };
const ajv = new Ajv2020({ strict: true, validateFormats: false });
ajv.addSchema(shared);

describe("shared opaque resource identifiers", () => {
  it("keeps the learning alias bound to the shared pattern", () => {
    expect(learningScopedId).toBe(scopedIdPattern);
  });
  it("applies the shared vectors through ownership scope and barrier query parsers", () => {
    for (const value of vectors.organizationId!.accept)
      expect(() => ownershipScope({ organizationId: value, agentId: "a-1" })).not.toThrow();
    for (const value of vectors.organizationId!.reject)
      expect(() => ownershipScope({ organizationId: value, agentId: "a-1" })).toThrow(TypeError);
    for (const value of vectors.agentId!.accept)
      expect(() => ownershipScope({ organizationId: "o-1", agentId: value })).not.toThrow();
    for (const value of vectors.agentId!.reject)
      expect(() => ownershipScope({ organizationId: "o-1", agentId: value })).toThrow(TypeError);
    const query = {
      organization_id: "o-1",
      agent_id: "a-1",
      expected_runtime_revision: "rev+edge",
    };
    for (const value of vectors.organizationId!.accept)
      expect(parseRuntimeBarrierQuery({ ...query, organization_id: value }).organization_id).toBe(
        value,
      );
    for (const value of vectors.organizationId!.reject)
      expect(() => parseRuntimeBarrierQuery({ ...query, organization_id: value })).toThrow();
    for (const value of vectors.agentId!.accept)
      expect(parseRuntimeBarrierQuery({ ...query, agent_id: value }).agent_id).toBe(value);
    for (const value of vectors.agentId!.reject)
      expect(() => parseRuntimeBarrierQuery({ ...query, agent_id: value })).toThrow();
    const result = {
      organization_id: "o-1",
      agent_id: "a-1",
      runtime_revision: "rev+edge",
      barrier: {
        barrier_id: "barrier/ctx+1",
        reason: "runtime_barrier_required",
        runtime_execution_id: "exec+id/1",
      },
    };
    expect(parseRuntimeBarrierQueryResult(result).barrier?.barrier_id).toBe("barrier/ctx+1");
    for (const value of vectors.organizationId!.reject)
      expect(() => parseRuntimeBarrierQueryResult({ ...result, organization_id: value })).toThrow();
    for (const value of vectors.agentId!.reject)
      expect(() => parseRuntimeBarrierQueryResult({ ...result, agent_id: value })).toThrow();
  });
  it.each(["organizationId", "userId", "agentId"] as const)(
    "%s matches the shared schema on every boundary vector",
    (kind) => {
      const schema = {
        organizationId: organizationIdSchema,
        userId: userIdSchema,
        agentId: agentIdSchema,
      }[kind];
      const check = ajv.getSchema(`${shared.$id}#/$defs/${kind}`)!;
      for (const value of vectors[kind]!.accept) {
        expect(schema.safeParse(value).success, `zod ${kind} ${JSON.stringify(value)}`).toBe(true);
        expect(check(value), `schema ${kind} ${JSON.stringify(value)}`).toBe(true);
      }
      for (const value of vectors[kind]!.reject) {
        expect(schema.safeParse(value).success, `zod ${kind} ${JSON.stringify(value)}`).toBe(false);
        expect(check(value), `schema ${kind} ${JSON.stringify(value)}`).toBe(false);
      }
      for (const value of [null, 7, {}, []] as const) {
        expect(schema.safeParse(value).success).toBe(false);
      }
    },
  );
});
