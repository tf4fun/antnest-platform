import { describe, expect, it } from "vitest";
import { AgentControllerClient } from "../../../src/adapters/controller/client.js";
import {
  catalogSchema,
  configurationSchema,
  encodeConfiguration,
} from "../../../src/adapters/controller/configuration.js";

const model = {
  model_profile_id: "p1",
  revision_id: "r1",
  display_name: "Name",
  model: "model",
  context_window: 32000,
  max_output_tokens: 2048,
  supports_images: false,
};
const catalog = {
  models: [model],
  next_cursor: "",
  default_model: { ...model, available: true },
  default_authorization: {
    mode: "approve",
    tool_rules: [{ source: "runtime", source_id: "runtime", tool_name: "read", decision: "allow" }],
  },
  authorization_revision: 1,
};

describe("Controller configuration contract decoding", () => {
  it("decodes catalog metadata and rejects leaked credentials or malformed modes", () => {
    expect(catalogSchema.parse(catalog)).toMatchObject({
      defaultModel: { modelProfileId: "p1", revisionId: "r1", available: true },
      defaultAuthorization: {
        mode: "approve",
        toolRules: [{ sourceId: "runtime", toolName: "read", decision: "allow" }],
      },
    });
    expect(() => catalogSchema.parse({ ...catalog, secret: "must-not-expose" })).toThrow();
    expect(() =>
      catalogSchema.parse({ ...catalog, default_authorization: { mode: "root", tool_rules: [] } }),
    ).toThrow();
  });
  it("decodes the independent effective digest, not the build digest", () => {
    expect(
      configurationSchema.parse({
        model_profile_id: "p1",
        model_profile_revision_id: "r1",
        authorization: catalog.default_authorization,
        authorization_revision: 3,
        digest: "f".repeat(64),
      }),
    ).toMatchObject({
      modelProfileId: "p1",
      modelProfileRevisionId: "r1",
      authorizationRevision: 3,
      digest: "f".repeat(64),
    });
    expect(encodeConfiguration({ authorizationMode: "chat" })).toEqual({
      authorization_mode: "chat",
    });
    expect(encodeConfiguration({})).toEqual({});
  });
  it("treats model-unavailable as a definitive admission rejection", async () => {
    const client = new AgentControllerClient({
      baseUrl: new URL("http://controller/rpc/agent-controller/"),
      timeoutMs: 1000,
      fetchFn: () =>
        Promise.resolve(
          Response.json(
            { code: "model_unavailable", message: "Disabled", retryable: false },
            { status: 409 },
          ),
        ),
    });
    await expect(
      client.acquireRun({
        requestId: "request",
        agentId: "agent",
        principalId: "owner",
        expectedAccessRevision: "revision",
        sessionId: "session",
        sessionConfiguration: { modelProfileId: "disabled" },
      }),
    ).rejects.toMatchObject({ code: "model_unavailable", retryable: false });
  });
});
