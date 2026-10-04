import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  executionConfigurationSchema,
  parseExecutionConfiguration,
  parsePublicExecutionConfiguration,
  publicExecutionConfiguration,
} from "../../src/domain/execution-configuration.js";
import { executionConfiguration } from "../fixtures/execution-configuration.js";

const token = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
function privateConfiguration() {
  const configuration = executionConfiguration();
  configuration.agents[0]!.runtime = {
    runtime_revision: "rtv_11111111111111111111111111111111",
    runtime_execution_id: "runtime-execution-1",
    mcp_endpoint: "http://runtime-1:8080/mcp",
    connection_id: "rci_11111111111111111111111111111111",
    credential: { caller: "agent-acp-service", token },
  };
  return configuration;
}

describe("private Runtime execution publication", () => {
  it("accepts verified private authority and keeps it out of every public projection", () => {
    const incoming = privateConfiguration();
    expect(parseExecutionConfiguration(incoming)).toEqual(incoming);
    const publicConfiguration = publicExecutionConfiguration(incoming);
    expect(JSON.stringify(publicConfiguration)).not.toContain(token);
    expect(publicConfiguration.agents[0]!.runtime).toEqual({
      runtime_revision: "rtv_11111111111111111111111111111111",
      runtime_execution_id: "runtime-execution-1",
      mcp_endpoint: "http://runtime-1:8080/mcp",
      connection_id: "rci_11111111111111111111111111111111",
    });
    expect(parsePublicExecutionConfiguration(publicConfiguration)).toEqual(publicConfiguration);
  });

  it("requires current private authority for accepting Agents", () => {
    const incoming = privateConfiguration();
    const reference = structuredClone(incoming.agents[0]!.runtime!);
    delete reference.credential;
    expect(() =>
      parseExecutionConfiguration({
        ...incoming,
        agents: [{ ...incoming.agents[0], runtime: reference }],
      }),
    ).toThrow();
  });

  it.each([
    ` ${token}`,
    `${token}\n`,
    `${token}=`,
    token.slice(0, -1) + "9",
    "a".repeat(42),
    "a".repeat(87),
  ])("rejects a noncanonical instance token: %j", (value) => {
    const incoming = privateConfiguration();
    const runtime = incoming.agents[0]!.runtime!;
    expect(() =>
      parseExecutionConfiguration({
        ...incoming,
        agents: [
          {
            ...incoming.agents[0],
            runtime: {
              ...runtime,
              credential: { caller: "agent-acp-service", token: value },
            },
          },
        ],
      }),
    ).toThrow();
  });

  it.each([
    "http://runtime-1:8080/mcp?token=x",
    "http://runtime-1:8080/mcp#x",
    "http://user:pass@runtime-1:8080/mcp",
    "http://RUNTIME-1:8080/mcp",
    "http://runtime-1:80/mcp",
    "http://runtime-1:0/mcp",
    "http://runtime-1:8080/%6dcp",
    "http://runtime-1:8080/mcp/",
    "http://runtime-1:8080/other",
    `http://${"a".repeat(1024)}/mcp`,
  ])("rejects a noncanonical executable Runtime endpoint: %s", (mcp_endpoint) => {
    const incoming = privateConfiguration();
    expect(() =>
      parseExecutionConfiguration({
        ...incoming,
        agents: [
          {
            ...incoming.agents[0],
            runtime: {
              ...incoming.agents[0]!.runtime!,
              mcp_endpoint,
            },
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects Runtime credential fields in stored/public configuration", () => {
    const incoming = privateConfiguration();
    const publicConfiguration = publicExecutionConfiguration(incoming);
    const leaked = {
      ...publicConfiguration,
      agents: [{ ...publicConfiguration.agents[0], runtime: incoming.agents[0]!.runtime }],
    };
    expect(() => parsePublicExecutionConfiguration(leaked)).toThrow();
  });

  it.each(["connection_id", "runtime_revision"] as const)(
    "rejects a newline suffix on the canonical %s",
    (field) => {
      const incoming = privateConfiguration();
      const runtime = incoming.agents[0]!.runtime!;
      expect(() =>
        parseExecutionConfiguration({
          ...incoming,
          agents: [
            { ...incoming.agents[0], runtime: { ...runtime, [field]: runtime[field]! + "\n" } },
          ],
        }),
      ).toThrow();
    },
  );

  const fixtures = JSON.parse(
    readFileSync(
      new URL("../../../../contracts/agent-acp/runtime-publication-fixtures.json", import.meta.url),
      "utf8",
    ),
  ) as {
    vectors: { name: string; accepting_runs: boolean; runtime: unknown; valid: boolean }[];
  };
  const generated = z.toJSONSchema(executionConfigurationSchema, { target: "draft-2020-12" });
  const generatedValidator = new Ajv2020({ strict: true, validateFormats: false }).compile(
    generated,
  );
  it.each(fixtures.vectors)("$name survives regeneration of the publication schema", (vector) => {
    const configuration = executionConfiguration();
    expect(
      generatedValidator({
        ...configuration,
        agents: [
          {
            ...configuration.agents[0],
            accepting_runs: vector.accepting_runs,
            runtime: vector.runtime,
          },
        ],
      }),
    ).toBe(vector.valid);
  });
  it("retains write-only authority metadata in the generated schema", () => {
    expect(generated).toHaveProperty(
      "properties.agents.items.properties.runtime.anyOf.0.properties.credential.properties.token.writeOnly",
      true,
    );
  });
  it.each(fixtures.vectors)("$name agrees with the frozen publication contract", (vector) => {
    const configuration = executionConfiguration();
    const input = {
      ...configuration,
      agents: [
        {
          ...configuration.agents[0],
          accepting_runs: vector.accepting_runs,
          runtime: vector.runtime,
        },
      ],
    };
    if (vector.valid) expect(() => parseExecutionConfiguration(input)).not.toThrow();
    else expect(() => parseExecutionConfiguration(input)).toThrow();
  });
});
