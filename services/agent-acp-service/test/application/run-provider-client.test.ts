import { syntheticProviderDestination } from "../support/model-network.js";
import { describe, expect, it, vi } from "vitest";
import { ProviderClients } from "../../src/application/provider-clients.js";
import { RunExecutor, type RunExecutorDependencies } from "../../src/application/run-executor.js";
import { OpenAICompatibleModel } from "../../src/adapters/model/openai-compatible.js";
import type { RunExecutionInput } from "../../src/ports/acp-application.js";
import {
  publicExecutionConfiguration,
  type ExecutionConfiguration,
} from "../../src/domain/execution-configuration.js";
import { runSnapshot } from "../../src/domain/run-snapshot.js";
import type { ModelToolDefinition } from "../../src/domain/types.js";
import {
  ModelError,
  ModelTransportCleanupError,
  type AuthenticatedModelRequest,
  type AuthenticatedModelTransport,
  type ModelResult,
} from "../../src/ports/model.js";
import type { RunEventRepository } from "../../src/ports/run-event-repository.js";
import type { ExecutionRepository } from "../../src/ports/execution-repository.js";
import type { ToolCatalogPort } from "../../src/ports/tools.js";
import { executionConfiguration, executionIdentity } from "../fixtures/execution-configuration.js";

const now = new Date("2026-09-14T00:00:00Z");
const tool: ModelToolDefinition = {
  source: "runtime",
  sourceId: "runtime-1",
  name: "read",
  modelName: "read",
  description: "Read a file",
  inputSchema: { type: "object", properties: {} },
};

function setup() {
  const configuration: ExecutionConfiguration = executionConfiguration();
  configuration.agents[0]!.default_authorization.mode = "auto";
  const complete = vi.fn<AuthenticatedModelTransport["complete"]>().mockResolvedValue({
    kind: "message",
    content: [{ type: "text", text: "done" }],
    usage: { inputTokens: 4, outputTokens: 1 },
    stopReason: "end_turn",
  });
  const providers = new ProviderClients({ complete });
  providers.apply(configuration);
  const call = vi.fn<ToolCatalogPort["call"]>().mockResolvedValue({
    content: [{ type: "text", text: "read result" }],
    isError: false,
    toolEffectState: "settled",
  });
  const tools = { list: vi.fn<ToolCatalogPort["list"]>(), call };
  const build = vi.fn<RunExecutorDependencies["contextBuilder"]["build"]>().mockResolvedValue({
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    tools: [tool],
    runtimeWorkspace: "/workspace",
  });
  const events = {
    startModelAttempt: vi.fn<RunEventRepository["startModelAttempt"]>(() => Promise.resolve()),
    finishModelAttempt: vi.fn<RunEventRepository["finishModelAttempt"]>((input) =>
      Promise.resolve({ kind: "usage", used: 5, size: input.contextSize }),
    ),
    appendAgentMessage: vi.fn<RunEventRepository["appendAgentMessage"]>((input) =>
      Promise.resolve({ kind: "agent_message", messageId: input.id, content: input.content }),
    ),
    appendUsage: vi.fn<RunEventRepository["appendUsage"]>((input) =>
      Promise.resolve({ kind: "usage", used: 5, size: input.contextSize }),
    ),
    startToolAttempt: vi.fn<RunEventRepository["startToolAttempt"]>((input) =>
      Promise.resolve({
        kind: "tool_call",
        initial: true,
        title: input.tool.name,
        toolCallId: input.toolCallId,
        status: "in_progress",
      }),
    ),
    finishToolAttempt: vi.fn<RunEventRepository["finishToolAttempt"]>((input) =>
      Promise.resolve({
        kind: "tool_call",
        initial: false,
        toolCallId: input.toolCallId,
        status: input.status,
        content: input.content,
      }),
    ),
    appendPlan: vi.fn(),
    appendAgentThought: vi.fn(),
    appendToolProgress: vi.fn(),
    appendRejectedToolCall: vi.fn(),
    interruptToolAttempts: vi.fn(),
  } satisfies RunEventRepository;
  const finish = vi.fn<ExecutionRepository["finish"]>().mockResolvedValue();
  let sequence = 0;
  const executor = new RunExecutor({
    runtimeConnections: { releaseRun: vi.fn() },
    providers,
    tools,
    contextBuilder: { build },
    events,
    executions: { finish, getState: vi.fn(), listRecoveryWork: vi.fn() },
    ownershipSignal: new AbortController().signal,
    recovery: { recoverRun: vi.fn() },
    now: () => now,
    id: () => `event-${++sequence}`,
  });
  const input: RunExecutionInput = {
    accepted: {
      outputSequence: 0,
      runId: "run-1",
      requestId: "request-1",
      sessionId: "session-1",
      userMessageId: "message-1",
      snapshot: runSnapshot({
        configuration: publicExecutionConfiguration(configuration),
        identity: executionIdentity(),
        overrides: {},
        accessRevision: "access-1",
        clientMcpRevisionId: "mcp-1",
        deadlineAt: new Date(now.getTime() + 60000),
      }),
    },
    publish: vi.fn().mockResolvedValue(undefined),
    signal: new AbortController().signal,
  };
  return { configuration, executor, providers, complete, build, call, finish, input, events };
}

function fallbackSetup(mode: "auto" | "smart_approve" = "auto") {
  const f = setup();
  const provider = f.configuration.providers[0];
  const primaryModel = f.configuration.models[0];
  const agent = f.configuration.agents[0];
  if (
    provider === undefined ||
    !provider.enabled ||
    primaryModel === undefined ||
    agent === undefined
  )
    throw new Error("Missing enabled fallback fixture");
  f.configuration.models[0] = {
    ...primaryModel,
    supports_tools: true,
    pricing: { currency: "USD", input_per_million: 1, output_per_million: 2 },
  };
  f.configuration.providers.push({
    ...provider,
    connection_id: "provider-2",
    base_url: "https://provider-b.example.test/v1",
    credential_revision: "credential-b-1",
    credential: { method: "api_key", secret: "synthetic-fallback-provider-key" },
  });
  f.configuration.models.push({
    ...primaryModel,
    model_profile_id: "model-2",
    connection_id: "provider-2",
    model: "fallback-model",
    context_window: 128_000,
    max_output_tokens: 8192,
    supports_tools: true,
    pricing: { currency: "USD", input_per_million: 5, output_per_million: 9 },
  });
  agent.default_authorization.mode = mode;
  agent.failover = "before_output";
  agent.fallback_model_profile_ids = ["model-2"];
  agent.model_retry = { max: 0, base_ms: 1, cap_ms: 1 };
  f.providers.apply(f.configuration);
  f.input.accepted.snapshot = runSnapshot({
    configuration: publicExecutionConfiguration(f.configuration),
    identity: executionIdentity(),
    overrides: {},
    accessRevision: "access-1",
    clientMcpRevisionId: "mcp-1",
    deadlineAt: new Date(Date.now() + 60_000),
  });
  const fallback = f.input.accepted.snapshot.executionSpec.fallbackModels?.[0];
  if (fallback === undefined) throw new Error("Missing frozen fallback candidate");
  const initialFailure = new ModelError(
    "model_http_error",
    "Synthetic primary unavailable",
    true,
    503,
  );
  initialFailure.usage = { inputTokens: 2, outputTokens: 0 };
  f.complete.mockRejectedValueOnce(initialFailure);
  return { ...f, fallback, initialFailure };
}

describe("Run logical Provider client", () => {
  it.each(["disable", "cancel"])(
    "retains already streamed usage exactly once on %s without replaying the request",
    async (action) => {
      const { configuration, executor, providers, complete, input, events, finish } = setup();
      const source = new TransformStream<Uint8Array, Uint8Array>();
      const writer = source.writable.getWriter();
      const transport = new OpenAICompatibleModel({
        destination: syntheticProviderDestination,
        fetchFn: () =>
          Promise.resolve(
            new Response(source.readable, {
              headers: { "content-type": "text/event-stream" },
            }),
          ),
      });
      complete.mockImplementation((request) => transport.complete(request));
      const stop = new AbortController();
      input.signal = stop.signal;
      const entered = Promise.withResolvers<void>();
      vi.mocked(events.appendAgentMessage).mockImplementationOnce((event) => {
        entered.resolve();
        return Promise.resolve({
          kind: "agent_message",
          messageId: event.id,
          content: event.content,
        });
      });
      const running = executor.execute(input);
      try {
        await writer.write(
          new TextEncoder().encode(
            `data: ${JSON.stringify({
              choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }],
              usage: { prompt_tokens: 7, completion_tokens: 3, cost: 0.00001 },
            })}\n\n`,
          ),
        );
        await entered.promise;
        if (action === "disable") {
          configuration.providers[0] = { ...configuration.providers[0]!, enabled: false };
          providers.apply(configuration);
        } else {
          stop.abort();
        }
        await expect(running).resolves.toMatchObject(
          action === "disable"
            ? { terminalClass: "failed", errorClass: "provider_unavailable" }
            : { terminalClass: "cancelled" },
        );
        expect(events.finishModelAttempt).toHaveBeenCalledOnce();
        expect(events.finishModelAttempt.mock.calls[0]?.[0]).toMatchObject({
          runId: "run-1",
          usage: {
            inputTokens: 7,
            outputTokens: 3,
            cost: { amount: 0.00001, currency: "USD" },
          },
        });
        expect(events.appendUsage).not.toHaveBeenCalled();
        expect(complete).toHaveBeenCalledOnce();
        expect(finish).toHaveBeenCalledOnce();
      } finally {
        stop.abort();
        await writer.abort().catch(() => undefined);
        await running;
      }
    },
  );
  it("cancels a pending Tool on Provider disable without claiming its side effects were undone", async () => {
    const { configuration, executor, providers, complete, call, input, finish } = setup();
    complete.mockResolvedValueOnce({
      kind: "tool_calls",
      content: [],
      calls: [{ id: "call-1", name: "read", arguments: {} }],
      usage: { inputTokens: 2, outputTokens: 1 },
    });
    const entered = Promise.withResolvers<void>();
    call.mockImplementationOnce(
      (request) =>
        new Promise((resolve) => {
          entered.resolve();
          request.signal.addEventListener(
            "abort",
            () =>
              resolve({
                content: [{ type: "text", text: "Tool interrupted; outcome unknown" }],
                isError: true,
                toolEffectState: "unknown",
                runtimeCallStopped: true,
              }),
            { once: true },
          );
        }),
    );
    const running = executor.execute(input);
    await entered.promise;
    configuration.providers[0] = { ...configuration.providers[0]!, enabled: false };
    providers.apply(configuration);
    await expect(running).resolves.toMatchObject({
      terminalClass: "unresolved",
      toolEffectState: "unknown",
      errorClass: "provider_unavailable",
    });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledOnce();
  });
  it("uses rotated authentication on the next model request of the same Run", async () => {
    const { configuration, executor, providers, complete, call, input, finish } = setup();
    complete.mockResolvedValueOnce({
      kind: "tool_calls",
      content: [],
      calls: [{ id: "call-1", name: "read", arguments: {} }],
      usage: { inputTokens: 2, outputTokens: 1 },
    });
    call.mockImplementationOnce(() => {
      const next = structuredClone(configuration);
      next.revision = 2;
      next.providers[0] = {
        ...next.providers[0]!,
        enabled: true,
        credential_revision: "credential-2",
        credential: { method: "api_key", secret: "rotated-test-key" },
      };
      providers.apply(next);
      return Promise.resolve({
        content: [{ type: "text", text: "read result" }],
        isError: false,
        toolEffectState: "settled",
      });
    });
    await expect(executor.execute(input)).resolves.toMatchObject({ terminalClass: "completed" });
    expect(complete.mock.calls.map(([request]) => request.credential)).toEqual([
      "synthetic-provider-key",
      "rotated-test-key",
    ]);
    expect(complete.mock.calls[0]![0].snapshot).toEqual(complete.mock.calls[1]![0].snapshot);
    expect(JSON.stringify(input.accepted)).not.toContain("rotated-test-key");
    expect(JSON.stringify(finish.mock.calls)).not.toContain("rotated-test-key");
  });

  it("fails an actual holder immediately without permitting new acquisition", async () => {
    const { configuration, executor, providers, complete, build, input } = setup();
    build.mockImplementationOnce(() => {
      const next = structuredClone(configuration);
      next.revision = 2;
      next.providers[0] = { ...next.providers[0]!, enabled: false };
      providers.apply(next);
      expect(() => providers.acquire("organization-1", "provider-1")).toThrow("unavailable");
      return Promise.resolve({
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        tools: [],
        runtimeWorkspace: "/workspace",
      });
    });
    await expect(executor.execute(input)).resolves.toMatchObject({
      terminalClass: "failed",
      errorClass: "provider_unavailable",
    });
    expect(complete).not.toHaveBeenCalled();
    expect(() => providers.acquire("organization-1", "provider-1")).toThrow("unavailable");
  });

  it("fails an accepted Run with no available client before touching Runtime", async () => {
    const { configuration, executor, providers, complete, build, input, finish } = setup();
    configuration.providers[0] = { ...configuration.providers[0]!, enabled: false };
    providers.apply(configuration);
    await expect(executor.execute(input)).resolves.toMatchObject({
      terminalClass: "failed",
      errorClass: "provider_unavailable",
    });
    expect(build).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1", terminalClass: "failed" }),
    );
  });

  it("retains the local execution deadline without acquiring a Provider or Runtime", async () => {
    const { executor, providers, build, complete, input } = setup();
    const acquire = vi.spyOn(providers, "acquire");
    input.accepted.snapshot.deadlineAt = new Date(now.getTime() - 1);
    await expect(executor.execute(input)).resolves.toMatchObject({
      terminalClass: "failed",
      errorClass: "run_deadline_exceeded",
    });
    expect(acquire).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("executes a frozen fallback with its own credential, attempt identity and context size", async () => {
    const f = fallbackSetup();
    const original = structuredClone(f.input.accepted);
    await expect(f.executor.execute(f.input)).resolves.toMatchObject({
      terminalClass: "completed",
    });
    expect(f.complete).toHaveBeenCalledTimes(2);
    expect(f.complete.mock.calls.map(([request]) => request.credential)).toEqual([
      "synthetic-provider-key",
      "synthetic-fallback-provider-key",
    ]);
    expect(f.complete.mock.calls.map(([request]) => request.snapshot.executionSpec.model)).toEqual([
      original.snapshot.executionSpec.model,
      f.fallback.model,
    ]);
    expect(
      f.events.startModelAttempt.mock.calls.map(([attempt]) => ({
        ordinal: attempt.ordinal,
        modelProfileId: attempt.modelProfileId,
        providerConnectionId: attempt.providerConnectionId,
        model: attempt.model,
      })),
    ).toEqual([
      {
        ordinal: 1,
        modelProfileId: original.snapshot.modelProfileId,
        providerConnectionId: original.snapshot.providerConnectionId,
        model: original.snapshot.executionSpec.model.model,
      },
      {
        ordinal: 2,
        modelProfileId: f.fallback.modelProfileId,
        providerConnectionId: f.fallback.providerConnectionId,
        model: f.fallback.model.model,
      },
    ]);
    expect(
      f.events.finishModelAttempt.mock.calls.map(([attempt]) => ({
        ordinal: attempt.ordinal,
        outcome: attempt.outcome,
        contextSize: attempt.contextSize,
        usage: attempt.usage,
      })),
    ).toEqual([
      {
        ordinal: 1,
        outcome: "failed",
        contextSize: original.snapshot.executionSpec.model.contextWindow,
        usage: { inputTokens: 2, outputTokens: 0 },
      },
      {
        ordinal: 2,
        outcome: "completed",
        contextSize: f.fallback.model.contextWindow,
        usage: { inputTokens: 4, outputTokens: 1 },
      },
    ]);
    expect(f.events.appendUsage).not.toHaveBeenCalled();
    expect(f.call).not.toHaveBeenCalled();
    expect(f.finish).toHaveBeenCalledOnce();
    expect(f.input.accepted).toEqual(original);
    expect(f.build.mock.calls[0]?.[1]).toEqual(original.snapshot);
    expect(
      JSON.stringify({ accepted: f.input.accepted, finish: f.finish.mock.calls }),
    ).not.toContain("synthetic-fallback-provider-key");
  });

  it("keeps the active fallback request alive when the inactive primary provider is revoked", async () => {
    const f = fallbackSetup();
    const stop = new AbortController();
    f.input.signal = stop.signal;
    const entered = Promise.withResolvers<AuthenticatedModelRequest>();
    const held = Promise.withResolvers<ModelResult>();
    let originalSettled = false;
    const originalModel = held.promise.finally(() => {
      originalSettled = true;
    });
    f.complete.mockImplementation((request) => {
      entered.resolve(request);
      return originalModel;
    });
    let settled = false;
    const running = f.executor.execute(f.input);
    const observed = running.then(
      (value) => {
        settled = true;
        return { value, error: undefined };
      },
      (error: unknown) => {
        settled = true;
        return { value: undefined, error };
      },
    );
    try {
      const active = await Promise.race([
        entered.promise,
        observed.then((completion) => {
          if (completion.error instanceof Error) throw completion.error;
          throw new Error("Run ended before the fallback request", { cause: completion.error });
        }),
      ]);
      expect(active.snapshot.providerConnectionId).toBe(f.fallback.providerConnectionId);
      f.providers.apply({
        ...f.configuration,
        revision: 2,
        providers: f.configuration.providers.map((provider) =>
          provider.connection_id === f.input.accepted.snapshot.providerConnectionId
            ? { ...provider, enabled: false }
            : provider,
        ),
      });
      expect(active.signal.aborted).toBe(false);
      expect(originalSettled).toBe(false);
      expect(settled).toBe(false);
      expect(f.finish).not.toHaveBeenCalled();
      held.resolve({
        kind: "message",
        content: [{ type: "text", text: "fallback completed" }],
        usage: { inputTokens: 6, outputTokens: 2 },
        stopReason: "end_turn",
      });
      const completion = await observed;
      expect(completion.error).toBeUndefined();
      expect(completion.value).toMatchObject({ terminalClass: "completed" });
      expect(originalSettled).toBe(true);
      expect(f.complete).toHaveBeenCalledTimes(2);
      expect(f.complete.mock.calls.map(([request]) => request.credential)).toEqual([
        "synthetic-provider-key",
        "synthetic-fallback-provider-key",
      ]);
      expect(f.call).not.toHaveBeenCalled();
      expect(f.finish).toHaveBeenCalledOnce();
    } finally {
      stop.abort();
      held.resolve({
        kind: "message",
        content: [],
        usage: {},
        stopReason: "end_turn",
      });
      await Promise.allSettled([originalModel, running]);
    }
  });

  it("aborts and joins the original Tool when its active fallback provider is revoked", async () => {
    const f = fallbackSetup();
    const stop = new AbortController();
    f.input.signal = stop.signal;
    f.complete.mockResolvedValueOnce({
      kind: "tool_calls",
      content: [],
      calls: [{ id: "fallback-call-1", name: "read", arguments: {} }],
      usage: { inputTokens: 5, outputTokens: 2 },
    });
    const entered = Promise.withResolvers<Parameters<ToolCatalogPort["call"]>[0]>();
    const release = Promise.withResolvers<void>();
    let toolSettled = false;
    let toolAborted = false;
    const originalTool = release.promise
      .then(() => ({
        content: [{ type: "text" as const, text: "Tool interrupted; outcome unknown" }],
        isError: true,
        toolEffectState: "unknown" as const,
        runtimeCallStopped: true,
      }))
      .finally(() => {
        toolSettled = true;
      });
    f.call.mockImplementationOnce((request) => {
      request.signal.addEventListener(
        "abort",
        () => {
          toolAborted = true;
        },
        { once: true },
      );
      entered.resolve(request);
      return originalTool;
    });
    let settled = false;
    const running = f.executor.execute(f.input);
    const observed = running.then(
      (value) => {
        settled = true;
        return { value, error: undefined };
      },
      (error: unknown) => {
        settled = true;
        return { value: undefined, error };
      },
    );
    try {
      const active = await Promise.race([
        entered.promise,
        observed.then((completion) => {
          if (completion.error instanceof Error) throw completion.error;
          throw new Error("Run ended before the fallback Tool", { cause: completion.error });
        }),
      ]);
      expect(active.signal.aborted).toBe(false);
      f.providers.apply({
        ...f.configuration,
        revision: 2,
        providers: f.configuration.providers.map((provider) =>
          provider.connection_id === f.fallback.providerConnectionId
            ? { ...provider, enabled: false }
            : provider,
        ),
      });
      expect(active.signal.aborted).toBe(true);
      expect(toolAborted).toBe(true);
      expect(toolSettled).toBe(false);
      expect(settled).toBe(false);
      expect(f.finish).not.toHaveBeenCalled();
      release.resolve();
      const completion = await observed;
      expect(completion.error).toBeUndefined();
      expect(completion.value).toMatchObject({
        terminalClass: "unresolved",
        executorState: "quiescent",
        toolEffectState: "unknown",
        errorClass: "provider_unavailable",
      });
      expect(toolSettled).toBe(true);
      expect(f.call).toHaveBeenCalledOnce();
      expect(f.complete).toHaveBeenCalledTimes(2);
      expect(f.complete.mock.calls.map(([request]) => request.credential)).toEqual([
        "synthetic-provider-key",
        "synthetic-fallback-provider-key",
      ]);
      expect(f.events.finishToolAttempt).toHaveBeenCalledOnce();
      expect(f.events.startToolAttempt).toHaveBeenCalledOnce();
      expect(f.events.finishToolAttempt.mock.calls[0]?.[0]).toMatchObject({
        toolCallId: f.events.startToolAttempt.mock.calls[0]?.[0].toolCallId,
        status: "failed",
      });
      expect(f.finish).toHaveBeenCalledOnce();
    } finally {
      stop.abort();
      release.resolve();
      await Promise.allSettled([originalTool, running]);
    }
  });

  it.each([
    {
      revoked: "foreground" as const,
      label:
        "keeps the foreground B watch after judge A, aborting and joining B's Tool on B revocation",
    },
    {
      revoked: "judge" as const,
      label: "retires the completed judge A watch while B's Tool remains active",
    },
  ])("$label", async ({ revoked }) => {
    const f = fallbackSetup("smart_approve");
    const stop = new AbortController();
    f.input.signal = stop.signal;
    f.complete.mockResolvedValueOnce({
      kind: "tool_calls",
      content: [],
      calls: [{ id: "judged-fallback-call", name: "read", arguments: {} }],
      usage: { inputTokens: 5, outputTokens: 2 },
    });
    f.complete.mockImplementationOnce(() => {
      const proposal = f.events.appendAgentMessage.mock.calls.find(
        ([message]) => (message.toolCalls?.length ?? 0) > 0,
      )?.[0].toolCalls?.[0];
      if (proposal === undefined) throw new Error("Expected the original normalized Tool proposal");
      return Promise.resolve({
        kind: "message",
        content: [
          {
            type: "text",
            text: JSON.stringify({ request_id: proposal.id, read_only: true }),
          },
        ],
        usage: { inputTokens: 3, outputTokens: 1 },
        stopReason: "end_turn",
      });
    });
    const entered = Promise.withResolvers<Parameters<ToolCatalogPort["call"]>[0]>();
    const release = Promise.withResolvers<void>();
    let toolSettled = false;
    let toolAborted = false;
    const originalTool = release.promise
      .then(() => ({
        content: [{ type: "text" as const, text: "Original read task joined" }],
        isError: revoked === "foreground",
        toolEffectState: revoked === "foreground" ? ("unknown" as const) : ("settled" as const),
        runtimeCallStopped: true,
      }))
      .finally(() => {
        toolSettled = true;
      });
    f.call.mockImplementationOnce((request) => {
      request.signal.addEventListener(
        "abort",
        () => {
          toolAborted = true;
        },
        { once: true },
      );
      entered.resolve(request);
      return originalTool;
    });
    let settled = false;
    const running = f.executor.execute(f.input);
    const observed = running.then(
      (value) => {
        settled = true;
        return { value, error: undefined };
      },
      (error: unknown) => {
        settled = true;
        return { value: undefined, error };
      },
    );
    try {
      const active = await Promise.race([
        entered.promise,
        observed.then((completion) => {
          if (completion.error instanceof Error) throw completion.error;
          throw new Error("Run ended before the Tool authorized by judge A", {
            cause: completion.error,
          });
        }),
      ]);
      expect(
        f.complete.mock.calls.map(([request]) => ({
          purpose: request.purpose ?? "foreground",
          provider: request.snapshot.providerConnectionId,
          credential: request.credential,
        })),
      ).toEqual([
        { purpose: "foreground", provider: "provider-1", credential: "synthetic-provider-key" },
        {
          purpose: "foreground",
          provider: "provider-2",
          credential: "synthetic-fallback-provider-key",
        },
        {
          purpose: "permission_judge",
          provider: "provider-1",
          credential: "synthetic-provider-key",
        },
      ]);
      expect(active.signal.aborted).toBe(false);
      const revokedId =
        revoked === "foreground"
          ? f.fallback.providerConnectionId
          : f.input.accepted.snapshot.providerConnectionId;
      f.providers.apply({
        ...f.configuration,
        revision: 2,
        providers: f.configuration.providers.map((provider) =>
          provider.connection_id === revokedId ? { ...provider, enabled: false } : provider,
        ),
      });
      expect(stop.signal.aborted).toBe(false);
      expect(active.signal.aborted).toBe(revoked === "foreground");
      expect(toolAborted).toBe(revoked === "foreground");
      expect(toolSettled).toBe(false);
      expect(settled).toBe(false);
      expect(f.finish).not.toHaveBeenCalled();
      expect(f.complete).toHaveBeenCalledTimes(3);
      if (revoked === "judge") {
        stop.abort(new Error("Explicit Run cancellation after completed judge retirement"));
        expect(active.signal.aborted).toBe(true);
        expect(toolAborted).toBe(true);
        expect(toolSettled).toBe(false);
        expect(settled).toBe(false);
      }
      release.resolve();
      const completion = await observed;
      expect(completion.error).toBeUndefined();
      expect(completion.value).toMatchObject(
        revoked === "foreground"
          ? {
              terminalClass: "unresolved",
              executorState: "quiescent",
              toolEffectState: "unknown",
              errorClass: "provider_unavailable",
            }
          : {
              terminalClass: "cancelled",
              executorState: "quiescent",
              toolEffectState: "settled",
            },
      );
      expect(toolSettled).toBe(true);
      expect(f.call).toHaveBeenCalledOnce();
      expect(f.complete).toHaveBeenCalledTimes(3);
      expect(f.events.startModelAttempt).toHaveBeenCalledTimes(3);
      expect(f.events.finishModelAttempt).toHaveBeenCalledTimes(3);
      expect(f.events.finishToolAttempt).toHaveBeenCalledOnce();
      expect(f.finish).toHaveBeenCalledOnce();
    } finally {
      stop.abort(new Error("Join original judged Tool during fixture cleanup"));
      release.resolve();
      await Promise.allSettled([originalTool, running]);
    }
  });

  it.each([false, true])(
    "joins a revoked in-flight judge before rejecting every Tool proposal (cleanupFailure=%s)",
    async (cleanupFailure) => {
      const f = fallbackSetup("smart_approve");
      const stop = new AbortController();
      f.input.signal = stop.signal;
      f.complete.mockResolvedValueOnce({
        kind: "tool_calls",
        content: [],
        calls: [
          { id: "held-judge-first", name: "read", arguments: {} },
          { id: "held-judge-second", name: "read", arguments: {} },
        ],
        usage: { inputTokens: 5, outputTokens: 2 },
      });
      const entered = Promise.withResolvers<AuthenticatedModelRequest>();
      const release = Promise.withResolvers<void>();
      const usage = { inputTokens: 3, outputTokens: 1 };
      const cleanupSentinel = new Error("independent-judge-cleanup-private-canary");
      const failure = cleanupFailure
        ? new ModelTransportCleanupError(cleanupSentinel, usage, true)
        : new ModelError("model_unavailable", "Original judge request interrupted", true);
      failure.usage = usage;
      let originalSettled = false;
      const originalJudge = release.promise
        .then(() => {
          throw failure;
        })
        .finally(() => {
          originalSettled = true;
        });
      f.complete.mockImplementationOnce((request) => {
        entered.resolve(request);
        return originalJudge;
      });
      let settled = false;
      const running = f.executor.execute(f.input);
      const observed = running.then(
        (value) => {
          settled = true;
          return { value, error: undefined };
        },
        (error: unknown) => {
          settled = true;
          return { value: undefined, error };
        },
      );
      try {
        const judge = await Promise.race([
          entered.promise,
          observed.then((completion) => {
            if (completion.error instanceof Error) throw completion.error;
            throw new Error("Run ended before the original held judge", {
              cause: completion.error,
            });
          }),
        ]);
        expect(judge.purpose).toBe("permission_judge");
        expect(judge.snapshot.providerConnectionId).toBe("provider-1");
        expect(judge.credential).toBe("synthetic-provider-key");
        expect(f.complete).toHaveBeenCalledTimes(3);
        f.providers.apply({
          ...f.configuration,
          revision: 2,
          providers: f.configuration.providers.map((provider) =>
            provider.connection_id === f.input.accepted.snapshot.providerConnectionId
              ? { ...provider, enabled: false }
              : provider,
          ),
        });
        expect(judge.signal.aborted).toBe(true);
        expect(stop.signal.aborted).toBe(false);
        await Promise.resolve();
        expect(originalSettled).toBe(false);
        expect(settled).toBe(false);
        expect(f.finish).not.toHaveBeenCalled();
        expect(f.events.appendRejectedToolCall).not.toHaveBeenCalled();
        expect(f.events.startToolAttempt).not.toHaveBeenCalled();
        expect(f.call).not.toHaveBeenCalled();
        release.resolve();
        const completion = await observed;
        expect(completion.error).toBeUndefined();
        expect(completion.value).toMatchObject({
          terminalClass: "failed",
          executorState: "quiescent",
          toolEffectState: "none",
          errorClass: "provider_unavailable",
        });
        expect(originalSettled).toBe(true);
        await expect(originalJudge).rejects.toBe(failure);
        if (cleanupFailure) {
          expect(failure).toBeInstanceOf(ModelTransportCleanupError);
          expect(failure.cause).toBe(cleanupSentinel);
        }
        expect(f.events.finishModelAttempt).toHaveBeenCalledTimes(3);
        expect(f.events.finishModelAttempt.mock.calls[2]?.[0]).toMatchObject({
          ordinal: 3,
          outcome: "failed",
          reason: cleanupFailure ? "model_cleanup_failed" : "provider_unavailable",
          usage,
          outputStarted: cleanupFailure,
        });
        const proposals = f.events.appendAgentMessage.mock.calls.find(
          ([message]) => (message.toolCalls?.length ?? 0) > 0,
        )?.[0].toolCalls;
        expect(proposals).toHaveLength(2);
        expect(f.events.appendRejectedToolCall).toHaveBeenCalledTimes(2);
        for (const [index, proposal] of (proposals ?? []).entries()) {
          const fact: unknown = f.events.appendRejectedToolCall.mock.calls[index]?.[0];
          expect(fact).toMatchObject({ runId: "run-1", call: { id: proposal.id } });
        }
        expect(f.events.startToolAttempt).not.toHaveBeenCalled();
        expect(f.events.finishToolAttempt).not.toHaveBeenCalled();
        expect(f.call).not.toHaveBeenCalled();
        expect(f.complete).toHaveBeenCalledTimes(3);
        expect(f.events.startModelAttempt).toHaveBeenCalledTimes(3);
        expect(f.finish).toHaveBeenCalledOnce();
      } finally {
        stop.abort(new Error("Join original revoked judge during fixture cleanup"));
        release.resolve();
        await Promise.allSettled([originalJudge, running]);
      }
    },
  );
});
