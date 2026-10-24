import { describe, expect, it, vi } from "vitest";
import { ModelCallPolicy } from "../../src/application/model-call-policy.js";
import { ModelRequestBudget } from "../../src/application/model-request-budget.js";
import { ProviderClients } from "../../src/application/provider-clients.js";
import { RunModelClient } from "../../src/application/run-model-client.js";
import { RunEventPersistenceError } from "../../src/application/durable-run-events.js";
import {
  publicExecutionConfiguration,
  type ExecutionConfiguration,
} from "../../src/domain/execution-configuration.js";
import { runSnapshot } from "../../src/domain/run-snapshot.js";
import {
  ModelError,
  ModelTransportCleanupError,
  type AuthenticatedModelTransport,
  type ModelRequest,
  type ModelResult,
} from "../../src/ports/model.js";
import type { ModelAttemptPort } from "../../src/ports/model-attempts.js";
import { executionConfiguration, executionIdentity } from "../fixtures/execution-configuration.js";

function success(): ModelResult {
  return {
    kind: "message",
    content: [{ type: "text", text: "done" }],
    usage: { inputTokens: 7, outputTokens: 2 },
    stopReason: "end_turn",
  };
}

function unavailable(): ModelError {
  return new ModelError("model_http_error", "synthetic provider failure", true, 503);
}

function setup() {
  let elapsed = 0;
  const wall = Date.parse("2026-10-25T00:00:00Z");
  const clock = {
    now: () => wall + elapsed,
    monotonic: () => elapsed,
    random: () => 1,
    wait: vi.fn((milliseconds: number, signal: AbortSignal) => {
      signal.throwIfAborted();
      elapsed += milliseconds;
      return Promise.resolve();
    }),
  };
  const configuration: ExecutionConfiguration = executionConfiguration();
  const provider = configuration.providers[0]!;
  const primary = configuration.models[0]!;
  configuration.providers.push({
    ...provider,
    connection_id: "provider-2",
    base_url: "https://fallback.example.test/v1",
  });
  configuration.models.push({
    ...primary,
    model_profile_id: "model-2",
    connection_id: "provider-2",
    model: "fallback",
  });
  configuration.agents[0]!.failover = "before_output";
  configuration.agents[0]!.fallback_model_profile_ids = ["model-2"];
  configuration.agents[0]!.model_retry = { max: 3, base_ms: 100, cap_ms: 1000 };
  const complete = vi.fn<AuthenticatedModelTransport["complete"]>().mockResolvedValue(success());
  const providers = new ProviderClients(
    { complete },
    { failureThreshold: 1, cooldownMs: 10, now: () => elapsed },
  );
  providers.apply(configuration);
  const frozen = runSnapshot({
    configuration: publicExecutionConfiguration(configuration),
    identity: executionIdentity(),
    overrides: {},
    accessRevision: "access-1",
    clientMcpRevisionId: "mcp-1",
    deadlineAt: new Date(wall + 60000),
  });
  let run = 0;
  const makeCall = (
    options: { purpose?: "permission_judge"; never?: boolean; limit?: number } = {},
  ) => {
    const snapshot = structuredClone(frozen);
    snapshot.deadlineAt = new Date(clock.now() + 60000);
    if (options.never) snapshot.executionSpec.modelFailover = "never";
    snapshot.executionSpec.maxModelRequests = options.limit ?? 8;
    const budget = new ModelRequestBudget(snapshot.executionSpec.maxModelRequests);
    const attempts = {
      start: vi.fn<ModelAttemptPort["start"]>().mockResolvedValue(undefined),
      finish: vi.fn<ModelAttemptPort["finish"]>().mockResolvedValue(undefined),
    };
    const abort = new AbortController();
    const request: ModelRequest = {
      snapshot,
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      tools: [],
      signal: abort.signal,
      ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
    };
    const policy = new ModelCallPolicy({
      model: new RunModelClient({ providers, snapshot }),
      providerCircuit: providers,
      budget,
      attempts,
      clock,
    });
    const runId = `run-${++run}`;
    return { abort, request, attempts, budget, call: () => policy.complete({ runId, request }) };
  };
  const open = (connectionId = "provider-1") => {
    const configured = configuration.providers.find(
      (entry) => entry.connection_id === connectionId,
    )!;
    const permit = providers.tryModelAttempt(
      configuration.organization_id,
      connectionId,
      configured.base_url,
    );
    if (permit === undefined) throw new Error("Expected closed circuit");
    expect(permit.settle("failure")).toBe(true);
  };
  return {
    clock,
    configuration,
    providers,
    complete,
    makeCall,
    open,
    advance: (ms: number) => {
      elapsed += ms;
    },
  };
}

describe("Provider circuit policy admission", () => {
  it("opens on a Provider failure, skips retry backoff and shares health across foreground and judge Runs", async () => {
    const f = setup();
    f.complete.mockRejectedValueOnce(unavailable());
    const first = f.makeCall();
    await expect(first.call()).resolves.toEqual(success());
    expect(f.clock.wait).not.toHaveBeenCalled();
    expect(f.complete.mock.calls.map(([request]) => request.snapshot.providerConnectionId)).toEqual(
      ["provider-1", "provider-2"],
    );
    for (const purpose of [undefined, "permission_judge"] as const) {
      const next = f.makeCall(purpose === undefined ? {} : { purpose });
      await expect(next.call()).resolves.toEqual(success());
      expect(next.attempts.start).toHaveBeenCalledExactlyOnceWith(
        expect.any(String),
        expect.objectContaining({
          ordinal: 1,
          providerConnectionId: "provider-2",
          purpose: purpose ?? "foreground",
        }),
      );
      expect(next.attempts.finish).toHaveBeenCalledTimes(1);
    }
    expect(
      f.complete.mock.calls.filter(
        ([request]) => request.snapshot.providerConnectionId === "provider-1",
      ),
    ).toHaveLength(1);
  });

  it.each([
    ["model_http_error", 408],
    ["model_http_error", 429],
    ["model_http_error", 500],
    ["model_http_error", 599],
    ["model_unavailable", undefined],
    ["provider_endpoint_unavailable", undefined],
  ] as const)(
    "opens on retryable health failure %s with status %s and immediately selects the fallback",
    async (code, status) => {
      const f = setup();
      f.complete.mockRejectedValueOnce(
        new ModelError(code, "synthetic health failure", true, status),
      );
      const first = f.makeCall();
      await expect(first.call()).resolves.toEqual(success());
      expect(
        f.complete.mock.calls.map(([request]) => request.snapshot.providerConnectionId),
      ).toEqual(["provider-1", "provider-2"]);
      expect(first.attempts.start).toHaveBeenCalledTimes(2);
      expect(first.attempts.finish).toHaveBeenCalledTimes(2);
      const next = f.makeCall();
      await expect(next.call()).resolves.toEqual(success());
      expect(next.attempts.start).toHaveBeenCalledExactlyOnceWith(
        expect.any(String),
        expect.objectContaining({ ordinal: 1, providerConnectionId: "provider-2" }),
      );
      expect(
        f.complete.mock.calls.map(([request]) => request.snapshot.providerConnectionId),
      ).toEqual(["provider-1", "provider-2", "provider-2"]);
      expect(f.clock.wait).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "uses no request slots or audit when all eligible circuits are open (never=%s)",
    async (never) => {
      const f = setup();
      f.open();
      f.open("provider-2");
      const call = f.makeCall({ never, limit: 1 });
      await expect(call.call()).rejects.toMatchObject({
        code: "model_unavailable",
        retryable: false,
      });
      expect(call.budget.canTake()).toBe(true);
      expect(call.attempts.start).not.toHaveBeenCalled();
      expect(call.attempts.finish).not.toHaveBeenCalled();
      expect(f.complete).not.toHaveBeenCalled();
    },
  );

  it("does not consume the only physical slot when skipping an open primary", async () => {
    const f = setup();
    f.open();
    const call = f.makeCall({ limit: 1 });
    await expect(call.call()).resolves.toEqual(success());
    expect(call.attempts.start).toHaveBeenCalledExactlyOnceWith(
      expect.any(String),
      expect.objectContaining({ ordinal: 1, providerConnectionId: "provider-2" }),
    );
    expect(call.budget.canTake()).toBe(false);
  });

  it("holds the single half-open probe through the original task and durable finish receipt", async () => {
    const f = setup();
    f.open();
    f.advance(10);
    const response = Promise.withResolvers<ModelResult>();
    const dispatched = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const finishing = Promise.withResolvers<void>();
    f.complete.mockImplementationOnce(() => {
      dispatched.resolve();
      return response.promise;
    });
    const probe = f.makeCall();
    probe.attempts.finish.mockImplementationOnce(() => {
      finishing.resolve();
      return finish.promise;
    });
    const running = probe.call();
    try {
      await dispatched.promise;
      f.advance(100);
      await expect(f.makeCall().call()).resolves.toEqual(success());
      expect(f.complete.mock.calls.at(-1)?.[0].snapshot.providerConnectionId).toBe("provider-2");
      response.resolve(success());
      await finishing.promise;
      await expect(f.makeCall({ purpose: "permission_judge" }).call()).resolves.toEqual(success());
      expect(f.complete.mock.calls.at(-1)?.[0].snapshot.providerConnectionId).toBe("provider-2");
      finish.resolve();
      await expect(running).resolves.toEqual(success());
      await expect(f.makeCall().call()).resolves.toEqual(success());
      expect(f.complete.mock.calls.at(-1)?.[0].snapshot.providerConnectionId).toBe("provider-1");
    } finally {
      response.resolve(success());
      finish.resolve();
      await running.catch(() => undefined);
    }
  });

  it.each([
    new ModelError("model_http_error", "bad input", true, 400),
    new ModelError("model_http_error", "bad authorization", true, 401),
    new ModelError("model_http_error", "not retryable", false, 503),
    new Error("unknown operation failure"),
    new ModelTransportCleanupError(new Error("cleanup")),
  ])("does not treat non-transient or cleanup errors as health failures: %s", async (failure) => {
    const f = setup();
    f.complete.mockRejectedValueOnce(failure);
    const call = f.makeCall();
    await expect(call.call()).rejects.toBe(failure);
    expect(f.complete).toHaveBeenCalledTimes(1);
    await expect(f.makeCall().call()).resolves.toEqual(success());
    expect(f.complete.mock.calls.at(-1)?.[0].snapshot.providerConnectionId).toBe("provider-1");
  });

  it.each(["start", "finish"] as const)(
    "keeps a probe neutral if its %s persistence fails and releases it only after settlement",
    async (operation) => {
      const f = setup();
      f.open();
      f.advance(10);
      const call = f.makeCall();
      call.attempts[operation].mockRejectedValueOnce(new Error("storage unavailable"));
      await expect(call.call()).rejects.toBeInstanceOf(RunEventPersistenceError);
      await expect(f.makeCall().call()).resolves.toEqual(success());
      expect(f.complete.mock.calls.at(-1)?.[0].snapshot.providerConnectionId).toBe("provider-2");
      f.advance(10);
      await expect(f.makeCall().call()).resolves.toEqual(success());
      expect(f.complete.mock.calls.at(-1)?.[0].snapshot.providerConnectionId).toBe("provider-1");
    },
  );

  it("joins a cancelled probe's late response and preserves usage before reopening cooldown", async () => {
    const f = setup();
    f.open();
    f.advance(10);
    const response = Promise.withResolvers<ModelResult>();
    const dispatched = Promise.withResolvers<void>();
    f.complete.mockImplementationOnce(() => {
      dispatched.resolve();
      return response.promise;
    });
    const probe = f.makeCall();
    const observed = probe.call().then(
      () => "unexpected success",
      (error: unknown) => error,
    );
    try {
      await dispatched.promise;
      probe.abort.abort(new Error("caller cancelled"));
      f.advance(100);
      await expect(f.makeCall().call()).resolves.toEqual(success());
      expect(f.complete.mock.calls.at(-1)?.[0].snapshot.providerConnectionId).toBe("provider-2");
      expect(probe.attempts.finish).not.toHaveBeenCalled();
      response.resolve(success());
      expect(await observed).toBeInstanceOf(Error);
      expect(probe.attempts.finish).toHaveBeenCalledExactlyOnceWith(
        expect.any(String),
        expect.objectContaining({ outcome: "cancelled", usage: success().usage }),
      );
      await expect(f.makeCall().call()).resolves.toEqual(success());
      expect(f.complete.mock.calls.at(-1)?.[0].snapshot.providerConnectionId).toBe("provider-2");
    } finally {
      response.resolve(success());
      await observed;
    }
  });

  it("does not mark a successful probe healthy when cancellation arrives during its finish receipt", async () => {
    const f = setup();
    f.open();
    f.advance(10);
    const probe = f.makeCall();
    probe.attempts.finish.mockImplementationOnce(() => {
      probe.abort.abort(new Error("cancelled during durable finish"));
      return Promise.resolve();
    });
    await expect(probe.call()).rejects.toBeInstanceOf(Error);
    expect(probe.attempts.finish).toHaveBeenCalledTimes(1);
    await expect(f.makeCall().call()).resolves.toEqual(success());
    expect(f.complete.mock.calls.at(-1)?.[0].snapshot.providerConnectionId).toBe("provider-2");
  });

  it("does not mark a successful probe healthy when its deadline expires during the finish receipt", async () => {
    const f = setup();
    f.open();
    f.advance(10);
    const probe = f.makeCall();
    probe.attempts.finish.mockImplementationOnce(() => {
      f.advance(60000);
      return Promise.resolve();
    });
    await expect(probe.call()).rejects.toMatchObject({
      code: "model_unavailable",
      retryable: false,
      deadlineExceeded: true,
    });
    expect(probe.attempts.finish).toHaveBeenCalledTimes(1);
    const next = f.makeCall();
    expect(next.request.snapshot.deadlineAt.getTime()).toBe(f.clock.now() + 60000);
    await expect(next.call()).resolves.toEqual(success());
    expect(f.complete.mock.calls.at(-1)?.[0].snapshot.providerConnectionId).toBe("provider-2");
  });

  it.each(["disabled", "routing"] as const)(
    "does not reinterpret a %s Provider as an open circuit eligible for fallback",
    async (mode) => {
      const f = setup();
      const call = f.makeCall();
      if (mode === "routing")
        call.request.snapshot.executionSpec.model.baseUrl = "https://wrong.example.test/v1";
      else {
        f.configuration.providers[0] = { ...f.configuration.providers[0]!, enabled: false };
        f.providers.apply(f.configuration);
      }
      await expect(call.call()).rejects.toMatchObject({
        code: "provider_unavailable",
        retryable: false,
      });
      expect(f.complete).not.toHaveBeenCalled();
      expect(call.attempts.start).not.toHaveBeenCalled();
      expect(call.attempts.finish).not.toHaveBeenCalled();
      expect(call.budget.canTake()).toBe(true);
    },
  );

  it("never uses a circuit opening to switch after output has started", async () => {
    const f = setup();
    const failure = unavailable();
    failure.outputStarted = true;
    f.complete.mockRejectedValueOnce(failure);
    await expect(f.makeCall().call()).rejects.toBe(failure);
    expect(f.complete).toHaveBeenCalledTimes(1);
    await expect(f.makeCall().call()).resolves.toEqual(success());
    expect(f.complete.mock.calls.at(-1)?.[0].snapshot.providerConnectionId).toBe("provider-2");
  });
});
