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
  it("round trips explicit organization and Agent caps through the public projection", () => {
    const input = publication();
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
    const legacy = publicExecutionConfiguration(
      parseExecutionConfiguration(executionConfiguration()),
    );
    expect(legacy).not.toHaveProperty("organization_budget");
    expect(legacy.agents[0]).not.toHaveProperty("run_budget");
    const input = publication();
    input.agents[0]!.run_budget.max_cost_usd_micros = 0;
    expect(
      publicExecutionConfiguration(parseExecutionConfiguration(input)).agents[0],
    ).toMatchObject({ run_budget: { max_cost_usd_micros: 0 } });
  });
});
