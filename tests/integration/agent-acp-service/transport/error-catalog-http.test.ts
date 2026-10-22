import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSettlement } from "../../../../services/agent-acp-service/src/application/agent-settlement.js";
import { ExecutionAudits } from "../../../../services/agent-acp-service/src/application/execution-audit.js";
import { DomainError } from "../../../../services/agent-acp-service/src/domain/errors.js";
import { SkillSourceError } from "../../../../services/agent-acp-service/src/domain/skill-source.js";
import type { AcpApplicationPort } from "../../../../services/agent-acp-service/src/ports/acp-application.js";
import type { AgentExecutionStatePort } from "../../../../services/agent-acp-service/src/ports/agent-execution-state.js";
import type { ExecutionAuditRepository } from "../../../../services/agent-acp-service/src/ports/execution-audit.js";
import type { ExecutionConfigurationPort } from "../../../../services/agent-acp-service/src/ports/execution-configuration.js";
import {
  AgentAcpHttpServer,
  type AgentAcpHttpServerOptions,
} from "../../../../services/agent-acp-service/src/transport/http-server.js";
import { executionConfiguration } from "../../../../services/agent-acp-service/test/fixtures/execution-configuration.js";
import {
  testAuthentication,
  testHeaders,
  workloadHeaders,
} from "../../../../services/agent-acp-service/test/support/auth-fixture.js";
import { localExecution } from "../../../../services/agent-acp-service/test/support/local-execution.js";

type CatalogEntry = {
  http_status: number;
  message: string;
  retryable: boolean;
  retry_after_ms?: number;
};
// Expectations come from the shared wire contract, never the production mapper.
const catalog = JSON.parse(
  readFileSync(
    new URL("../../../../contracts/agent-acp/errors.json", import.meta.url),
    "utf8",
  ),
) as { errors: Record<string, CatalogEntry> };
const secret = "synthetic-http-catalog-private-secret";
const auditPath = "/rpc/agent-acp/list-execution-audits";
const configurationPath = "/rpc/agent-acp/apply-execution-snapshot";
const settlementPath = "/rpc/agent-acp/settle-agent";
const statePath = "/rpc/agent-acp/get-agent-execution-state";
const watchPath = "/rpc/agent-acp/watch-agent-execution-state";
let server: AgentAcpHttpServer | undefined;

afterEach(async () => {
  const closing = server;
  server = undefined;
  await closing?.close();
});

type RouteOptions = Pick<
  AgentAcpHttpServerOptions,
  | "executionAudits"
  | "executionConfiguration"
  | "settlement"
  | "executionState"
  | "skillSources"
  | "bridgeObservation"
  | "learningStatus"
  | "learningChanges"
  | "maxConfigurationBytes"
>;

async function listen(
  options: RouteOptions = {},
  listener: "workspace" | "control" = "workspace",
) {
  const unexpected = () =>
    Promise.reject(new Error("Error projection must not execute ACP commands"));
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
  server = new AgentAcpHttpServer({
    authentication: testAuthentication(),
    application,
    ready: () => Promise.resolve(true),
    maxWebSocketPayloadBytes: 1024,
    maxConfigurationBytes: 16 * 1024,
    ...options,
  });
  if (listener === "control") await server.listenControl("127.0.0.1", 0);
  else await server.listen("127.0.0.1", 0);
  const address =
    listener === "control" ? server.controlAddress() : server.address();
  if (address === null || typeof address === "string")
    throw new Error("Expected TCP listener");
  return `http://127.0.0.1:${address.port}`;
}

function post(
  base: string,
  path: string,
  headers: Record<string, string>,
  body = "{}",
) {
  return fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
    signal: AbortSignal.timeout(3000),
  });
}

async function jsonResponse(response: Response) {
  // Drain every response before assertions, including expected failures.
  const text = await response.text();
  const body: unknown = JSON.parse(text);
  return { response, text, body };
}

function definition(code: string) {
  const value = catalog.errors[code];
  if (value === undefined) throw new Error(`Missing catalog entry ${code}`);
  return value;
}

function expectedBody(code: string) {
  const value = definition(code);
  return {
    code,
    message: value.message,
    retryable: value.retryable,
    ...(value.retry_after_ms === undefined
      ? {}
      : { retry_after_ms: value.retry_after_ms }),
  };
}

function assertFailure(
  received: Awaited<ReturnType<typeof jsonResponse>>,
  code: string,
) {
  expect(received.response.status).toBe(definition(code).http_status);
  expect(received.body).toEqual(expectedBody(code));
  expect(received.text).not.toContain(secret);
}

function auditHeaders(role = "admin") {
  return testHeaders({ "x-antnest-organization-role": role }, "admin-console");
}

function workspaceHeaders() {
  return testHeaders({ "x-antnest-agent-id": "agent-1" });
}

function get(base: string, path: string) {
  return fetch(base + path, {
    headers: workspaceHeaders(),
    signal: AbortSignal.timeout(3000),
  });
}

describe("read-only workspace error catalog projection", () => {
  it.each([
    [new DomainError("session_access_denied", secret), "session_not_found"],
    [new DomainError("session_not_found", secret), "session_not_found"],
    [new DomainError("access_denied", secret), "access_denied"],
    [new Error(secret), "workspace_observation_unavailable"],
  ] as const)("retains Bridge classification for %s", async (error, code) => {
    const readSession = vi.fn(() => Promise.reject(error));
    const readIntent = vi.fn(() =>
      Promise.reject(new Error("Unexpected intent read")),
    );
    const base = await listen({
      bridgeObservation: { readSession, readIntent },
    });
    const received = await jsonResponse(
      await get(base, "/rpc/agent-acp/workspace/sessions/session-1/execution"),
    );
    assertFailure(received, code);
    expect(readSession).toHaveBeenCalledOnce();
    expect(readIntent).not.toHaveBeenCalled();
    expect(received.response.headers.get("cache-control")).toBe("no-store");
  });

  it("keeps an unobserved intent non-retryable without exposing a cause", async () => {
    const readIntent = vi.fn(() => Promise.resolve(null));
    const readSession = vi.fn(() =>
      Promise.reject(new Error("Unexpected session read")),
    );
    const base = await listen({
      bridgeObservation: { readSession, readIntent },
    });
    const received = await jsonResponse(
      await get(
        base,
        "/rpc/agent-acp/workspace/sessions/session-1/intents/intent-1",
      ),
    );
    assertFailure(received, "intent_unknown");
    expect(readIntent).toHaveBeenCalledOnce();
    expect(readSession).not.toHaveBeenCalled();
  });

  for (const kind of ["learning-status", "learning-changes"] as const) {
    it.each([
      [new DomainError("access_denied", secret), "agent_not_found"],
      [
        new Error(secret),
        kind === "learning-status"
          ? "learning_status_unavailable"
          : "learning_changes_unavailable",
      ],
    ] as const)(
      `${kind} keeps its non-enumerating classification for %s`,
      async (error, code) => {
        const read = vi.fn(() => Promise.reject(error));
        const list = vi.fn(() => Promise.reject(error));
        const base = await listen({
          learningStatus: { read },
          learningChanges: { list },
        });
        const received = await jsonResponse(
          await get(base, `/rpc/agent-acp/workspace/agents/agent-1/${kind}`),
        );
        assertFailure(received, code);
        expect(kind === "learning-status" ? read : list).toHaveBeenCalledOnce();
        expect(kind === "learning-status" ? list : read).not.toHaveBeenCalled();
        expect(received.response.headers.get("cache-control")).toBe("no-store");
      },
    );

    it(`${kind} rejects a credential bound to another Agent before invoking its reader`, async () => {
      const read = vi.fn(() => Promise.reject(new Error(secret)));
      const list = vi.fn(() => Promise.reject(new Error(secret)));
      const base = await listen({
        learningStatus: { read },
        learningChanges: { list },
      });
      const received = await jsonResponse(
        await get(base, `/rpc/agent-acp/workspace/agents/other-agent/${kind}`),
      );
      assertFailure(received, "caller_context_invalid");
      expect(read).not.toHaveBeenCalled();
      expect(list).not.toHaveBeenCalled();
    });

    it(`${kind} rejects a forbidden method at authentication before invoking the reader`, async () => {
      const read = vi.fn(() => Promise.reject(new Error(secret)));
      const list = vi.fn(() => Promise.reject(new Error(secret)));
      const base = await listen({
        learningStatus: { read },
        learningChanges: { list },
      });
      const received = await jsonResponse(
        await post(
          base,
          `/rpc/agent-acp/workspace/agents/agent-1/${kind}`,
          workspaceHeaders(),
        ),
      );
      assertFailure(received, "caller_not_allowed");
      expect(received.response.headers.get("allow")).toBeNull();
      expect(read).not.toHaveBeenCalled();
      expect(list).not.toHaveBeenCalled();
    });
  }

  it("retains the learning cursor conflict without exposing internal cursor text", async () => {
    const list = vi.fn(() =>
      Promise.reject(new DomainError("cursor_expired", secret)),
    );
    const base = await listen({ learningChanges: { list } });
    const received = await jsonResponse(
      await get(
        base,
        "/rpc/agent-acp/workspace/agents/agent-1/learning-changes",
      ),
    );
    assertFailure(received, "cursor_expired");
    expect(list).toHaveBeenCalledOnce();
  });
});

async function auditFixture() {
  const repository = {
    list: vi.fn<ExecutionAuditRepository["list"]>().mockResolvedValue([]),
    get: vi.fn<ExecutionAuditRepository["get"]>().mockResolvedValue(null),
    events: vi.fn<ExecutionAuditRepository["events"]>().mockResolvedValue([]),
    permissions: vi
      .fn<ExecutionAuditRepository["permissions"]>()
      .mockResolvedValue([]),
  };
  const service = new ExecutionAudits(repository);
  const list = vi.spyOn(service, "list");
  const base = await listen({ executionAudits: service });
  return { base, repository, list };
}

describe("HTTP error catalog projection", () => {
  it.each([
    "access_denied",
    "audit_not_found",
    "invalid_cursor",
    "invalid_request",
  ])("sanitizes whitelisted audit DomainError %s", async (code) => {
    const fixture = await auditFixture();
    fixture.repository.list.mockRejectedValue(new DomainError(code, secret));
    const received = await jsonResponse(
      await post(fixture.base, auditPath, auditHeaders()),
    );
    assertFailure(received, code);
    expect(fixture.repository.list).toHaveBeenCalledOnce();
    expect(received.response.headers.get("connection")).toBe("close");
  });

  it("retains the audit dependency classification for unknown store failures", async () => {
    const fixture = await auditFixture();
    fixture.repository.list.mockRejectedValue(new Error(secret));
    const received = await jsonResponse(
      await post(fixture.base, auditPath, auditHeaders()),
    );
    assertFailure(received, "execution_audit_unavailable");
    expect(fixture.repository.list).toHaveBeenCalledOnce();
  });

  it.each([
    ["missing service credentials", {}, "service_unauthenticated"],
    [
      "missing caller context",
      workloadHeaders("admin-console"),
      "caller_context_required",
    ],
  ] as const)(
    "keeps %s as authentication 401",
    async (_label, headers, code) => {
      const fixture = await auditFixture();
      const received = await jsonResponse(
        await post(fixture.base, auditPath, headers),
      );
      assertFailure(received, code);
      expect(received.response.status).toBe(401);
      expect(received.response.headers.get("www-authenticate")).toBe(
        code === "service_unauthenticated"
          ? 'Bearer realm="antnest-service"'
          : null,
      );
      expect(received.response.headers.get("connection")).toBe("close");
      expect(fixture.list).not.toHaveBeenCalled();
      expect(fixture.repository.list).not.toHaveBeenCalled();
    },
  );

  it("keeps a verified non-admin's business access_denied at 403", async () => {
    const fixture = await auditFixture();
    const received = await jsonResponse(
      await post(fixture.base, auditPath, auditHeaders("member")),
    );
    assertFailure(received, "access_denied");
    expect(received.response.headers.get("www-authenticate")).toBeNull();
    expect(fixture.list).toHaveBeenCalledOnce();
    expect(fixture.repository.list).not.toHaveBeenCalled();
  });

  it.each([statePath, watchPath])(
    "returns 403 for authenticated state denial before headers at %s",
    async (path) => {
      const error = new DomainError("access_denied", secret);
      const read = vi
        .fn<AgentExecutionStatePort["read"]>()
        .mockRejectedValue(error);
      const watch = vi
        .fn<AgentExecutionStatePort["watch"]>()
        .mockRejectedValue(error);
      const base = await listen({ executionState: { read, watch } });
      const received = await jsonResponse(
        await post(base, path, workspaceHeaders()),
      );
      assertFailure(received, "access_denied");
      expect(received.response.headers.get("www-authenticate")).toBeNull();
      expect(path === statePath ? read : watch).toHaveBeenCalledOnce();
      expect(path === statePath ? watch : read).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "malformed JSON",
      `{"secret":"${secret}",`,
      {},
      "invalid_execution_configuration",
    ],
    ["oversized body", "x".repeat(257), {}, "configuration_too_large"],
    [
      "unsupported media",
      secret,
      { "content-type": "text/plain" },
      "unsupported_media_type",
    ],
    [
      "encoded body",
      "{}",
      { "content-encoding": "gzip" },
      "unsupported_media_type",
    ],
  ] as const)(
    "preserves the configuration-specific boundary for %s",
    async (_label, body, headers, code) => {
      const apply = vi.fn<ExecutionConfigurationPort["apply"]>();
      const base = await listen(
        { executionConfiguration: { apply }, maxConfigurationBytes: 256 },
        "control",
      );
      const received = await jsonResponse(
        await post(
          base,
          configurationPath,
          { ...workloadHeaders("agent-controller"), ...headers },
          body,
        ),
      );
      assertFailure(received, code);
      expect(apply).not.toHaveBeenCalled();
      expect(received.response.headers.get("connection")).toBe("close");
    },
  );

  it.each([
    [
      new DomainError("invalid_execution_configuration", secret),
      "invalid_execution_configuration",
    ],
    [
      new DomainError("configuration_conflict", secret),
      "configuration_conflict",
    ],
    [new Error(secret), "configuration_unavailable"],
  ] as const)(
    "keeps classified configuration failures and the dependency 503 default: %s",
    async (error, code) => {
      const apply = vi
        .fn<ExecutionConfigurationPort["apply"]>()
        .mockRejectedValue(error);
      const base = await listen(
        { executionConfiguration: { apply } },
        "control",
      );
      const received = await jsonResponse(
        await post(
          base,
          configurationPath,
          workloadHeaders("agent-controller"),
          JSON.stringify(executionConfiguration()),
        ),
      );
      assertFailure(received, code);
      expect(apply).toHaveBeenCalledOnce();
      expect(received.body).not.toHaveProperty("applied_revision");
    },
  );

  it("maps a real cold settlement directory to settlement_unavailable", async () => {
    const local = await localExecution(false);
    const quiesceAgent = vi.fn(() => Promise.resolve(true));
    const closeForLifecycle = vi.fn(() => Promise.resolve(true));
    const hasUnstoppedRuntimeCalls = vi.fn(() => Promise.resolve(false));
    const service = new AgentSettlement({
      directory: local.directory,
      supervisor: { quiesceAgent, stopSignal: new AbortController().signal },
      learning: { closeForLifecycle },
      protection: { hasUnstoppedRuntimeCalls },
      now: () => new Date(),
    });
    const settle = vi.spyOn(service, "settle");
    const base = await listen({ settlement: service }, "control");
    const received = await jsonResponse(
      await post(
        base,
        settlementPath,
        workloadHeaders("agent-controller"),
        JSON.stringify({
          organization_id: "organization-1",
          agent_id: "agent-1",
          minimum_revision: 1,
          operation_id: "operation-1",
          mode: "wait",
          deadline_at: new Date(Date.now() + 5000).toISOString(),
        }),
      ),
    );
    assertFailure(received, "settlement_unavailable");
    expect(received.body).not.toHaveProperty("outcome");
    expect(settle).toHaveBeenCalledOnce();
    await expect(settle.mock.results[0]!.value).rejects.toMatchObject({
      code: "configuration_not_ready",
    });
    expect(quiesceAgent).not.toHaveBeenCalled();
    expect(closeForLifecycle).not.toHaveBeenCalled();
    expect(hasUnstoppedRuntimeCalls).not.toHaveBeenCalled();
  });

  it("keeps the strict Skill-source 409 envelope at code and canonical message only", async () => {
    const error = new SkillSourceError("content_changed");
    error.message = secret;
    const inspect = vi.fn(() => Promise.resolve({ items: [] }));
    const artifact = vi.fn(() => Promise.reject(error));
    const base = await listen({
      skillSources: { service: { inspect, artifact } },
    });
    const received = await jsonResponse(
      await post(
        base,
        "/internal/skill-sources/artifact",
        workloadHeaders("skill-registry"),
        JSON.stringify({
          organization_id: `org_${"a".repeat(32)}`,
          actor_id: `user_${"b".repeat(32)}`,
          skill_ref: {
            kind: "agent",
            agent_id: `agent_${"c".repeat(32)}`,
            name: "inspect-first",
            sequence: 3,
          },
          expected_digest: `sha256:${"d".repeat(64)}`,
        }),
      ),
    );
    expect(received.response.status).toBe(409);
    expect(received.body).toEqual({
      error: {
        code: "content_changed",
        message: definition("content_changed").message,
      },
    });
    expect(received.text).not.toContain(secret);
    expect(received.response.headers.get("cache-control")).toBe("no-store");
    expect(artifact).toHaveBeenCalledOnce();
    expect(inspect).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed JSON", `{"secret":"${secret}",`, "invalid_json"],
    ["oversized body", "x".repeat(1025), "request_too_large"],
  ] as const)(
    "uses canonical validation errors through the real ACP HTTP adapter for %s",
    async (_label, body, code) => {
      const base = await listen();
      const received = await jsonResponse(
        await post(base, "/v1/acp", workspaceHeaders(), body),
      );
      assertFailure(received, code);
      expect(received.response.headers.get("connection")).toBe("close");
    },
  );

  it.each([
    [new DomainError("access_denied", secret), "access_denied"],
    [new Error(secret), "execution_state_unavailable"],
  ] as const)(
    "ends an already-started SSE response with one safe error frame: %s",
    async (error, code) => {
      const state = {
        agent_id: "agent-1",
        access_allowed: true as const,
        configuration_revision: "a".repeat(64),
        availability: "ready" as const,
        active_session_id: null,
        unavailable_reason: null,
      };
      const read = vi.fn<AgentExecutionStatePort["read"]>();
      const watch = vi.fn<AgentExecutionStatePort["watch"]>(
        async (_identity, send, signal) => {
          await send(state, signal);
          throw error;
        },
      );
      const base = await listen({ executionState: { read, watch } });
      const response = await post(base, watchPath, workspaceHeaders());
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(text).toBe(
        `event: workspace_state\ndata: ${JSON.stringify(state)}\n\n` +
          `event: workspace_error\ndata: ${JSON.stringify(expectedBody(code))}\n\n`,
      );
      expect(text).not.toContain(secret);
      expect(watch).toHaveBeenCalledOnce();
      expect(read).not.toHaveBeenCalled();
    },
  );
});
