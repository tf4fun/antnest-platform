import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { AgentAcpHttpServer } from "../../src/transport/http-server.js";
import { parseExecutionDelta } from "../../src/domain/execution-publication-v2.js";
import { DomainError } from "../../src/domain/errors.js";
import type { ExecutionConfigurationPort } from "../../src/ports/execution-configuration.js";
import { testAuthentication, workloadHeaders } from "../support/auth-fixture.js";

const canary = "synthetic-canary-secret";

function v2Delta() {
  return {
    schema_version: 2,
    organization_id: "organization-1",
    base_revision: 1,
    revision: 2,
    providers: { upserts: [], deletes: [] },
    models: { upserts: [], deletes: [] },
    agents: { upserts: [], deletes: [] },
    organization_budget: null,
  };
}

function digestShape() {
  return {
    organization_id: "organization-1",
    schema_version: 2,
    revision: 2,
    digest: "ab".repeat(32),
    providers: [],
    models: [],
    agents: [],
    organization_budget_digest: null,
  };
}

function portStub(overrides: Partial<ExecutionConfigurationPort> = {}) {
  const applyDelta = vi.fn((input: unknown) => {
    const delta = parseExecutionDelta(input);
    return Promise.resolve({
      organization_id: delta.organization_id,
      applied_revision: delta.revision,
    });
  });
  const getDigest = vi.fn(() => Promise.resolve(digestShape()));
  return {
    port: {
      applyDelta,
      getDigest,
      ...overrides,
    } as ExecutionConfigurationPort,
    applyDelta,
    getDigest,
  };
}

async function post(
  url: string,
  body: string,
  caller = "agent-controller",
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...workloadHeaders(caller), ...headers },
    body,
  });
  return { status: response.status, text: await response.text() };
}

describe("execution publication v2 transport", () => {
  let server: AgentAcpHttpServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  async function controlPort(publisher: ExecutionConfigurationPort) {
    server = new AgentAcpHttpServer({
      authentication: testAuthentication(),
      application: {} as never,
      executionConfiguration: publisher,
      ready: () => Promise.resolve(true),
      maxConfigurationBytes: 256,
      maxWebSocketPayloadBytes: 64 * 1024,
    });
    await server.listen("127.0.0.1", 0);
    await server.listenControl("127.0.0.1", 0);
    const control = server.controlAddress();
    const workspace = server.address();
    if (control === null || typeof control === "string") throw new Error("no control listener");
    if (workspace === null || typeof workspace === "string")
      throw new Error("no workspace listener");
    return {
      control: `http://127.0.0.1:${control.port}`,
      workspace: `http://127.0.0.1:${workspace.port}`,
    };
  }

  it("accepts authenticated Controller delta and digest on the control listener without CCT", async () => {
    const publisher = portStub();
    const { control } = await controlPort(publisher.port);
    const delta = await post(
      `${control}/rpc/agent-acp/apply-execution-delta`,
      JSON.stringify(v2Delta()),
    );
    expect(delta.status).toBe(200);
    expect(JSON.parse(delta.text)).toMatchObject({ applied_revision: 2 });
    const digest = await post(
      `${control}/rpc/agent-acp/get-execution-digest`,
      JSON.stringify({ organization_id: "organization-1" }),
    );
    expect(digest.status).toBe(200);
    expect(JSON.parse(digest.text)).toMatchObject({ revision: 2, schema_version: 2 });
    expect(JSON.stringify(digest.text)).not.toContain(canary);
  });

  it("rejects delta/digest on the workspace listener and foreign workloads", async () => {
    const publisher = portStub();
    const { workspace, control } = await controlPort(publisher.port);
    for (const path of [
      "/rpc/agent-acp/apply-execution-delta",
      "/rpc/agent-acp/get-execution-digest",
    ]) {
      const onWorkspace = await post(`${workspace}${path}`, JSON.stringify(v2Delta()));
      expect(onWorkspace.status).toBe(404);
      for (const caller of ["agent-ui", "admin-console", "skill-registry"]) {
        const response = await post(`${control}${path}`, JSON.stringify(v2Delta()), caller);
        expect(response.status).toBe(403);
      }
    }
    expect(publisher.applyDelta).not.toHaveBeenCalled();
    expect(publisher.getDigest).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON, query strings and unknown bodies before the port", async () => {
    const publisher = portStub();
    const { control } = await controlPort(publisher.port);
    const malformed = await post(`${control}/rpc/agent-acp/apply-execution-delta`, "{not json");
    expect(malformed.status).toBe(400);
    const queried = await post(
      `${control}/rpc/agent-acp/get-execution-digest?x=1`,
      JSON.stringify({ organization_id: "organization-1" }),
    );
    expect(queried.status).toBe(403);
    const oversized = await post(`${control}/rpc/agent-acp/apply-execution-delta`, " ".repeat(400));
    expect(oversized.status).toBe(413);
    expect(publisher.applyDelta).not.toHaveBeenCalled();
    expect(publisher.getDigest).not.toHaveBeenCalled();
  });

  it("maps base mismatch to 409, unknown errors to sanitized 503, absent port to 503", async () => {
    const publisher = portStub({
      applyDelta: vi.fn(() =>
        Promise.reject(new DomainError("configuration_base_mismatch", "stale base")),
      ),
      getDigest: vi.fn(() => Promise.reject(new Error(`storage exploded ${canary}`))),
    });
    const { control } = await controlPort(publisher.port);
    const delta = await post(
      `${control}/rpc/agent-acp/apply-execution-delta`,
      JSON.stringify(v2Delta()),
    );
    expect(delta.status).toBe(409);
    const digest = await post(
      `${control}/rpc/agent-acp/get-execution-digest`,
      JSON.stringify({ organization_id: "organization-1" }),
    );
    expect(digest.status).toBe(503);
    expect(digest.text).not.toContain(canary);
    const absent = portStub();
    delete (absent.port as { getDigest?: unknown }).getDigest;
    await server?.close();
    const { control: control2 } = await controlPort(absent.port);
    const missing = await post(
      `${control2}/rpc/agent-acp/get-execution-digest`,
      JSON.stringify({ organization_id: "organization-1" }),
    );
    expect(missing.status).toBe(503);
  });

  it("registers both routes in callers.json and the mismatch error contract", () => {
    const callers = JSON.parse(
      readFileSync(
        new URL("../../../../contracts/agent-acp/callers.json", import.meta.url),
        "utf8",
      ),
    ) as { routes: Record<string, { callers: string[] }> };
    const routes = callers.routes;
    for (const path of [
      "POST /rpc/agent-acp/apply-execution-delta",
      "POST /rpc/agent-acp/get-execution-digest",
    ]) {
      expect(routes[path]?.callers).toEqual(["agent-controller"]);
      expect(routes[path]).toEqual(routes["POST /rpc/agent-acp/apply-execution-snapshot"]);
    }
    const errors = JSON.parse(
      readFileSync(new URL("../../../../contracts/agent-acp/errors.json", import.meta.url), "utf8"),
    ) as { errors: Record<string, { http_status: number; retryable: boolean }> };
    expect(errors.errors["configuration_base_mismatch"]).toMatchObject({
      http_status: 409,
      retryable: false,
    });
  });
});
