import { describe, expect, it, vi } from "vitest";

import {
  AgentControllerClient,
  AgentControllerError,
  requireAgentControllerReady,
} from "../../../src/adapters/controller/client.js";

describe("AgentControllerClient", () => {
  it("maps one complete acquire response without discovering mutable state", async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve(
        Response.json({
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
              base_url: "https://api.example.test/v1",
              model: "model",
              context_window: 32000,
              max_output_tokens: 2048,
              supports_images: false,
            },
            max_model_requests: 8,
            credential_ref: "credential-1",
          },
        }),
      ),
    );
    const client = new AgentControllerClient({
      baseUrl: new URL("http://agent-controller:8080/rpc/agent-controller/"),
      fetchFn,
      timeoutMs: 5_000,
    });

    await expect(
      client.acquireRun({
        requestId: "request-1",
        agentId: "agent-1",
        principalId: "principal-1",
        expectedAccessRevision: "access-1",
        sessionId: "session-1",
      }),
    ).resolves.toMatchObject({
      admissionId: "admission-1",
      admissionDeadline: new Date("2026-08-30T00:10:00.000Z"),
      runtimeMcpSourceDigest: "a".repeat(64),
      agentExecutionSpecDigest: "b".repeat(64),
      credentialVersion: "credential-version-1",
      runtime: { generation: 1, executionId: "runtime-execution-1" },
      executionSpec: { model: { contextWindow: 32000 } },
    });
    expect(fetchFn).toHaveBeenCalledWith(
      new URL("http://agent-controller:8080/rpc/agent-controller/acquire-run"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          request_id: "request-1",
          agent_id: "agent-1",
          principal_id: "principal-1",
          expected_access_revision: "access-1",
          session_id: "session-1",
        }),
      }),
    );
  });

  it("preserves domain error code and retryability", async () => {
    const client = new AgentControllerClient({
      baseUrl: new URL("http://agent-controller:8080/rpc/agent-controller/"),
      fetchFn: vi.fn(() =>
        Promise.resolve(
          Response.json(
            { code: "agent_rebuilding", message: "Agent is rebuilding", retryable: true },
            { status: 409 },
          ),
        ),
      ),
      timeoutMs: 5_000,
    });

    const error = await client
      .acquireRun({
        requestId: "request-1",
        agentId: "agent-1",
        principalId: "principal-1",
        expectedAccessRevision: "access-1",
        sessionId: "session-1",
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AgentControllerError);
    expect(error).toMatchObject({ code: "agent_rebuilding", retryable: true });
  });

  it("maps unknown dependency error codes to one bounded failure", async () => {
    const client = new AgentControllerClient({
      baseUrl: new URL("http://agent-controller:8080/rpc/agent-controller/"),
      fetchFn: vi.fn(() =>
        Promise.resolve(
          Response.json(
            { code: "attacker_controlled_code", message: "unexpected", retryable: false },
            { status: 409 },
          ),
        ),
      ),
      timeoutMs: 5_000,
    });

    await expect(
      client.acquireRun({
        requestId: "request-1",
        agentId: "agent-1",
        principalId: "principal-1",
        expectedAccessRevision: "access-1",
        sessionId: "session-1",
      }),
    ).rejects.toMatchObject({ code: "dependency_unavailable" });
  });

  it("requires the contracted ready status response", async () => {
    const fetchFn = vi.fn(() => Promise.resolve(Response.json({ status: "ready" })));

    await expect(
      requireAgentControllerReady({
        serviceUrl: new URL("http://agent-controller:8080/"),
        fetchFn,
        timeoutMs: 5_000,
      }),
    ).resolves.toBeUndefined();
    expect(fetchFn).toHaveBeenCalledWith(
      new URL("http://agent-controller:8080/status"),
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("never retries an uncertain request inside the transport adapter", async () => {
    const fetchFn = vi.fn(() => Promise.reject(new TypeError("connection reset")));
    const client = new AgentControllerClient({
      baseUrl: new URL("http://agent-controller:8080/rpc/agent-controller/"),
      fetchFn,
      timeoutMs: 5_000,
    });

    await expect(
      client.acquireRun({
        requestId: "request-1",
        agentId: "agent-1",
        principalId: "principal-1",
        expectedAccessRevision: "access-1",
        sessionId: "session-1",
      }),
    ).rejects.toMatchObject({ code: "dependency_unavailable", retryable: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
