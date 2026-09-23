import { context, propagation, trace } from "@opentelemetry/api";
import { core, node, tracing } from "@opentelemetry/sdk-node";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { configureBoundaries } from "../../../../services/agent-acp-service/src/telemetry/diagnostics.js";
import { AgentAcpHttpServer } from "../../../../services/agent-acp-service/src/transport/http-server.js";
import { ExecutionAudits } from "../../../../services/agent-acp-service/src/application/execution-audit.js";
import type { ExecutionAuditRepository } from "../../../../services/agent-acp-service/src/ports/execution-audit.js";
import type { AcpApplicationPort } from "../../../../services/agent-acp-service/src/ports/acp-application.js";

const headers = {
  "content-type": "application/json",
  "X-Antnest-User-ID": "admin-1",
  "X-Antnest-Organization-ID": "org-1",
  "X-Antnest-Membership-ID": "membership-1",
  "X-Antnest-System-Role": "user",
  "X-Antnest-Organization-Role": "admin",
};
const listPath = "/rpc/agent-acp/list-execution-audits";
const getPath = "/rpc/agent-acp/get-execution-audit";
const eventsPath = "/rpc/agent-acp/list-execution-events";
const cleanup: Array<() => Promise<void>> = [];
const exporter = new tracing.InMemorySpanExporter();
const provider = new node.NodeTracerProvider({
  spanProcessors: [new tracing.SimpleSpanProcessor(exporter)],
});
beforeAll(() =>
  provider.register({ propagator: new core.W3CTraceContextPropagator() }),
);
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  exporter.reset();
  configureBoundaries({ captureRpcContent: false, disabled: false });
});
afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  propagation.disable();
});

async function setup(ready = true) {
  const unexpected = vi.fn(() =>
    Promise.reject(new Error("Audit queries must not execute ACP commands")),
  );
  const application: AcpApplicationPort = {
    assertAccess: unexpected,
    createSession: unexpected,
    listSessions: unexpected,
    resumeSession: unexpected,
    closeSession: unexpected,
    deleteSession: unexpected,
    forkSession: unexpected,
    cancelRun: unexpected,
    acceptPrompt: unexpected,
    readSessionOutput: unexpected,
    getSessionConfiguration: unexpected,
    setSessionConfiguration: unexpected,
  };
  const repository = {
    list: vi.fn<ExecutionAuditRepository["list"]>().mockResolvedValue([]),
    get: vi.fn<ExecutionAuditRepository["get"]>().mockResolvedValue(null),
    events: vi.fn<ExecutionAuditRepository["events"]>().mockResolvedValue([]),
    permissions: vi
      .fn<ExecutionAuditRepository["permissions"]>()
      .mockResolvedValue([]),
  };
  const server = new AgentAcpHttpServer({
    application,
    executionAudits: new ExecutionAudits(repository),
    ready: () => Promise.resolve(ready),
    maxWebSocketPayloadBytes: 4096,
    maxConfigurationBytes: 4096,
  });
  await server.listen("127.0.0.1", 0);
  cleanup.push(() => server.close());
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Missing address");
  const post = (
    path = listPath,
    input: unknown = {},
    override: Record<string, string> = {},
  ) =>
    fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: "POST",
      headers: { ...headers, ...override },
      body: JSON.stringify(input),
    });
  return {
    repository,
    unexpected,
    post,
    base: `http://127.0.0.1:${address.port}`,
  };
}

describe("administrative audit RPC boundary", () => {
  it("preserves opaque filters and results while retaining organization and role checks", async () => {
    const test = await setup();
    const summary = {
      run_id: "run+[1]",
      session_id: "session+[1]",
      agent_id: "agent/department+1",
      principal_id: "owner+team@example.org",
      state: "completed" as const,
      created_at: "2026-09-14T00:00:00Z",
      updated_at: "2026-09-14T00:00:01Z",
    };
    const identity = {
      "X-Antnest-User-ID": "admin+team@example.org",
      "X-Antnest-Organization-ID": "org+department@example.org",
      "X-Antnest-Membership-ID": "membership+[1]",
    };
    test.repository.list.mockResolvedValue([summary]);
    const response = await test.post(
      listPath,
      { agent_id: summary.agent_id },
      identity,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [summary],
      next_cursor: null,
    });
    expect(test.repository.list).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: identity["X-Antnest-Organization-ID"],
        agent_id: summary.agent_id,
      }),
      expect.any(AbortSignal),
    );
    expect(
      (await test.post(getPath, { run_id: summary.run_id }, identity)).status,
    ).toBe(404);
    test.repository.events.mockResolvedValue(null);
    expect(
      (await test.post(eventsPath, { run_id: summary.run_id }, identity))
        .status,
    ).toBe(404);
    test.repository.list.mockClear();
    expect(
      (
        await test.post(
          listPath,
          {},
          { ...identity, "X-Antnest-Organization-Role": "member" },
        )
      ).status,
    ).toBe(403);
    expect(test.repository.list).not.toHaveBeenCalled();
  });

  it("continues caller traces and records RPC content only when enabled", async () => {
    configureBoundaries({ captureRpcContent: true, disabled: false });
    const test = await setup();
    const traceId = "11111111111111111111111111111111";
    const parent = "2222222222222222";
    const response = await test.post(
      getPath,
      { run_id: "missing" },
      {
        traceparent: `00-${traceId}-${parent}-01`,
      },
    );
    expect(response.status).toBe(404);
    await response.json();
    await vi.waitFor(() => expect(exporter.getFinishedSpans()).toHaveLength(1));
    const span = exporter.getFinishedSpans()[0]!;
    expect(span.spanContext().traceId).toBe(traceId);
    expect(span.parentSpanContext?.spanId).toBe(parent);
    expect(span.attributes).toMatchObject({
      "http.route": getPath,
      "rpc.method": "get_execution_audit",
      "antnest.organization.id": "org-1",
      "antnest.error.code": "audit_not_found",
    });
    expect(
      span.events.filter((event) => event.name === "antnest.request"),
    ).toEqual([
      expect.objectContaining({
        attributes: { "antnest.payload.json": '{"run_id":"missing"}' },
      }),
    ]);
    expect(span.events.some((event) => event.name === "antnest.response")).toBe(
      true,
    );
    configureBoundaries({ captureRpcContent: false, disabled: false });
    await (await test.post()).json();
    await vi.waitFor(() => expect(exporter.getFinishedSpans()).toHaveLength(2));
    expect(
      exporter
        .getFinishedSpans()[1]!
        .events.some((event) =>
          ["antnest.request", "antnest.response"].includes(event.name),
        ),
    ).toBe(false);
  });
  it("uses the existing trusted management context with no Agent execution headers", async () => {
    const test = await setup();
    const response = await test.post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [], next_cursor: null });
    expect(test.repository.list).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-1" }),
      expect.any(AbortSignal),
    );
    expect(test.unexpected).not.toHaveBeenCalled();
  });

  it.each([
    ["X-Antnest-System-Role", "root"],
    ["X-Antnest-Organization-ID", ""],
    ["X-Antnest-Membership-ID", ""],
  ])("rejects malformed trusted identity %s", async (key, value) => {
    const test = await setup();
    const response = await test.post(listPath, {}, { [key]: value });
    expect(response.status).toBe(401);
    expect(test.repository.list).not.toHaveBeenCalled();
  });

  it("rejects ordinary owner access and body-supplied identity escalation", async () => {
    const test = await setup();
    expect(
      (
        await test.post(
          listPath,
          {},
          { "X-Antnest-Organization-Role": "member" },
        )
      ).status,
    ).toBe(403);
    expect(
      (await test.post(listPath, { organization_id: "org-2", admin: true }))
        .status,
    ).toBe(400);
    expect(test.repository.list).not.toHaveBeenCalled();
  });

  it("keeps unknown and out-of-scope Runs indistinguishable", async () => {
    const test = await setup();
    test.repository.events.mockResolvedValue(null);
    expect((await test.post(getPath, { run_id: "other-run" })).status).toBe(
      404,
    );
    expect((await test.post(eventsPath, { run_id: "other-run" })).status).toBe(
      404,
    );
    expect(test.unexpected).not.toHaveBeenCalled();
  });

  it("serves both existing event stores without execution side effects", async () => {
    const test = await setup();
    expect(
      await (await test.post(eventsPath, { run_id: "run-1" })).json(),
    ).toEqual({
      stream: "execution",
      items: [],
      next_cursor: null,
    });
    expect(
      await (
        await test.post(eventsPath, { run_id: "run-1", stream: "permissions" })
      ).json(),
    ).toEqual({ stream: "permissions", items: [], next_cursor: null });
    expect(test.repository.permissions).toHaveBeenCalledOnce();
    expect(test.unexpected).not.toHaveBeenCalled();
  });

  it("reports store failures without leaking SQL or fabricating empty results", async () => {
    const test = await setup();
    test.repository.list.mockRejectedValue(
      new Error("secret SELECT * FROM private_data"),
    );
    const response = await test.post();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: "execution_audit_unavailable",
      message: "Execution audit is unavailable",
      retryable: true,
    });
  });

  it("applies the common request-body boundary and readiness checks", async () => {
    const test = await setup(false);
    expect((await test.post()).status).toBe(503);
    expect((await fetch(test.base + listPath, { headers })).status).toBe(405);
    expect(
      (await test.post(listPath, {}, { "content-type": "text/plain" })).status,
    ).toBe(415);
    expect(
      (await test.post(listPath, { cursor: "x".repeat(5000) })).status,
    ).toBe(413);
    expect(test.repository.list).not.toHaveBeenCalled();
  });
});
