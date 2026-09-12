import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";
import { Ajv } from "ajv";
import { z } from "zod";

import {
  AgentControllerClient,
  requireAgentControllerReady,
} from "../../../src/adapters/controller/client.js";
import { AGENT_CONTROLLER_ERROR_CODES } from "../../../src/ports/agent-controller.js";

const methodSchema = z.object({
  method: z.literal("POST"),
  path: z.string().startsWith("/"),
  success_status: z.literal(200),
  request_content_type: z.literal("application/json"),
  response_content_type: z.literal("application/json"),
  request: z.object({
    type: z.literal("object"),
    required: z.array(z.string()),
    properties: z.record(z.string(), z.unknown()),
    additionalProperties: z.literal(false),
    oneOf: z.array(z.unknown()).optional(),
  }),
  response: z.object({
    type: z.literal("object"),
    required: z.array(z.string()),
    properties: z.record(z.string(), z.unknown()),
  }),
});

const contractSchema = z.object({
  revision: z.literal(12),
  base_path: z.string().startsWith("/"),
  status: z.object({
    method: z.literal("GET"),
    path: z.literal("/status"),
    success_status: z.literal(200),
    response_content_type: z.literal("application/json"),
    response: z.object({
      type: z.literal("object"),
      required: z.array(z.string()),
      properties: z.record(z.string(), z.unknown()),
    }),
  }),
  error: z.object({
    type: z.literal("object"),
    response_content_type: z.literal("application/json"),
    properties: z.object({ code: z.object({ enum: z.array(z.string()) }) }),
  }),
  methods: z.object({
    get_session_configuration: methodSchema,
    resolve_agent_access: methodSchema,
    acquire_run: methodSchema,
    resolve_credential: methodSchema,
    finish_run: methodSchema,
  }),
});

const CONTRACT_URL = new URL(
  "../../../../../contracts/agent-controller/run-contract.json",
  import.meta.url,
);

describe("Agent Controller consumer contract", () => {
  it.each([
    { currency: "USD", input_per_million: 2, output_per_million: 8 },
    {
      currency: "USD",
      input_per_million: 0,
      output_per_million: 0,
      cache_read_per_million: 0,
      cache_write_per_million: 3,
    },
  ])("accepts the shared F10 admission pricing contract %j", async (pricing) => {
    const responses = responseFixtures();
    const spec = responses.acquire_run.execution_spec as { model: Record<string, unknown> };
    spec.model.pricing = pricing;
    const contract = contractSchema.parse(JSON.parse(readFileSync(CONTRACT_URL, "utf8")));
    const validate = new Ajv({ strict: false, validateFormats: false }).compile(
      contract.methods.acquire_run.response,
    );
    expect(validate(responses.acquire_run), JSON.stringify(validate.errors)).toBe(true);
    const client = new AgentControllerClient({
      baseUrl: new URL("http://agent-controller:8080/rpc/agent-controller/"),
      timeoutMs: 5000,
      fetchFn: () => Promise.resolve(Response.json(responses.acquire_run)),
    });
    const admitted = await client.acquireRun({
      requestId: "run",
      agentId: "agent",
      principalId: "principal",
      expectedAccessRevision: "r1",
      sessionId: "session",
    });
    expect(admitted.executionSpec.model.pricing).toEqual({
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
    for (const invalid of [
      null,
      { ...pricing, currency: "EUR" },
      { ...pricing, cache_read_per_million: null },
      { ...pricing, cache_write_per_million: null },
      { ...pricing, input_per_million: -1 },
      { currency: "USD", input_per_million: 2 },
      { ...pricing, output_per_million: "8" },
    ]) {
      spec.model.pricing = invalid;
      expect(validate(responses.acquire_run)).toBe(false);
      await expect(
        client.acquireRun({
          requestId: "run",
          agentId: "agent",
          principalId: "principal",
          expectedAccessRevision: "r1",
          sessionId: "session",
        }),
      ).rejects.toMatchObject({ code: "dependency_unavailable" });
    }
  });

  it.each([true, false, undefined])(
    "decodes the F09 optional native input flags (%s) without inferring support",
    async (enabled) => {
      const responses = responseFixtures();
      const access = responses.resolve_agent_access.prompt_capabilities as Record<string, unknown>;
      const spec = responses.acquire_run.execution_spec as { model: Record<string, unknown> };
      if (enabled !== undefined) {
        access.audio = enabled;
        spec.model.supports_audio = enabled;
        spec.model.supports_pdf = enabled;
      }
      const client = new AgentControllerClient({
        baseUrl: new URL("http://agent-controller:8080/rpc/agent-controller/"),
        timeoutMs: 5000,
        fetchFn: (url) =>
          Promise.resolve(
            Response.json(
              url.pathname.endsWith("resolve-agent-access")
                ? responses.resolve_agent_access
                : responses.acquire_run,
            ),
          ),
      });
      const resolved = await client.resolveAgentAccess({
        requestId: "access",
        agentAccessSubject: "subject",
      });
      expect(resolved.promptCapabilities.audio ?? false).toBe(enabled ?? false);
      const admitted = await client.acquireRun({
        requestId: "run",
        agentId: "agent",
        principalId: "principal",
        expectedAccessRevision: "r1",
        sessionId: "session",
      });
      expect(admitted.executionSpec.model.supportsAudio ?? false).toBe(enabled ?? false);
      expect(admitted.executionSpec.model.supportsPdf ?? false).toBe(enabled ?? false);
    },
  );

  it("keeps every outbound RPC path and request envelope aligned with the owned contract", async () => {
    const contract = contractSchema.parse(JSON.parse(readFileSync(CONTRACT_URL, "utf8")));
    expect(contract.error.properties.code.enum).toEqual([...AGENT_CONTROLLER_ERROR_CODES]);
    const responses = responseFixtures();
    const ajv = new Ajv({ strict: false });
    const requests: Array<{ url: URL; init: RequestInit; body?: Record<string, unknown> }> = [];
    const fetchFn = vi.fn((url: URL, init: RequestInit) => {
      if (url.pathname === contract.status.path) {
        requests.push({ url, init });
        return Promise.resolve(
          Response.json({ status: "ready" }, { status: contract.status.success_status }),
        );
      }
      const method = methodForPath(contract, url.pathname);
      const body = parseRequestBody(init.body);
      requests.push({ url, init, body });
      const response = responses[method];
      expect(Object.keys(response)).toEqual(
        expect.arrayContaining(contract.methods[method].response.required),
      );
      expect(ajv.validate(contract.methods[method].response, response)).toBe(true);
      return Promise.resolve(
        Response.json(response, { status: contract.methods[method].success_status }),
      );
    });
    await requireAgentControllerReady({
      serviceUrl: new URL("http://agent-controller:8080/"),
      fetchFn,
      timeoutMs: 5_000,
    });
    const client = new AgentControllerClient({
      baseUrl: new URL(`http://agent-controller:8080${contract.base_path}/`),
      fetchFn,
      timeoutMs: 5_000,
    });

    await client.resolveAgentAccess({
      requestId: "request-access",
      agentAccessSubject: "subject-1",
    });
    await client.getSessionConfiguration({
      requestId: "request-config",
      agentId: "agent-1",
      principalId: "principal-1",
      expectedAccessRevision: "access-1",
      limit: 200,
    });
    await client.acquireRun({
      requestId: "request-acquire",
      agentId: "agent-1",
      principalId: "principal-1",
      expectedAccessRevision: "access-1",
      sessionId: "session-1",
      sessionConfiguration: {
        modelProfileId: "profile-1",
        authorizationMode: "chat",
        toolRules: [
          { source: "runtime", sourceId: "runtime", toolName: "read", decision: "allow" },
        ],
      },
    });
    await client.resolveCredential({
      requestId: "request-credential",
      admissionId: "admission-1",
      credentialRef: "credential-1",
    });
    await client.finishRun({
      requestId: "request-finish",
      admissionId: "admission-1",
      terminalClass: "completed",
      executorState: "quiescent",
      toolEffectState: "settled",
      stopReason: "end_turn",
    });

    const methods = [
      "resolve_agent_access",
      "get_session_configuration",
      "acquire_run",
      "resolve_credential",
      "finish_run",
    ] as const;
    expect(requests).toHaveLength(methods.length + 1);
    const statusRequest = requests[0];
    if (statusRequest === undefined) {
      throw new Error("Missing Agent Controller status request");
    }
    expect(statusRequest.url.pathname).toBe(contract.status.path);
    expect(statusRequest.init.method).toBe(contract.status.method);
    expect(new Headers(statusRequest.init.headers).get("accept")).toBe(
      contract.status.response_content_type,
    );
    for (const [index, method] of methods.entries()) {
      const request = requests[index + 1];
      if (request === undefined) {
        throw new Error(`Missing request for ${method}`);
      }
      const definition = contract.methods[method];
      expect(request.url.pathname).toBe(`${contract.base_path}${definition.path}`);
      expect(request.init.method).toBe(definition.method);
      expect(new Headers(request.init.headers).get("content-type")).toBe(
        definition.request_content_type,
      );
      expect(new Headers(request.init.headers).get("accept")).toBe(
        definition.response_content_type,
      );
      if (request.body === undefined) {
        throw new Error(`Missing request body for ${method}`);
      }
      expect(Object.keys(request.body)).toEqual(
        expect.arrayContaining(definition.request.required),
      );
      expect(Object.keys(request.body).every((key) => key in definition.request.properties)).toBe(
        true,
      );
      expect(ajv.validate(definition.request, request.body)).toBe(true);
      expect(ajv.validate(definition.request, "not-an-object")).toBe(false);
    }

    const finishRequest = contract.methods.finish_run.request;
    const validateFinish = ajv.compile(finishRequest);
    const validFinish = requests.at(-1)?.body;
    expect(validateFinish(validFinish)).toBe(true);
    expect(
      validateFinish({
        ...validFinish,
        terminal_class: "completed",
        tool_effect_state: "unknown",
        error_class: "ambiguous",
      }),
    ).toBe(false);
  });

  it("serializes cancellation without fabricated error or stop fields", async () => {
    let body: Record<string, unknown> | undefined;
    const client = new AgentControllerClient({
      baseUrl: new URL("http://agent-controller:8080/internal/v1/runs/"),
      fetchFn: (_url, init) => {
        body = parseRequestBody(init.body);
        return Promise.resolve(Response.json({ status: "finished", admission_state: "released" }));
      },
      timeoutMs: 5_000,
    });

    await client.finishRun({
      requestId: "request-cancelled",
      admissionId: "admission-cancelled",
      terminalClass: "cancelled",
      executorState: "quiescent",
      toolEffectState: "settled",
    });

    expect(body).toEqual({
      request_id: "request-cancelled",
      admission_id: "admission-cancelled",
      terminal_class: "cancelled",
      tool_effect_state: "settled",
      unknown_effect_source: null,
      stop_reason: null,
      error_class: null,
    });
    expect(body).not.toHaveProperty("executor_state");
  });

  it("serializes unresolved Tool effect provenance", async () => {
    let body: Record<string, unknown> | undefined;
    const client = new AgentControllerClient({
      baseUrl: new URL("http://agent-controller:8080/internal/v1/runs/"),
      fetchFn: (_url, init) => {
        body = parseRequestBody(init.body);
        return Promise.resolve(
          Response.json({ status: "finished", admission_state: "blocked_unknown_effect" }),
        );
      },
      timeoutMs: 5_000,
    });

    await client.finishRun({
      requestId: "request-unresolved",
      admissionId: "admission-unresolved",
      terminalClass: "unresolved",
      executorState: "quiescent",
      toolEffectState: "unknown",
      unknownEffectSource: "client_mcp",
      errorClass: "tool_effect_unknown",
    });

    expect(body).toEqual({
      request_id: "request-unresolved",
      admission_id: "admission-unresolved",
      terminal_class: "unresolved",
      tool_effect_state: "unknown",
      unknown_effect_source: "client_mcp",
      stop_reason: null,
      error_class: "tool_effect_unknown",
    });
  });
});

type Contract = z.infer<typeof contractSchema>;
type MethodName = keyof Contract["methods"];

function methodForPath(contract: Contract, pathname: string): MethodName {
  for (const [name, definition] of Object.entries(contract.methods)) {
    if (pathname === `${contract.base_path}${definition.path}`) {
      return name as MethodName;
    }
  }
  throw new Error(`Unexpected Agent Controller path ${pathname}`);
}

function parseRequestBody(body: BodyInit | null | undefined): Record<string, unknown> {
  if (typeof body !== "string") {
    throw new Error("Agent Controller request body must be JSON text");
  }
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Agent Controller request body must be an object");
  }
  return parsed as Record<string, unknown>;
}

function responseFixtures(): Record<MethodName, Record<string, unknown>> {
  return {
    get_session_configuration: {
      models: [
        {
          model_profile_id: "profile-1",
          revision_id: "r1",
          display_name: "Model",
          model: "model",
          context_window: 32000,
          max_output_tokens: 2048,
          supports_images: false,
        },
      ],
      next_cursor: "",
      default_model: {
        model_profile_id: "profile-1",
        revision_id: "r1",
        display_name: "Model",
        model: "model",
        context_window: 32000,
        max_output_tokens: 2048,
        supports_images: false,
        available: true,
      },
      default_authorization: { mode: "auto", tool_rules: [] },
      authorization_revision: 1,
    },
    resolve_agent_access: {
      principal_id: "principal-1",
      agent_id: "agent-1",
      access_revision: "access-1",
      prompt_capabilities: { image: true, embedded_context: true },
    },
    acquire_run: {
      admission_id: "admission-1",
      admission_deadline: "2026-08-30T00:10:00.000Z",
      agent_spec_revision: "config-1",
      execution_revision: "execution-1",
      runtime_mcp_source_digest: "a".repeat(64),
      agent_execution_spec_digest: "b".repeat(64),
      credential_version: "credential-version-1",
      runtime: {
        runtime_revision: "runtime-1",
        runtime_execution_id: "runtime-execution-1",
        mcp_endpoint: "http://runtime-1:8080/mcp",
      },
      execution_spec: {
        configuration: {
          model_profile_id: "profile-1",
          model_profile_revision_id: "r1",
          authorization: { mode: "chat", tool_rules: [] },
          authorization_revision: 1,
          digest: "c".repeat(64),
        },
        system_prompt: "system",
        context_policy_version: "context-v1",
        skill_instructions: [],
        model: {
          base_url: "https://api.example.test/v1",
          model: "model",
          context_window: 32_000,
          max_output_tokens: 2_048,
          supports_images: false,
        },
        max_model_requests: 8,
        credential_ref: "credential-1",
      },
    },
    resolve_credential: {
      credential_version: "credential-version-1",
      secret_type: "bearer",
      secret: "provider-secret",
    },
    finish_run: { status: "finished", admission_state: "released" },
  };
}
