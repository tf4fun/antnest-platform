import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  parseExecutionConfiguration,
  publicExecutionConfiguration,
} from "../../../../services/agent-acp-service/src/domain/execution-configuration.js";
import { runSnapshot } from "../../../../services/agent-acp-service/src/domain/run-snapshot.js";
import { parseStoredRunSnapshot } from "../../../../services/agent-acp-service/src/domain/stored-run-snapshot.js";
import {
  executionConfiguration,
  executionIdentity,
} from "../../../../services/agent-acp-service/test/fixtures/execution-configuration.js";

const ajvRequire = createRequire(
  new URL(
    "../../../../services/agent-acp-service/package.json",
    import.meta.url,
  ),
);
const { Ajv2020 } = ajvRequire("ajv/dist/2020.js") as {
  Ajv2020: new (options: object) => {
    compile: (schema: object) => {
      (data: unknown): boolean;
      errors?: unknown;
    };
  };
};
const snapshotContract: object = JSON.parse(
  readFileSync(
    new URL(
      "../../../../contracts/agent-acp/execution-snapshot.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as object;

function liveConfiguration() {
  const base = executionConfiguration();
  const providers = [1, 2, 3].map((index) => ({
    ...base.providers[0]!,
    connection_id: `provider-${index}`,
    base_url: `https://provider-${index}.example/v1`,
    credential_revision: `credential-${index}`,
  }));
  const models = [
    {
      ...base.models[0]!,
      model_profile_id: "model-1",
      connection_id: "provider-1",
      model_profile_revision: 7,
      compaction_model_profile_id: "model-3",
    },
    {
      ...base.models[0]!,
      model_profile_id: "model-2",
      connection_id: "provider-2",
      model_profile_revision: 4,
    },
    {
      ...base.models[0]!,
      model_profile_id: "model-3",
      connection_id: "provider-3",
      model_profile_revision: 9,
    },
  ];
  return {
    ...base,
    providers,
    models: models as typeof base.models,
    agents: base.agents.map((agent) => ({
      ...agent,
      failover: "before_output" as const,
      fallback_model_profile_ids: ["model-2"],
    })),
  };
}

function capture(configuration: unknown) {
  return runSnapshot({
    configuration: configuration as Parameters<
      typeof runSnapshot
    >[0]["configuration"],
    identity: executionIdentity(),
    overrides: {},
    accessRevision: "access-1",
    clientMcpRevisionId: "mcp-1",
    deadlineAt: new Date("2026-10-25T00:10:00.000Z"),
  });
}

describe("live model revision delivery boundary", () => {
  it("keeps admitted 7/4/9 revisions while the live head advances", () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const validate = ajv.compile(snapshotContract);
    const live = liveConfiguration();
    expect(validate(live), JSON.stringify(validate.errors)).toBe(true);
    const admitted = capture(
      publicExecutionConfiguration(
        parseExecutionConfiguration(structuredClone(live)),
      ),
    );
    const stored: unknown = JSON.parse(JSON.stringify(admitted));
    const parsed = parseStoredRunSnapshot(stored);
    expect(parsed.modelProfileRevision).toBe(7);
    expect(parsed.executionSpec.fallbackModels?.[0]?.modelProfileRevision).toBe(
      4,
    );
    expect(parsed.executionSpec.compactionModel?.modelProfileRevision).toBe(9);

    const next = structuredClone(live);
    next.revision = next.revision + 1;
    next.models[0]!.model_profile_revision = 8;
    const advanced = capture(
      publicExecutionConfiguration(parseExecutionConfiguration(next)),
    );
    expect(advanced.modelProfileRevision).toBe(8);
    expect(parsed.modelProfileRevision).toBe(7);
    expect(parsed.configurationRevision).toBe(admitted.configurationRevision);
    expect(parsed.agentSpecRevision).toBe(admitted.agentSpecRevision);
    expect(parsed.executionSpec.systemPrompt).toBe(
      admitted.executionSpec.systemPrompt,
    );
  });

  it("keeps legacy publications without revision metadata unchanged", () => {
    const base = executionConfiguration();
    for (const model of base.models)
      expect(model.model_profile_revision).toBeUndefined();
    const admitted = capture(
      publicExecutionConfiguration(structuredClone(base)),
    );
    expect(admitted.modelProfileRevision).toBeUndefined();
    const parsed = parseStoredRunSnapshot(JSON.parse(JSON.stringify(admitted)));
    expect("modelProfileRevision" in parsed).toBe(false);
    expect(parsed.configurationRevision).toBe(admitted.configurationRevision);
  });
});
