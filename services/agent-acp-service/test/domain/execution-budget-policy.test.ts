import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  parseExecutionConfiguration,
  parsePublicExecutionConfiguration,
  publicExecutionConfiguration,
} from "../../src/domain/execution-configuration.js";
import { runSnapshot } from "../../src/domain/run-snapshot.js";
import { parseStoredRunSnapshot } from "../../src/domain/stored-run-snapshot.js";
import { executionConfiguration, executionIdentity } from "../fixtures/execution-configuration.js";

const runBudget = { max_input_tokens: 2000, max_output_tokens: 500, max_cost_usd_micros: 10 };
const organizationBudget = {
  revision: 1,
  unknown_cost: "deny" as const,
  run_caps: { max_cost_usd_micros: 9 },
  daily: { soft_cost_usd_micros: 50, hard_cost_usd_micros: 100 },
  monthly: { hard_cost_usd_micros: 1000 },
};

function publication() {
  const base = executionConfiguration();
  return {
    ...base,
    organization_budget: structuredClone(organizationBudget),
    agents: base.agents.map((agent) => ({ ...agent, run_budget: { ...runBudget } })),
  };
}

describe("execution budget publication", () => {
  const schema: unknown = JSON.parse(
    readFileSync(
      new URL("../../../../contracts/agent-acp/execution-snapshot.schema.json", import.meta.url),
      "utf8",
    ),
  );
  if (typeof schema !== "object" || schema === null || Array.isArray(schema))
    throw new Error("Execution snapshot schema must be an object");
  const validator = new Ajv2020({ strict: true, validateFormats: false }).compile(schema);

  it("round trips explicit organization and Agent caps through the public projection", () => {
    const input = publication();
    expect(validator(input), JSON.stringify(validator.errors)).toBe(true);
    const parsed = parseExecutionConfiguration(input);
    const projected = publicExecutionConfiguration(parsed);
    expect(parsePublicExecutionConfiguration(JSON.parse(JSON.stringify(projected)))).toEqual(
      projected,
    );
    expect(projected).toMatchObject({
      organization_budget: organizationBudget,
      agents: [{ run_budget: runBudget }],
    });
    expect(JSON.stringify(projected)).not.toContain("synthetic-provider-key");
    expect(input).toEqual(publication());
  });

  it("freezes the Template cap without freezing the organization enforcement policy", () => {
    const input = publication();
    const configuration = publicExecutionConfiguration(parseExecutionConfiguration(input));
    const snapshot = runSnapshot({
      configuration,
      identity: executionIdentity(),
      overrides: {},
      accessRevision: "access-1",
      clientMcpRevisionId: "mcp-1",
      deadlineAt: new Date("2026-10-25T02:00:00Z"),
    });
    expect(snapshot.executionSpec).toMatchObject({ runBudget });
    expect(parseStoredRunSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
    input.agents[0]!.run_budget.max_cost_usd_micros = 1;
    configuration.agents[0]!.run_budget!.max_cost_usd_micros = 2;
    expect(snapshot.executionSpec).toMatchObject({ runBudget });
    expect(snapshot).not.toHaveProperty("organizationBudget");
    expect(snapshot.executionSpec).not.toHaveProperty("organizationBudget");
  });

  it("retains legacy omission and explicit zero as different policies", () => {
    expect(validator(executionConfiguration()), JSON.stringify(validator.errors)).toBe(true);
    const legacy = publicExecutionConfiguration(
      parseExecutionConfiguration(executionConfiguration()),
    );
    expect(legacy).not.toHaveProperty("organization_budget");
    expect(legacy.agents[0]).not.toHaveProperty("run_budget");
    const input = publication();
    input.agents[0]!.run_budget.max_cost_usd_micros = 0;
    expect(validator(input), JSON.stringify(validator.errors)).toBe(true);
    expect(
      publicExecutionConfiguration(parseExecutionConfiguration(input)).agents[0],
    ).toMatchObject({ run_budget: { max_cost_usd_micros: 0 } });
  });

  it("accepts explicit zero at every budget wire field through the complete snapshot", () => {
    const base = executionConfiguration();
    const zero = { max_input_tokens: 0, max_output_tokens: 0, max_cost_usd_micros: 0 };
    const input = {
      ...base,
      organization_budget: {
        revision: 0,
        unknown_cost: "allow" as const,
        run_caps: { ...zero },
        daily: { soft_cost_usd_micros: 0, hard_cost_usd_micros: 0 },
        monthly: { soft_cost_usd_micros: 0, hard_cost_usd_micros: 0 },
      },
      agents: base.agents.map((agent) => ({ ...agent, run_budget: { ...zero } })),
    };
    const before = structuredClone(input);
    expect(validator(input), JSON.stringify(validator.errors)).toBe(true);
    expect(parseExecutionConfiguration(input)).toEqual(before);
    expect(input).toEqual(before);
  });

  function rejectsWire(input: unknown): void {
    const before = structuredClone(input);
    expect(validator(input)).toBe(false);
    expect(() => parseExecutionConfiguration(input)).toThrow();
    expect(input).toEqual(before);
  }

  it.each([-1, 0.5])(
    "rejects invalid budget numeric wire data in complete snapshots: %s",
    (value) => {
      for (const field of ["max_input_tokens", "max_output_tokens", "max_cost_usd_micros"]) {
        const base = publication();
        rejectsWire({
          ...base,
          agents: base.agents.map((agent) => ({
            ...agent,
            run_budget: { ...agent.run_budget, [field]: value },
          })),
        });
        rejectsWire({
          ...base,
          organization_budget: {
            ...base.organization_budget,
            run_caps: { ...base.organization_budget.run_caps, [field]: value },
          },
        });
      }
      for (const period of ["daily", "monthly"] as const)
        for (const field of ["soft_cost_usd_micros", "hard_cost_usd_micros"]) {
          const base = publication();
          rejectsWire({
            ...base,
            organization_budget: {
              ...base.organization_budget,
              [period]: { ...base.organization_budget[period], [field]: value },
            },
          });
        }
      const base = publication();
      rejectsWire({
        ...base,
        organization_budget: { ...base.organization_budget, revision: value },
      });
    },
  );

  it("rejects extra budget wire fields instead of dropping them from complete snapshots", () => {
    const base = publication();
    rejectsWire({
      ...base,
      agents: base.agents.map((agent) => ({
        ...agent,
        run_budget: { ...agent.run_budget, extra: true },
      })),
    });
    rejectsWire({
      ...base,
      organization_budget: { ...base.organization_budget, extra: true },
    });
    rejectsWire({
      ...base,
      organization_budget: {
        ...base.organization_budget,
        run_caps: { ...base.organization_budget.run_caps, extra: true },
      },
    });
    for (const period of ["daily", "monthly"] as const)
      rejectsWire({
        ...base,
        organization_budget: {
          ...base.organization_budget,
          [period]: { ...base.organization_budget[period], extra: true },
        },
      });
  });
});
