import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  agentExecutionStateRequestSchema,
  agentExecutionStateSchema,
} from "../../src/domain/agent-execution-state.js";

const ready = {
  agent_id: "agent-1",
  access_allowed: true,
  availability: "ready",
  active_session_id: null,
  configuration_revision: "a".repeat(64),
  unavailable_reason: null,
};
const denied = {
  ...ready,
  access_allowed: false,
  availability: "offline",
  configuration_revision: null,
  unavailable_reason: "access_denied",
};

function validator(name: string) {
  const schema: unknown = JSON.parse(
    readFileSync(
      new URL(`../../../../contracts/agent-acp/${name}.schema.json`, import.meta.url),
      "utf8",
    ),
  );
  if (typeof schema !== "object" || schema === null || Array.isArray(schema))
    throw new Error("Invalid shared schema");
  return new Ajv2020({ strict: true }).compile(schema);
}

describe("workspace state contract", () => {
  it("has no request-side identity or mutable parameters", () => {
    const shared = validator("agent-execution-state-request");
    for (const value of [{}, { agent_id: "other" }, { principal_id: "other" }, null, []]) {
      expect(shared(value)).toBe(agentExecutionStateRequestSchema.safeParse(value).success);
      expect(shared(value)).toBe(
        value !== null && !Array.isArray(value) && Object.keys(value).length === 0,
      );
    }
  });

  it.each([
    ready,
    denied,
    { ...ready, availability: "busy", active_session_id: "session-1" },
    { ...ready, availability: "busy", unavailable_reason: "agent_unavailable" },
    { ...ready, availability: "offline", unavailable_reason: "runtime_barrier_required" },
    { ...ready, availability: "offline", unavailable_reason: "agent_unavailable" },
  ])("accepts an authorized view or sanitized denial: %j", (state) => {
    expect(agentExecutionStateSchema.safeParse(state).success).toBe(true);
    expect(validator("agent-execution-state")(state)).toBe(true);
  });

  it.each([
    { ...denied, active_session_id: "leaked-session" },
    { ...denied, configuration_revision: "a".repeat(64) },
    { ...ready, availability: "busy", configuration_revision: null },
    { ...ready, active_session_id: "session-1" },
    { ...ready, unavailable_reason: "runtime_barrier_required" },
    { ...ready, availability: "offline" },
    { ...ready, run_id: "internal" },
    { ...ready, credential: "secret" },
  ])("rejects contradictory or leaking states: %j", (state) => {
    expect(agentExecutionStateSchema.safeParse(state).success).toBe(false);
    expect(validator("agent-execution-state")(state)).toBe(false);
  });
});
