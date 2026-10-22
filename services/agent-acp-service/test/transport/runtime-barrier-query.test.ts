import { request as httpRequest } from "node:http";
import { setImmediate as nextTurn } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SERVICE_AUTH_HEADER, SERVICES } from "../../src/adapters/service-authentication.js";
import { DomainError } from "../../src/domain/errors.js";
import type { AcpApplicationPort } from "../../src/ports/acp-application.js";
import type { RuntimeBarrierReader, RuntimeBarrierState } from "../../src/ports/runtime-barrier.js";
import { AgentAcpHttpServer } from "../../src/transport/http-server.js";
import { testAuthentication, workloadHeaders } from "../support/auth-fixture.js";

const path = "/rpc/agent-acp/get-runtime-barrier";
const canary = "private-runtime-barrier-query-canary";
const input = {
  organization_id: "organization-1",
  agent_id: "agent-1",
  expected_runtime_revision: "runtime-1",
};
const unavailable = {
  code: "execution_state_unavailable",
  message: "Agent execution state is unavailable",
  retryable: true,
};
const scope = {
  organizationId: input.organization_id,
  agentId: input.agent_id,
  expectedRuntimeRevision: input.expected_runtime_revision,
};

describe("runtime barrier control HTTP boundary", () => {
  let server: AgentAcpHttpServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  async function start(
    options: {
      reader?: RuntimeBarrierReader;
      ready?: () => Promise<boolean>;
      authentication?: ReturnType<typeof testAuthentication>;
    } = {},
  ) {
    server = new AgentAcpHttpServer({
      authentication: options.authentication ?? testAuthentication(),
      application: {} as AcpApplicationPort,
      ready: options.ready ?? (() => Promise.resolve(true)),
      ...(options.reader === undefined ? {} : { runtimeBarriers: options.reader }),
      maxWebSocketPayloadBytes: 65536,
    });
    await server.listenControl("127.0.0.1", 0);
    await server.listen("127.0.0.1", 0);
    const control = server.controlAddress();
    const workspace = server.address();
    if (
      control === null ||
      typeof control === "string" ||
      workspace === null ||
      typeof workspace === "string"
    )
      throw new Error("Expected both HTTP listeners");
    return {
      control: `http://127.0.0.1:${control.port}`,
      workspace: `http://127.0.0.1:${workspace.port}`,
    };
  }

  it.each([false, true])(
    "returns the exact scoped recovery fact to Controller without a CCT (barrier=%s)",
    async (protectedRuntime) => {
      const state: RuntimeBarrierState = {
        runtimeRevision: "runtime-1",
        barrier: protectedRuntime
          ? { barrierId: "barrier-1", runtimeExecutionId: "original-execution-1" }
          : null,
      };
      const read = vi.fn<RuntimeBarrierReader["readCurrentBarrier"]>().mockResolvedValue(state);
      const { control } = await start({ reader: { readCurrentBarrier: read } });
      const response = await post(control, JSON.stringify(input));
      await expectPublicResponse(response, 200, {
        organization_id: input.organization_id,
        agent_id: input.agent_id,
        runtime_revision: "runtime-1",
        barrier: protectedRuntime
          ? {
              barrier_id: "barrier-1",
              reason: "runtime_barrier_required",
              runtime_execution_id: "original-execution-1",
            }
          : null,
      });
      expect(read).toHaveBeenCalledTimes(1);
      expect(isDeepStrictEqual(read.mock.calls[0]?.[0], scope)).toBe(true);
      expect(read.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
      await server!.close();
      expect(server!.address()).toBeNull();
      expect(server!.controlAddress()).toBeNull();
    },
  );

  it("rejects missing or invalid credentials and every other verified workload before reading", async () => {
    const read = vi
      .fn<RuntimeBarrierReader["readCurrentBarrier"]>()
      .mockResolvedValue(clearState());
    const ready = vi.fn(() => Promise.resolve(true));
    const { control } = await start({ reader: { readCurrentBarrier: read }, ready });
    const credentials: { headers: Record<string, string>; status: number; code: string }[] = [
      { headers: {}, status: 401, code: "service_unauthenticated" },
      {
        headers: { [SERVICE_AUTH_HEADER]: `Bearer ${canary}` },
        status: 401,
        code: "service_unauthenticated",
      },
      ...SERVICES.filter(
        (caller) => caller !== "agent-controller" && caller !== "agent-acp-service",
      ).map((caller) => ({
        headers: workloadHeaders(caller),
        status: 403,
        code: "caller_not_allowed",
      })),
    ];
    for (const credential of credentials) {
      const response = await post(control, "{", credential.headers);
      const body = await response.text();
      expect(response.status).toBe(credential.status);
      expect(body.includes(canary)).toBe(false);
      const payload = parsePublicBody(body);
      expect(isObject(payload) && payload.code === credential.code).toBe(true);
    }
    expect(read).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
  });

  it("returns workspace 404 for all method/query variants before authentication, body, readiness or reader", async () => {
    const authentication = testAuthentication();
    const admit = vi.spyOn(authentication, "admit");
    const ready = vi.fn(() => Promise.resolve(true));
    const read = vi
      .fn<RuntimeBarrierReader["readCurrentBarrier"]>()
      .mockResolvedValue(clearState());
    const { workspace } = await start({
      reader: { readCurrentBarrier: read },
      ready,
      authentication,
    });
    const credentials: Record<string, string>[] = [
      {},
      { [SERVICE_AUTH_HEADER]: `Bearer ${canary}` },
      workloadHeaders("agent-controller"),
    ];
    for (const method of ["POST", "GET", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE"]) {
      for (const suffix of ["", "?probe=1", "?expected_runtime_revision=other"]) {
        for (const headers of credentials) {
          // Content-Length promises more bytes than are sent. Receiving 404
          // before client.end() proves this route never waits for body parsing.
          expect(await unfinishedRequest(`${workspace}${path}${suffix}`, method, headers)).toBe(
            404,
          );
        }
      }
    }
    expect(admit.mock.calls.length).toBe(0);
    expect(ready).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed JSON", "{"],
    ["trailing JSON", `${JSON.stringify(input)} {}`],
    ["null", "null"],
    ["array", "[]"],
    ["scalar", "1"],
    [
      "duplicate member",
      '{"organization_id":"organization-1","organization_id":"organization-1","agent_id":"agent-1","expected_runtime_revision":"runtime-1"}',
    ],
    [
      "escaped duplicate member",
      '{"organization_id":"organization-1","organization\\u005fid":"organization-2","agent_id":"agent-1","expected_runtime_revision":"runtime-1"}',
    ],
  ] as const)("rejects %s without a reader call", async (_name, body) => {
    const read = vi
      .fn<RuntimeBarrierReader["readCurrentBarrier"]>()
      .mockResolvedValue(clearState());
    const { control } = await start({ reader: { readCurrentBarrier: read } });
    await expectPublicResponse(await post(control, body), 400, {
      code: "invalid_json",
      message: "Request JSON is invalid",
      retryable: false,
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects every missing or extra request member without exposing its value", async () => {
    const read = vi
      .fn<RuntimeBarrierReader["readCurrentBarrier"]>()
      .mockResolvedValue(clearState());
    const { control } = await start({ reader: { readCurrentBarrier: read } });
    const invalid: Record<string, unknown>[] = [
      {},
      { ...input, credentials: canary },
      { ...input, barrier_id: canary },
      { ...input, runtime_revision: "runtime-1" },
    ];
    for (const field of Object.keys(input)) {
      const missing: Record<string, unknown> = { ...input };
      delete missing[field];
      invalid.push(missing);
    }
    for (const request of invalid) {
      await expectPublicResponse(await post(control, JSON.stringify(request)), 400, {
        code: "invalid_request",
        message: "Request is invalid",
        retryable: false,
      });
    }
    expect(read).not.toHaveBeenCalled();
  });

  it.each(["organization_id", "agent_id", "expected_runtime_revision"] as const)(
    "enforces the unnormalized 1–200 non-whitespace character boundary for %s",
    async (field) => {
      const read = vi.fn<RuntimeBarrierReader["readCurrentBarrier"]>((selected) =>
        Promise.resolve({ runtimeRevision: selected.expectedRuntimeRevision, barrier: null }),
      );
      const { control } = await start({ reader: { readCurrentBarrier: read } });
      for (const value of [
        null,
        true,
        1,
        {},
        [],
        "",
        " ",
        " agent-1",
        "agent-1 ",
        "agent 1",
        "agent\n1",
        "agent\t1",
        "agent\u00a01",
        "a".repeat(201),
      ]) {
        await expectPublicResponse(
          await post(control, JSON.stringify({ ...input, [field]: value })),
          400,
          {
            code: "invalid_request",
            message: "Request is invalid",
            retryable: false,
          },
        );
      }
      expect(read).not.toHaveBeenCalled();
      for (const value of ["a", "a".repeat(200), "organization/agent:1", "组织-1"]) {
        const request = { ...input, [field]: value };
        await expectPublicResponse(await post(control, JSON.stringify(request)), 200, {
          organization_id: request.organization_id,
          agent_id: request.agent_id,
          runtime_revision: request.expected_runtime_revision,
          barrier: null,
        });
        expect(
          isDeepStrictEqual(read.mock.lastCall?.[0], {
            organizationId: request.organization_id,
            agentId: request.agent_id,
            expectedRuntimeRevision: request.expected_runtime_revision,
          }),
        ).toBe(true);
      }
      expect(read).toHaveBeenCalledTimes(4);
    },
  );

  it.each(["false", "throw", "missing reader"] as const)(
    "fails unavailable readiness (%s) with zero reads rather than a null barrier",
    async (mode) => {
      const read = vi
        .fn<RuntimeBarrierReader["readCurrentBarrier"]>()
        .mockResolvedValue(clearState());
      const ready = vi.fn(() =>
        mode === "throw" ? Promise.reject(new Error(canary)) : Promise.resolve(mode !== "false"),
      );
      const { control } = await start({
        ...(mode === "missing reader" ? {} : { reader: { readCurrentBarrier: read } }),
        ready,
      });
      await expectPublicResponse(await post(control, JSON.stringify(input)), 503, unavailable);
      expect(read).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      code: "not_found",
      status: 404,
      body: { code: "not_found", message: "Resource was not found", retryable: false },
    },
    {
      code: "configuration_conflict",
      status: 409,
      body: {
        code: "configuration_conflict",
        message: "Configuration revision conflicts with current state",
        retryable: false,
      },
    },
    {
      code: "configuration_not_ready",
      status: 503,
      body: {
        code: "configuration_not_ready",
        message: "Execution configuration is not ready",
        retryable: true,
        retry_after_ms: 1000,
      },
    },
  ])(
    "preserves typed $code without reflecting reader diagnostics",
    async ({ code, status, body }) => {
      const read = vi
        .fn<RuntimeBarrierReader["readCurrentBarrier"]>()
        .mockRejectedValue(new DomainError(code, canary));
      const { control } = await start({ reader: { readCurrentBarrier: read } });
      await expectPublicResponse(await post(control, JSON.stringify(input)), status, body);
      expect(read).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    new Error(canary),
    Object.assign(new Error(canary), { code: "not_found" }),
    { code: "configuration_conflict", message: canary },
    new DomainError("database_error", canary),
  ])(
    "keeps an unrecognized reader failure unavailable without trusting an arbitrary code",
    async (error) => {
      const read = vi.fn<RuntimeBarrierReader["readCurrentBarrier"]>().mockRejectedValue(error);
      const { control } = await start({ reader: { readCurrentBarrier: read } });
      await expectPublicResponse(await post(control, JSON.stringify(input)), 503, unavailable);
      expect(read).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { name: "null state", value: null },
    { name: "missing barrier member", value: { runtimeRevision: "runtime-1" } },
    { name: "wrong revision", value: { runtimeRevision: "replacement-runtime", barrier: null } },
    { name: "invalid revision", value: { runtimeRevision: "runtime 1", barrier: null } },
    { name: "primitive barrier", value: { runtimeRevision: "runtime-1", barrier: true } },
    { name: "empty barrier", value: { runtimeRevision: "runtime-1", barrier: {} } },
    {
      name: "missing original execution",
      value: { runtimeRevision: "runtime-1", barrier: { barrierId: "barrier-1" } },
    },
    {
      name: "invalid barrier id",
      value: {
        runtimeRevision: "runtime-1",
        barrier: { barrierId: "barrier 1", runtimeExecutionId: "execution-1" },
      },
    },
    {
      name: "invalid original execution",
      value: {
        runtimeRevision: "runtime-1",
        barrier: { barrierId: "barrier-1", runtimeExecutionId: "" },
      },
    },
  ])(
    "rejects invalid reader output ($name) instead of returning a null fact",
    async ({ value }) => {
      // Deliberately model a reader that violates its port at the HTTP boundary.
      const read = vi
        .fn<RuntimeBarrierReader["readCurrentBarrier"]>()
        .mockResolvedValue(value as unknown as RuntimeBarrierState);
      const { control } = await start({ reader: { readCurrentBarrier: read } });
      await expectPublicResponse(await post(control, JSON.stringify(input)), 503, unavailable);
      expect(read).toHaveBeenCalledTimes(1);
    },
  );

  it("projects only the recovery fact when an internal reader object carries extra private members", async () => {
    const state = {
      runtimeRevision: "runtime-1",
      credentials: canary,
      barrier: {
        barrierId: "barrier-1",
        runtimeExecutionId: "original-execution-1",
        endpoint: canary,
      },
    };
    const read = vi.fn<RuntimeBarrierReader["readCurrentBarrier"]>().mockResolvedValue(state);
    const { control } = await start({ reader: { readCurrentBarrier: read } });
    await expectPublicResponse(await post(control, JSON.stringify(input)), 200, {
      organization_id: input.organization_id,
      agent_id: input.agent_id,
      runtime_revision: "runtime-1",
      barrier: {
        barrier_id: "barrier-1",
        reason: "runtime_barrier_required",
        runtime_execution_id: "original-execution-1",
      },
    });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("aborts a real disconnected HTTP read and joins the held reader promise before test cleanup", async () => {
    const release = Promise.withResolvers<void>();
    const reads: Promise<RuntimeBarrierState>[] = [];
    let aborted = false;
    let settled = false;
    const read = vi.fn<RuntimeBarrierReader["readCurrentBarrier"]>((selected, signal) => {
      const reading = (async () => {
        if (signal === undefined) throw new Error("Expected a request cancellation signal");
        const onAbort = () => {
          aborted = true;
        };
        signal.addEventListener("abort", onAbort, { once: true });
        try {
          if (signal.aborted) onAbort();
          await release.promise;
          signal.throwIfAborted();
          return { runtimeRevision: selected.expectedRuntimeRevision, barrier: null };
        } finally {
          signal.removeEventListener("abort", onAbort);
          settled = true;
        }
      })();
      reads.push(reading);
      return reading;
    });
    const { control } = await start({ reader: { readCurrentBarrier: read } });
    const client = httpRequest(
      `${control}${path}`,
      {
        method: "POST",
        agent: false,
        headers: { ...workloadHeaders("agent-controller"), "content-type": "application/json" },
      },
      (response) => response.resume(),
    );
    // A deliberate local socket destroy may emit ECONNRESET. The reader's
    // signal and original promise, rather than that client error, are evidence.
    client.on("error", () => undefined);
    const clientClosed = new Promise<void>((resolve) => client.once("close", resolve));
    client.end(JSON.stringify(input));
    try {
      await expect.poll(() => read.mock.calls.length, { timeout: 5000 }).toBe(1);
      const signal = read.mock.calls[0]?.[1];
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(isDeepStrictEqual(read.mock.calls[0]?.[0], scope)).toBe(true);
      expect(settled).toBe(false);
      client.destroy();
      await clientClosed;
      await expect.poll(() => aborted, { timeout: 5000 }).toBe(true);
      expect(signal?.aborted).toBe(true);
      await nextTurn();
      expect(settled).toBe(false);
      release.resolve();
      const results = await Promise.allSettled(reads);
      expect(results.length).toBe(1);
      expect(results[0]?.status).toBe("rejected");
      expect(settled).toBe(true);
    } finally {
      client.destroy();
      release.resolve();
      await Promise.allSettled(reads);
      await clientClosed;
    }
  }, 15_000);
});

function clearState(): RuntimeBarrierState {
  return { runtimeRevision: "runtime-1", barrier: null };
}

function post(
  origin: string,
  body: string,
  credentials: Record<string, string> = workloadHeaders("agent-controller"),
) {
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: { ...credentials, "content-type": "application/json" },
    body,
  });
}

async function expectPublicResponse(response: Response, status: number, expected: unknown) {
  const body = await response.text();
  expect(response.status).toBe(status);
  expect(body.includes(canary)).toBe(false);
  expect(
    isDeepStrictEqual(parsePublicBody(body), expected),
    "HTTP response must match the public contract",
  ).toBe(true);
}

function parsePublicBody(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error("Expected a JSON HTTP response");
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unfinishedRequest(
  url: string,
  method: string,
  credentials: Record<string, string>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const client = httpRequest(
      url,
      {
        method,
        agent: false,
        headers: {
          ...credentials,
          "content-type": "text/plain",
          "content-length": "128",
        },
      },
      (response) => {
        response.resume();
        response.once("error", reject);
        response.once("end", () => {
          client.destroy();
          resolve(response.statusCode ?? 0);
        });
      },
    );
    client.once("error", reject);
    client.setTimeout(5000, () =>
      client.destroy(new Error("Workspace routing waited for the request body")),
    );
    client.flushHeaders();
    client.write("{");
  });
}
