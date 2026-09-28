import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { executionConfiguration, executionIdentity } from "../fixtures/execution-configuration.js";
import {
  parseExecutionConfiguration,
  parsePublicExecutionConfiguration,
  publicExecutionConfiguration,
  resolveExecutionConfiguration,
  type ExecutionConfiguration,
} from "../../src/domain/execution-configuration.js";

describe("shared execution snapshot contract", () => {
  const schema: unknown = JSON.parse(
    readFileSync(
      new URL("../../../../contracts/agent-acp/execution-snapshot.schema.json", import.meta.url),
      "utf8",
    ),
  );
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    throw new Error("Execution snapshot schema must be an object");
  }
  const validator = new Ajv2020({ strict: true, validateFormats: false }).compile(schema);

  it("accepts the same complete snapshot as the domain validator", () => {
    const fixture = executionConfiguration();
    expect(validator(fixture), JSON.stringify(validator.errors)).toBe(true);
    expect(parseExecutionConfiguration(fixture)).toEqual(fixture);
  });

  it("requires the retired Skill body channel to be empty in both validators", () => {
    const fixture = executionConfiguration();
    fixture.agents[0]!.skill_instructions = [
      { skill_key: "example", version: "1", instructions: "hidden body" },
    ];
    expect(validator(fixture)).toBe(false);
    expect(() => parseExecutionConfiguration(fixture)).toThrow();
  });

  it("preserves opaque identifiers across the wire, stored projection and model selection", () => {
    const fixture = executionConfiguration();
    fixture.organization_id = "organization+division@example.org";
    fixture.providers[0]!.connection_id = "provider+account@example.org";
    fixture.providers[0]!.credential_revision = "credential+[revision]";
    fixture.models[0]!.connection_id = fixture.providers[0]!.connection_id;
    fixture.models[0]!.model_profile_id = "model+profile@example.org";
    fixture.agents[0]!.default_model_profile_id = fixture.models[0]!.model_profile_id;
    fixture.agents[0]!.agent_id = "agent/department+1";
    fixture.agents[0]!.principal_ids = ["owner+team@example.org"];
    expect(validator(fixture), JSON.stringify(validator.errors)).toBe(true);
    const configuration = parseExecutionConfiguration(fixture);
    expect(configuration).toEqual(fixture);
    const stored = publicExecutionConfiguration(configuration);
    expect(parsePublicExecutionConfiguration(stored)).toEqual(stored);
    const identity = {
      organizationId: fixture.organization_id,
      principalId: fixture.agents[0]!.principal_ids[0]!,
      agentId: fixture.agents[0]!.agent_id,
    };
    expect(resolveExecutionConfiguration(configuration, identity, {}).providerConnectionId).toBe(
      fixture.providers[0]!.connection_id,
    );
    expect(() =>
      resolveExecutionConfiguration(
        configuration,
        { ...identity, principalId: "other+team@example.org" },
        {},
      ),
    ).toThrow("access");
  });

  it("rejects legacy admission fields, missing collections and unsupported credentials", () => {
    const fixture = executionConfiguration();
    expect(validator({ ...fixture, admission_id: "obsolete" })).toBe(false);
    expect(validator({ organization_id: "organization-1", revision: 1 })).toBe(false);
    expect(
      validator({
        ...fixture,
        providers: [
          { ...fixture.providers[0], credential: { method: "oauth", secret: "synthetic" } },
        ],
      }),
    ).toBe(false);
  });

  it("does not mistake shape validation for semantic reference validation", () => {
    const broken = { ...executionConfiguration(), providers: [] };
    expect(validator(broken)).toBe(true);
    expect(() => parseExecutionConfiguration(broken)).toThrow("reference");
  });

  const prices: Array<NonNullable<ExecutionConfiguration["models"][number]["pricing"]>> = [
    { currency: "USD", input_per_million: 2, output_per_million: 8 },
    {
      currency: "USD",
      input_per_million: 0,
      output_per_million: 0,
      cache_read_per_million: 0,
      cache_write_per_million: 3,
    },
  ];
  it.each(prices)("preserves current model pricing through the shared snapshot: %j", (pricing) => {
    const fixture = executionConfiguration();
    fixture.models[0]!.pricing = pricing;
    expect(validator(fixture), JSON.stringify(validator.errors)).toBe(true);
    const configuration = parseExecutionConfiguration(fixture);
    const selected = resolveExecutionConfiguration(configuration, executionIdentity(), {});
    expect(selected.model.pricing).toEqual({
      currency: "USD",
      inputPerMillion: pricing.input_per_million,
      outputPerMillion: pricing.output_per_million,
      ...(pricing.cache_read_per_million === undefined
        ? {}
        : { cacheReadPerMillion: pricing.cache_read_per_million }),
      ...(pricing.cache_write_per_million === undefined
        ? {}
        : { cacheWritePerMillion: pricing.cache_write_per_million }),
    });
  });

  it.each([
    null,
    { currency: "EUR", input_per_million: 2, output_per_million: 8 },
    { currency: "USD", input_per_million: 2, output_per_million: 8, cache_read_per_million: null },
    { currency: "USD", input_per_million: 2, output_per_million: 8, cache_write_per_million: null },
    { currency: "USD", input_per_million: -1, output_per_million: 8 },
    { currency: "USD", input_per_million: 2 },
    { currency: "USD", input_per_million: 2, output_per_million: "8" },
  ])("rejects malformed pricing in both shared and runtime validation: %j", (pricing) => {
    const fixture = executionConfiguration();
    const input = { ...fixture, models: [{ ...fixture.models[0], pricing }] };
    expect(validator(input)).toBe(false);
    expect(() => parseExecutionConfiguration(input)).toThrow();
  });

  it.each([true, false, undefined])(
    "preserves explicit native input capabilities: %s",
    (enabled) => {
      const fixture = executionConfiguration();
      const input = {
        ...fixture,
        models: [
          {
            ...fixture.models[0],
            ...(enabled === undefined ? {} : { supports_audio: enabled, supports_pdf: enabled }),
          },
        ],
      };
      expect(validator(input), JSON.stringify(validator.errors)).toBe(true);
      const selected = resolveExecutionConfiguration(
        parseExecutionConfiguration(input),
        executionIdentity(),
        {},
      );
      expect(selected.model.supportsAudio).toBe(enabled);
      expect(selected.model.supportsPdf).toBe(enabled);
    },
  );

  it("rejects secret fields and unsupported approval modes in public model/Agent data", () => {
    const fixture = executionConfiguration();
    const invalid = [
      { ...fixture, models: [{ ...fixture.models[0], secret: "synthetic-leak" }] },
      {
        ...fixture,
        agents: [{ ...fixture.agents[0], default_authorization: { mode: "root", tool_rules: [] } }],
      },
    ];
    for (const input of invalid) {
      expect(validator(input)).toBe(false);
      expect(() => parseExecutionConfiguration(input)).toThrow();
    }
  });
});
