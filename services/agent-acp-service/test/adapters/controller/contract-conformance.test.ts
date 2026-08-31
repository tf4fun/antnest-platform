import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";
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
    required: z.array(z.string()),
    properties: z.record(z.string(), z.unknown()),
  }),
  response: z.object({ required: z.array(z.string()) }),
});

const contractSchema = z.object({
  revision: z.number().int().positive(),
  base_path: z.string().startsWith("/"),
  status: z.object({
    method: z.literal("GET"),
    path: z.literal("/status"),
    success_status: z.literal(200),
    response_content_type: z.literal("application/json"),
    response: z.object({ required: z.array(z.string()) }),
  }),
  error: z.object({
    response_content_type: z.literal("application/json"),
    properties: z.object({ code: z.object({ enum: z.array(z.string()) }) }),
  }),
  methods: z.object({
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
  it("keeps every outbound RPC path and request envelope aligned with the owned contract", async () => {
    const contract = contractSchema.parse(JSON.parse(readFileSync(CONTRACT_URL, "utf8")));
    expect(contract.error.properties.code.enum).toEqual([...AGENT_CONTROLLER_ERROR_CODES]);
    const responses = responseFixtures();
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
      authenticatedSubject: "subject-1",
    });
    await client.acquireRun({
      requestId: "request-acquire",
      agentId: "agent-1",
      sessionId: "session-1",
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
      runtimeEffectState: "settled",
    });

    const methods = [
      "resolve_agent_access",
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
    }
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
    resolve_agent_access: {
      principal_id: "principal-1",
      agent_id: "agent-1",
      access_revision: "access-1",
      prompt_capabilities: { image: true, embedded_context: true },
    },
    acquire_run: {
      admission_id: "admission-1",
      admission_deadline: "2026-08-30T00:10:00.000Z",
      agent_config_revision: "config-1",
      execution_revision: "execution-1",
      runtime_mcp_source_digest: "a".repeat(64),
      agent_execution_spec_digest: "b".repeat(64),
      credential_version: "credential-version-1",
      runtime: {
        runtime_generation: 1,
        runtime_instance_id: "runtime-1",
        runtime_execution_id: "runtime-execution-1",
        mcp_endpoint: "http://runtime-1:8080/mcp",
      },
      execution_spec: {
        system_prompt: "system",
        skill_instructions: [],
        model: {
          adapter: "openai_compatible",
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
    finish_run: { status: "finished" },
  };
}
