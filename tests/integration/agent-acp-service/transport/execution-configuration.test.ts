import {
  testAuthentication,
  workloadHeaders,
} from "../../../../services/agent-acp-service/test/support/auth-fixture.js";
import { context, propagation, trace } from "@opentelemetry/api";
import { core, node, tracing } from "@opentelemetry/sdk-node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { AgentAcpHttpServer } from "../../../../services/agent-acp-service/src/transport/http-server.js";
import {
  configureBoundaries,
  rpcContent,
} from "../../../../services/agent-acp-service/src/telemetry/diagnostics.js";
import { DomainError } from "../../../../services/agent-acp-service/src/domain/errors.js";
import { localExecution } from "../../../../services/agent-acp-service/test/support/local-execution.js";
import {
  executionConfiguration,
  executionIdentity,
} from "../../../../services/agent-acp-service/test/fixtures/execution-configuration.js";
import type { AcpApplicationPort } from "../../../../services/agent-acp-service/src/ports/acp-application.js";
import type { ExecutionDirectory } from "../../../../services/agent-acp-service/src/application/execution-directory.js";

const route = "/rpc/agent-acp/apply-execution-snapshot";
const exporter = new tracing.InMemorySpanExporter();
const provider = new node.NodeTracerProvider({
  spanProcessors: [new tracing.SimpleSpanProcessor(exporter)],
});
let server: AgentAcpHttpServer | undefined;

beforeAll(() =>
  provider.register({ propagator: new core.W3CTraceContextPropagator() }),
);
beforeEach(() => {
  exporter.reset();
  configureBoundaries({ captureRpcContent: true, disabled: false });
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  configureBoundaries({ captureRpcContent: false, disabled: false });
});
afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  propagation.disable();
});

describe("execution configuration HTTP contract", () => {
  it("keeps the current revision when an authenticated Controller republishes an older snapshot", async () => {
    const local = await localExecution();
    const url = await listen(local.directory);
    const current = executionConfiguration();
    current.revision = 2;
    current.agents[0]!.system_prompt = "current revision";
    const applied = await post(url, current);
    expect(applied.status).toBe(200);
    await applied.text();
    const stale = await post(url, executionConfiguration());
    expect(stale.status).toBe(200);
    expect(await stale.json()).toMatchObject({ applied_revision: 2 });
    expect(
      local.directory.inspect(executionIdentity()).configuration.revision,
    ).toBe(2);
    expect(
      local.directory.inspect(executionIdentity()).agent.system_prompt,
    ).toBe("current revision");
  });
  it("applies a complete snapshot through the real directory and acknowledges only publication", async () => {
    const local = await localExecution(false);
    const published = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    local.onApplied.mockImplementation(() => {
      published.resolve();
      return release.promise;
    });
    const url = await listen(local.directory);
    let responded = false;
    const response = post(url, executionConfiguration()).then((value) => {
      responded = true;
      return value;
    });
    try {
      await published.promise;
      expect(responded).toBe(false);
    } finally {
      release.resolve();
    }
    const accepted = await response;
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({
      organization_id: "organization-1",
      applied_revision: 1,
    });
    await expect(
      local.directory.withAccess(executionIdentity(), ({ agent }) =>
        Promise.resolve(agent.agent_id),
      ),
    ).resolves.toBe("agent-1");
    expect(JSON.stringify([...local.configurations.values()])).not.toContain(
      "synthetic-provider-key",
    );
  });

  it("returns conflicts without replacing the accepted directory", async () => {
    const local = await localExecution();
    const url = await listen(local.directory);
    const different = executionConfiguration();
    different.agents[0]!.system_prompt = "changed without revision";
    const response = await post(url, different);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "configuration_conflict",
      retryable: false,
    });
    expect(
      local.configurations.get("organization-1")?.agents[0]?.system_prompt,
    ).not.toContain("without revision");
  });

  it("returns a generic failure without publishing when persistence rejects a value", async () => {
    const local = await localExecution();
    local.onApplied.mockClear();
    vi.spyOn(local.repository, "save").mockRejectedValueOnce(
      new Error("unsupported Unicode escape sequence: synthetic-provider-key"),
    );
    const input = executionConfiguration();
    input.revision = 2;
    input.agents[0]!.principal_ids = ["principal\u0000invalid"];
    const url = await listen(local.directory);
    const response = await post(url, input);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: "configuration_unavailable",
      message: "Execution configuration could not be applied",
      retryable: true,
    });
    expect(local.onApplied).not.toHaveBeenCalled();
    expect(
      local.directory.inspect(executionIdentity()).configuration.revision,
    ).toBe(1);
  });

  it("leaves access closed when publication fails and repairs it on equal-revision retry", async () => {
    const local = await localExecution();
    const input = executionConfiguration();
    input.revision = 2;
    input.agents[0]!.principal_ids = [];
    local.onApplied.mockRejectedValueOnce(
      new Error("synthetic-provider-key must not leak"),
    );
    const url = await listen(local.directory);
    const failed = await post(url, input);
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({
      code: "configuration_unavailable",
      message: "Execution configuration could not be applied",
      retryable: true,
    });
    await expect(
      local.directory.withAccess(executionIdentity(), () => Promise.resolve()),
    ).rejects.toMatchObject({ code: "configuration_not_ready" });
    const repaired = await post(url, input);
    expect(repaired.status).toBe(200);
    await repaired.text();
    await expect(
      local.directory.withAccess(executionIdentity(), () => Promise.resolve()),
    ).rejects.toMatchObject({ code: "access_denied" });
  });

  it.each([
    [
      "invalid JSON",
      '{"secret":"synthetic-provider-key",',
      "application/json",
      400,
    ],
    [
      "invalid configuration",
      JSON.stringify({ secret: "synthetic-provider-key" }),
      "application/json",
      400,
    ],
    ["non-JSON content", "synthetic-provider-key", "text/plain", 415],
  ])("rejects %s without publishing", async (_label, body, type, status) => {
    const local = await localExecution(false);
    const url = await listen(local.directory);
    const response = await fetch(`${url}${route}`, {
      method: "POST",
      headers: {
        ...workloadHeaders("agent-controller"),
        "content-type": String(type),
      },
      body: String(body),
    });
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain("synthetic-provider-key");
    expect(local.onApplied).not.toHaveBeenCalled();
  });

  it("rejects oversized and encoded bodies without publishing", async () => {
    const apply = vi.fn<ExecutionDirectory["apply"]>();
    const url = await listen({ apply }, 32);
    const oversized = await fetch(`${url}${route}`, {
      method: "POST",
      headers: {
        ...workloadHeaders("agent-controller"),
        "content-type": "application/json",
      },
      body: "a".repeat(64),
    });
    expect(oversized.status).toBe(413);
    await oversized.text();
    const encoded = await fetch(`${url}${route}`, {
      method: "POST",
      headers: {
        ...workloadHeaders("agent-controller"),
        "content-type": "application/json",
        "content-encoding": "gzip",
      },
      body: "{}",
    });
    expect(encoded.status).toBe(415);
    await encoded.text();
    expect(apply).not.toHaveBeenCalled();
  });

  it("does not pretend a missing publisher succeeded or expose obsolete RPC methods", async () => {
    const url = await listen();
    const missing = await post(url, executionConfiguration());
    expect(missing.status).toBe(503);
    await missing.text();
    const method = await fetch(`${url}${route}`, {
      headers: workloadHeaders("agent-controller"),
    });
    expect(method.status).toBe(403);
    expect(method.headers.get("allow")).toBeNull();
    await method.text();
    const obsolete = await fetch(`${url}/rpc/agent-acp/acquire-run`, {
      method: "POST",
    });
    expect(obsolete.status).toBe(404);
    await obsolete.text();
  });

  it.each(["success", "validation", "dependency"] as const)(
    "records the caller trace and safe diagnostics without credentials on %s",
    async (outcome) => {
      const local = await localExecution(false);
      if (outcome === "dependency")
        local.onApplied.mockRejectedValue(new Error("synthetic-provider-key"));
      const url = await listen(local.directory);
      const parent = provider.getTracer("test").startSpan("caller");
      rpcContent(parent, "request", { control: "non-secret-positive-control" });
      const carrier: Record<string, string> = {};
      propagation.inject(trace.setSpan(context.active(), parent), carrier);
      const response = await post(
        url,
        outcome === "validation"
          ? { secret: "synthetic-provider-key" }
          : executionConfiguration(),
        carrier,
      );
      const text = await response.text();
      parent.end();
      await vi.waitFor(() =>
        expect(exporter.getFinishedSpans()).toHaveLength(2),
      );
      const spans = exporter.getFinishedSpans();
      const request = spans.find(
        (span) => span.attributes["rpc.method"] === "apply_execution_snapshot",
      );
      expect(request?.parentSpanContext?.spanId).toBe(
        parent.spanContext().spanId,
      );
      expect(request?.attributes["http.route"]).toBe(route);
      expect(request?.attributes["http.response.status_code"]).toBe(
        outcome === "success" ? 200 : outcome === "validation" ? 400 : 503,
      );
      const observed = JSON.stringify(
        spans.map((span) => ({
          attributes: span.attributes,
          events: span.events,
        })),
      );
      expect(observed).toContain("non-secret-positive-control");
      expect(observed + text).not.toContain("synthetic-provider-key");
      expect(
        request?.events.some((event) =>
          event.name.startsWith("antnest.request"),
        ),
      ).toBe(false);
      if (outcome !== "success")
        expect(request?.attributes["error.type"]).toBeDefined();
    },
  );
});

async function listen(
  configuration?: Pick<ExecutionDirectory, "apply">,
  maxConfigurationBytes = 16 * 1024 * 1024,
) {
  server = new AgentAcpHttpServer({
    authentication: testAuthentication(),
    ...(configuration === undefined
      ? {}
      : { executionConfiguration: configuration }),
    maxConfigurationBytes,
    application: unusedApplication(),
    ready: () => Promise.resolve(true),
    maxWebSocketPayloadBytes: 1024,
  });
  await server.listenControl("127.0.0.1", 0);
  const address = server.controlAddress();
  if (address === null || typeof address === "string")
    throw new Error("Expected TCP address");
  return `http://127.0.0.1:${address.port}`;
}

function post(
  url: string,
  input: unknown,
  headers: Record<string, string> = {},
) {
  return fetch(`${url}${route}`, {
    method: "POST",
    headers: {
      ...workloadHeaders("agent-controller"),
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
    body: JSON.stringify(input),
  });
}

function unusedApplication(): AcpApplicationPort {
  const unexpected = () =>
    Promise.reject(
      new DomainError(
        "unexpected_acp_call",
        "Configuration must not invoke ACP resource methods",
      ),
    );
  return {
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
}
