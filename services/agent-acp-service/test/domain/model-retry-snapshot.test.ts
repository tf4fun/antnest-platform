import { describe, expect, it } from "vitest";
import {
  parseExecutionConfiguration,
  parsePublicExecutionConfiguration,
  publicExecutionConfiguration,
  resolveExecutionConfiguration,
} from "../../src/domain/execution-configuration.js";
import { runSnapshot } from "../../src/domain/run-snapshot.js";
import { parseStoredRunSnapshot } from "../../src/domain/stored-run-snapshot.js";
import {
  executionConfiguration,
  executionIdentity,
  runtimeConfiguration,
} from "../fixtures/execution-configuration.js";
import { snapshot as legacySnapshot } from "../support/fixtures.js";

const wirePolicy = { max: 2, base_ms: 200, cap_ms: 1000 };
const storedPolicy = { max: 2, baseMs: 200, capMs: 1000 };

function configurations(policy: unknown) {
  const privateConfiguration = executionConfiguration();
  const publicConfiguration = publicExecutionConfiguration(privateConfiguration);
  return {
    private: {
      ...privateConfiguration,
      agents: privateConfiguration.agents.map((agent) => ({ ...agent, model_retry: policy })),
    },
    public: {
      ...publicConfiguration,
      agents: publicConfiguration.agents.map((agent) => ({ ...agent, model_retry: policy })),
    },
  };
}

function capture(configuration: Parameters<typeof runSnapshot>[0]["configuration"]) {
  return runSnapshot({
    configuration,
    identity: executionIdentity(),
    overrides: {},
    accessRevision: "access-1",
    clientMcpRevisionId: "mcp-1",
    deadlineAt: new Date("2026-10-25T00:10:00.000Z"),
  });
}

function storedWithPolicy(policy: unknown) {
  const legacy = legacySnapshot();
  return {
    ...legacy,
    deadlineAt: legacy.deadlineAt.toISOString(),
    executionSpec: { ...legacy.executionSpec, modelRetry: policy },
  };
}

function rejectsPolicy(wire: unknown, stored: unknown) {
  const inputs = configurations(wire);
  expect(() => parseExecutionConfiguration(inputs.private)).toThrow();
  expect(() => parsePublicExecutionConfiguration(inputs.public)).toThrow();
  expect(() => parseStoredRunSnapshot(storedWithPolicy(stored))).toThrow();
}

describe("model retry publication and immutable Run snapshot", () => {
  it.each([
    { wire: { max: 0, base_ms: 1, cap_ms: 1 }, stored: { max: 0, baseMs: 1, capMs: 1 } },
    { wire: wirePolicy, stored: storedPolicy },
    {
      wire: { max: 8, base_ms: 30000, cap_ms: 30000 },
      stored: { max: 8, baseMs: 30000, capMs: 30000 },
    },
  ])(
    "preserves an explicit policy through private/public parsing and Run storage: %j",
    ({ wire, stored }) => {
      const inputs = configurations(wire);
      const privateConfiguration = parseExecutionConfiguration(inputs.private);
      expect(privateConfiguration.agents[0]).toHaveProperty("model_retry", wire);
      const projected = publicExecutionConfiguration(privateConfiguration);
      expect(projected).toStrictEqual(inputs.public);
      const publicConfiguration = parsePublicExecutionConfiguration(projected);
      expect(publicConfiguration).toStrictEqual(inputs.public);
      const selected = resolveExecutionConfiguration(publicConfiguration, executionIdentity(), {});
      expect(selected).toHaveProperty("modelRetry", stored);
      expect(
        resolveExecutionConfiguration(privateConfiguration, executionIdentity(), {}),
      ).toStrictEqual(selected);
      const run = capture(publicConfiguration);
      expect(run.executionSpec).toHaveProperty("modelRetry", stored);
      const record: unknown = JSON.parse(JSON.stringify(run));
      expect(parseStoredRunSnapshot(record)).toStrictEqual(run);
      for (const value of [projected, selected, run, record]) {
        const serialized = JSON.stringify(value);
        expect(serialized).not.toContain("synthetic-provider-key");
        expect(serialized).not.toContain(runtimeConfiguration().credential.token);
      }
      expect(run.runtime).not.toHaveProperty("credential");
    },
  );

  it("preserves the entire legacy wire shape without adding retry defaults", () => {
    const original = executionConfiguration();
    const parsed = parseExecutionConfiguration(original);
    expect(parsed).toStrictEqual(original);
    expect(parsed.agents[0]).not.toHaveProperty("model_retry");
    const projected = publicExecutionConfiguration(parsed);
    expect(parsePublicExecutionConfiguration(projected)).toStrictEqual(projected);
    expect(projected.agents[0]).not.toHaveProperty("model_retry");
    const selected = resolveExecutionConfiguration(projected, executionIdentity(), {});
    expect(selected).not.toHaveProperty("modelRetry");
    expect(capture(projected).executionSpec).not.toHaveProperty("modelRetry");
  });

  it("round-trips an original stored Run without materializing a retry policy", () => {
    const original = legacySnapshot();
    const record: unknown = JSON.parse(JSON.stringify(original));
    const restored = parseStoredRunSnapshot(record);
    expect(restored).toStrictEqual(original);
    expect(restored.executionSpec).not.toHaveProperty("modelRetry");
  });

  it.each([
    ["max", "max", -1],
    ["max", "max", 9],
    ["max", "max", 0.5],
    ["max", "max", "2"],
    ["max", "max", false],
    ["max", "max", null],
    ["base_ms", "baseMs", 0],
    ["base_ms", "baseMs", 30001],
    ["base_ms", "baseMs", 1.5],
    ["base_ms", "baseMs", "200"],
    ["base_ms", "baseMs", false],
    ["base_ms", "baseMs", null],
    ["base_ms", "baseMs", 1001],
    ["cap_ms", "capMs", 0],
    ["cap_ms", "capMs", 30001],
    ["cap_ms", "capMs", 1.5],
    ["cap_ms", "capMs", "1000"],
    ["cap_ms", "capMs", false],
    ["cap_ms", "capMs", null],
    ["cap_ms", "capMs", 199],
    ["unexpected", "unexpected", "must-not-be-dropped"],
  ] as const)(
    "rejects an invalid %s value %j in both wire and storage shapes",
    (wireField, storedField, value) => {
      rejectsPolicy(
        { ...wirePolicy, [wireField]: value },
        { ...storedPolicy, [storedField]: value },
      );
    },
  );

  it.each([
    ["max", "max"],
    ["base_ms", "baseMs"],
    ["cap_ms", "capMs"],
  ] as const)("does not supply the missing required policy field %s", (wireField, storedField) => {
    const wire: Record<string, unknown> = { ...wirePolicy };
    const stored: Record<string, unknown> = { ...storedPolicy };
    delete wire[wireField];
    delete stored[storedField];
    rejectsPolicy(wire, stored);
  });

  it.each([null, [], 1, "retry", true])("rejects a non-object policy: %j", (policy) => {
    rejectsPolicy(policy, policy);
  });

  it("rejects wire field names in stored policies and internal field names on the wire", () => {
    rejectsPolicy(storedPolicy, wirePolicy);
  });

  it.each([
    { max: 3, base_ms: 200, cap_ms: 1000 },
    { max: 2, base_ms: 201, cap_ms: 1000 },
    { max: 2, base_ms: 200, cap_ms: 999 },
  ])("includes each retry setting in the execution-spec digest: %j", (policy) => {
    const current = capture(
      publicExecutionConfiguration(parseExecutionConfiguration(configurations(wirePolicy).private)),
    );
    const changed = capture(
      publicExecutionConfiguration(parseExecutionConfiguration(configurations(policy).private)),
    );
    const legacy = capture(publicExecutionConfiguration(executionConfiguration()));
    expect(changed.agentExecutionSpecDigest).not.toBe(current.agentExecutionSpecDigest);
    expect(current.agentExecutionSpecDigest).not.toBe(legacy.agentExecutionSpecDigest);
  });

  it("copies the admitted policy so later publication or resolved-object changes cannot rewrite the original Run", () => {
    const policy = { ...wirePolicy };
    const configuration = publicExecutionConfiguration(
      parseExecutionConfiguration(configurations(policy).private),
    );
    const selected = resolveExecutionConfiguration(configuration, executionIdentity(), {});
    const run = capture(configuration);
    const before = structuredClone(run);
    const publishedPolicy = Reflect.get(configuration.agents[0]!, "model_retry") as Record<
      string,
      unknown
    >;
    const selectedPolicy = Reflect.get(selected, "modelRetry") as Record<string, unknown>;
    const capturedPolicy: unknown = Reflect.get(run.executionSpec, "modelRetry");
    expect(capturedPolicy).toStrictEqual(storedPolicy);
    expect(selectedPolicy).not.toBe(publishedPolicy);
    expect(capturedPolicy).not.toBe(selectedPolicy);
    expect(capturedPolicy).not.toBe(publishedPolicy);
    policy.max = 8;
    publishedPolicy.base_ms = 250;
    selectedPolicy.capMs = 900;
    expect(run).toStrictEqual(before);
    const nextInput = configurations({ ...wirePolicy, max: 3 }).private;
    nextInput.revision = 2;
    const next = capture(publicExecutionConfiguration(parseExecutionConfiguration(nextInput)));
    expect(next.executionSpec).toHaveProperty("modelRetry", { ...storedPolicy, max: 3 });
    expect(next.agentExecutionSpecDigest).not.toBe(run.agentExecutionSpecDigest);
    expect(run).toStrictEqual(before);
  });
});
