import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  parseAgentSettlement,
  agentSettlementResultSchema,
} from "../../src/domain/agent-settlement.js";

const request = {
  organization_id: "organization-1",
  agent_id: "agent-1",
  minimum_revision: 4,
  operation_id: "rebuild-1",
  mode: "wait",
  deadline_at: "2026-09-14T02:00:00.000Z",
};

function contract(file: string) {
  const schema: unknown = JSON.parse(
    readFileSync(
      new URL(`../../../../contracts/agent-acp/${file}.schema.json`, import.meta.url),
      "utf8",
    ),
  );
  if (typeof schema !== "object" || schema === null || Array.isArray(schema))
    throw new Error("Expected object schema");
  return new Ajv2020({ strict: true, validateFormats: false }).compile(schema);
}
const requestContract = contract("settle-agent-request");
const resultContract = contract("settle-agent-result");

describe("Agent settlement contract", () => {
  it.each(["wait", "cancel"])("accepts a bounded %s operation without a Run identity", (mode) => {
    expect(parseAgentSettlement({ ...request, mode })).toEqual({ ...request, mode });
    expect(requestContract({ ...request, mode }), JSON.stringify(requestContract.errors)).toBe(
      true,
    );
  });

  it.each([
    { run_id: "run-1" },
    { admission_id: "obsolete-ticket" },
    { organization_id: "" },
    { agent_id: "x".repeat(201) },
    { operation_id: "" },
    { minimum_revision: 0 },
    { minimum_revision: 1.5 },
    { minimum_revision: Number.MAX_SAFE_INTEGER + 1 },
    { mode: "force" },
    { deadline_at: undefined },
    { deadline_at: "2026-02-30T00:00:00Z" },
    { deadline_at: "2026-09-14" },
    { deadline_at: "2026-09-14T02:00:00" },
  ])("rejects malformed or obsolete inputs: %j", (patch) => {
    expect(requestContract({ ...request, ...patch })).toBe(false);
    expect(() => parseAgentSettlement({ ...request, ...patch })).toThrow(
      "Invalid Agent settlement request",
    );
  });

  it("keeps elapsed deadlines intact for the coordinator instead of silently renewing them", () => {
    expect(parseAgentSettlement(request).deadline_at).toBe(request.deadline_at);
  });

  it.each(["settled", "runtime_barrier_required", "not_settled"])(
    "returns only Agent-level %s",
    (outcome) => {
      const result = { applied_revision: 4, outcome };
      expect(agentSettlementResultSchema.parse(result)).toEqual(result);
      expect(resultContract(result), JSON.stringify(resultContract.errors)).toBe(true);
      expect(resultContract({ ...result, runs: ["run-1"] })).toBe(false);
      expect(agentSettlementResultSchema.safeParse({ ...result, runs: ["run-1"] }).success).toBe(
        false,
      );
    },
  );
});
