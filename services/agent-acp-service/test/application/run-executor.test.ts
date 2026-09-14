import { afterEach, describe, expect, it, vi } from "vitest";

import { RunExecutor, type RunExecutorDependencies } from "../../src/application/run-executor.js";
import {
  RunRecoveryRequiredError,
  type RunExecutionInput,
} from "../../src/ports/acp-application.js";
import { WorkerOwnershipLostError } from "../../src/adapters/postgres/worker-lock.js";
import { ContextBuilder } from "../../src/application/context-builder.js";
import { ProviderClients } from "../../src/application/provider-clients.js";
import { runtimeInformation } from "../fixtures/runtime-information.js";
import { executionConfiguration } from "../fixtures/execution-configuration.js";
import { snapshot } from "../support/fixtures.js";
import type { ExecutionConfiguration } from "../../src/domain/execution-configuration.js";
import type { RuntimeInformationPort } from "../../src/ports/runtime-information.js";
import type { ExecutionRepository } from "../../src/ports/execution-repository.js";
import type { AuthenticatedModelTransport } from "../../src/ports/model.js";
import type { RunEventRepository } from "../../src/ports/run-event-repository.js";
import type { ToolCatalogPort } from "../../src/ports/tools.js";

afterEach(() => vi.restoreAllMocks());

describe("RunExecutor", () => {
  it.each(["success", "cancelled", "expired", "persistence-failed", "ownership-lost"] as const)(
    "handles help %s without model, credentials or Runtime setup",
    async (scenario) => {
      const test = setup();
      test.input.accepted.command = { name: "help", locale: "en" };
      const acquire = vi.spyOn(test.providers, "acquire");
      const appendAgentMessage = vi.spyOn(test.events, "appendAgentMessage");
      const appendUsage = vi.spyOn(test.events, "appendUsage");
      if (scenario === "cancelled") test.cancellation.abort();
      if (scenario === "expired") test.input.accepted.snapshot.deadlineAt = new Date("2026-08-29");
      if (scenario === "ownership-lost") test.ownership.abort(new WorkerOwnershipLostError());
      if (scenario === "persistence-failed")
        appendAgentMessage.mockRejectedValue(new Error("database unavailable"));

      const result = test.execute();
      if (scenario === "ownership-lost") {
        await expect(result).rejects.toBeInstanceOf(WorkerOwnershipLostError);
      } else if (scenario === "persistence-failed") {
        await expect(result).rejects.toBeInstanceOf(RunRecoveryRequiredError);
        expect(test.recoveryRequired).toHaveBeenCalledOnce();
      } else {
        await expect(result).resolves.toMatchObject({
          terminalClass:
            scenario === "success" ? "completed" : scenario === "expired" ? "failed" : "cancelled",
          toolEffectState: "none",
        });
        expect(test.finish).toHaveBeenCalledOnce();
      }
      if (scenario === "success") {
        expect(appendAgentMessage).toHaveBeenCalledOnce();
        expect(appendAgentMessage.mock.calls[0]?.[0].runId).toBe(test.input.accepted.runId);
        expect(appendAgentMessage.mock.calls[0]?.[0].content[0]?.text).toContain("/help");
      } else if (scenario !== "persistence-failed") {
        expect(appendAgentMessage).not.toHaveBeenCalled();
      }
      if (scenario === "persistence-failed" || scenario === "ownership-lost")
        expect(test.finish).not.toHaveBeenCalled();
      expect(test.build).not.toHaveBeenCalled();
      expect(acquire).not.toHaveBeenCalled();
      expect(test.complete).not.toHaveBeenCalled();
      expect(test.tools.list).not.toHaveBeenCalled();
      expect(test.tools.call).not.toHaveBeenCalled();
      expect(appendUsage).not.toHaveBeenCalled();
    },
  );

  it("passes Runtime context into the actual model request without publishing it", async () => {
    const test = setup();
    const read = vi.fn<RuntimeInformationPort["read"]>().mockResolvedValue(runtimeInformation());
    const saveCheckpoint = vi.fn();
    test.dependencies.contextBuilder = new ContextBuilder({
      runtimeInformation: { read },
      tools: test.tools,
      repository: {
        load: vi.fn().mockResolvedValue({
          checkpoint: null,
          messages: [
            { sequence: 1, kind: "user_message", content: [{ type: "text", text: "hello" }] },
          ],
        }),
        saveCheckpoint,
      },
      id: sequentialIds(),
      now: test.dependencies.now,
    });
    await expect(test.execute()).resolves.toMatchObject({ terminalClass: "completed" });
    const request = test.complete.mock.calls[0]?.[0];
    expect(JSON.stringify(request?.messages)).toContain("Use the company style guide");
    expect(JSON.stringify(request?.messages)).toContain("documents/SKILL.md");
    expect(JSON.stringify(test.publish.mock.calls)).not.toContain("Use the company style guide");
    expect(saveCheckpoint).not.toHaveBeenCalled();
    expect(test.tools.list).toHaveBeenCalledOnce();
  });

  it("cancels Runtime information setup before any model or tool call", async () => {
    const test = setup();
    const started = Promise.withResolvers<void>();
    const read: RuntimeInformationPort["read"] = (_snapshot, signal) =>
      new Promise((_, reject) => {
        started.resolve();
        signal.addEventListener("abort", () => reject(new Error("read cancelled")), { once: true });
      });
    test.dependencies.contextBuilder = new ContextBuilder({
      runtimeInformation: { read },
      tools: test.tools,
      repository: { load: vi.fn(), saveCheckpoint: vi.fn() },
      id: sequentialIds(),
      now: test.dependencies.now,
    });
    const result = test.execute();
    await started.promise;
    test.cancellation.abort();
    await expect(result).resolves.toMatchObject({
      terminalClass: "cancelled",
      toolEffectState: "none",
    });
    expect(test.complete).not.toHaveBeenCalled();
    expect(test.tools.list).not.toHaveBeenCalled();
    expect(test.tools.call).not.toHaveBeenCalled();
  });

  it("persists the terminal state locally without a Controller receipt or credential", async () => {
    const test = setup();
    await expect(test.execute()).resolves.toMatchObject({ terminalClass: "completed" });
    expect(test.finish).toHaveBeenCalledExactlyOnceWith({
      runId: "run-1",
      terminalClass: "completed",
      executorState: "quiescent",
      toolEffectState: "none",
      stopReason: "end_turn",
      finishedAt: test.dependencies.now(),
    });
    expect(test.complete.mock.calls[0]?.[0].credential).toBe("synthetic-provider-key");
    expect(JSON.stringify(test.finish.mock.calls)).not.toContain("synthetic-provider-key");
    expect(JSON.stringify(test.input.accepted)).not.toContain("synthetic-provider-key");
    expect(test.recoveryRequired).not.toHaveBeenCalled();
  });

  it("finishes with local dependencies without contacting a Controller endpoint", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network unavailable"));
    const test = setup();
    await expect(test.execute()).resolves.toMatchObject({ terminalClass: "completed" });
    expect(test.finish).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    expect(test.recoveryRequired).not.toHaveBeenCalled();
  });

  it("requests process replacement when the local terminal state cannot be persisted", async () => {
    const test = setup();
    test.finish.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(test.execute()).rejects.toBeInstanceOf(RunRecoveryRequiredError);
    expect(test.finish).toHaveBeenCalledOnce();
    expect(test.recoveryRequired).toHaveBeenCalledOnce();
  });

  it("does not terminalize a Run when durable event persistence requires recovery", async () => {
    const test = setup();
    vi.spyOn(test.events, "appendUsage").mockRejectedValue(new Error("database unavailable"));
    await expect(test.execute()).rejects.toBeInstanceOf(RunRecoveryRequiredError);
    expect(test.finish).not.toHaveBeenCalled();
    expect(test.recoveryRequired).toHaveBeenCalledOnce();
  });

  it("does not start model or Tool work after the local execution deadline", async () => {
    const test = setup();
    const acquire = vi.spyOn(test.providers, "acquire");
    test.input.accepted.snapshot.deadlineAt = new Date("2026-08-29T23:59:59Z");
    await expect(test.execute()).resolves.toMatchObject({
      terminalClass: "failed",
      executorState: "quiescent",
      toolEffectState: "none",
      errorClass: "run_deadline_exceeded",
    });
    expect(test.complete).not.toHaveBeenCalled();
    expect(test.build).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
  });

  it("uses current authentication even when the accepted Run predates its rotation", async () => {
    const test = setup();
    const original = structuredClone(test.input.accepted.snapshot);
    const provider = test.configuration.providers[0]!;
    test.providers.apply({
      ...test.configuration,
      revision: 2,
      providers: [
        {
          ...provider,
          enabled: true,
          credential_revision: "credential-2",
          credential: { method: "api_key", secret: "rotated-synthetic-key" },
        },
      ],
    });
    await expect(test.execute()).resolves.toMatchObject({ terminalClass: "completed" });
    expect(test.complete.mock.calls[0]?.[0].credential).toBe("rotated-synthetic-key");
    expect(test.input.accepted.snapshot).toEqual(original);
    expect(JSON.stringify(test.finish.mock.calls)).not.toContain("rotated-synthetic-key");
  });

  it("fails locally when the Provider retires before the accepted Run acquires its client", async () => {
    const test = setup();
    test.providers.apply({
      ...test.configuration,
      revision: 2,
      providers: test.configuration.providers.map((provider) => ({ ...provider, enabled: false })),
    });
    await expect(test.execute()).resolves.toMatchObject({
      terminalClass: "failed",
      errorClass: "provider_unavailable",
    });
    expect(test.build).not.toHaveBeenCalled();
    expect(test.complete).not.toHaveBeenCalled();
    expect(test.finish).toHaveBeenCalledOnce();
  });

  it("does not persist or close a Run after worker ownership is lost", async () => {
    const test = setup();
    const appendUsage = vi.spyOn(test.events, "appendUsage");
    const appendAgentMessage = vi.spyOn(test.events, "appendAgentMessage");
    test.complete.mockImplementationOnce(() => {
      test.ownership.abort(new WorkerOwnershipLostError());
      return Promise.resolve({
        kind: "message",
        content: [{ type: "text", text: "stale" }],
        usage: { inputTokens: 2, outputTokens: 1 },
        stopReason: "end_turn",
      });
    });
    await expect(test.execute()).rejects.toBeInstanceOf(WorkerOwnershipLostError);
    expect(appendUsage).not.toHaveBeenCalled();
    expect(appendAgentMessage).not.toHaveBeenCalled();
    expect(test.finish).not.toHaveBeenCalled();
  });
});

function setup() {
  const configuration: ExecutionConfiguration = executionConfiguration();
  const execution = snapshot();
  configuration.providers[0]!.connection_id = execution.providerConnectionId;
  configuration.providers[0]!.base_url = execution.executionSpec.model.baseUrl;
  configuration.models[0]!.connection_id = execution.providerConnectionId;
  configuration.models[0]!.model_profile_id = execution.modelProfileId;
  configuration.agents[0]!.default_model_profile_id = execution.modelProfileId;
  const complete = vi.fn<AuthenticatedModelTransport["complete"]>().mockResolvedValue({
    kind: "message",
    content: [{ type: "text", text: "done" }],
    usage: { inputTokens: 2, outputTokens: 1 },
    stopReason: "end_turn",
  });
  const providers = new ProviderClients({ complete });
  providers.apply(configuration);
  const finish = vi.fn<ExecutionRepository["finish"]>().mockResolvedValue();
  const build = vi.fn<RunExecutorDependencies["contextBuilder"]["build"]>().mockResolvedValue({
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    tools: [],
    runtimeWorkspace: "/workspace",
  });
  const tools = {
    list: vi.fn<ToolCatalogPort["list"]>().mockResolvedValue([]),
    call: vi.fn<ToolCatalogPort["call"]>(),
  };
  const events = eventRepository();
  const ownership = new AbortController();
  const cancellation = new AbortController();
  const recoveryRequired = vi.fn();
  const dependencies: RunExecutorDependencies = {
    providers,
    executions: {
      finish,
      getState: vi.fn().mockResolvedValue("running"),
      listRecoveryWork: vi.fn(),
    },
    contextBuilder: { build },
    tools,
    events,
    ownershipSignal: ownership.signal,
    recoveryRequired,
    id: sequentialIds(),
    now: () => new Date("2026-08-30T00:00:00Z"),
  };
  const publish = vi.fn<RunExecutionInput["publish"]>().mockResolvedValue();
  const input: RunExecutionInput = {
    accepted: {
      outputSequence: 0,
      runId: "run-1",
      requestId: "request-1",
      sessionId: "session-1",
      userMessageId: "message-1",
      snapshot: execution,
    },
    publish,
    signal: cancellation.signal,
  };
  return {
    configuration,
    dependencies,
    providers,
    complete,
    build,
    tools,
    events,
    ownership,
    cancellation,
    recoveryRequired,
    finish,
    publish,
    input,
    execute: () => new RunExecutor(dependencies).execute(input),
  };
}

function eventRepository(): RunEventRepository {
  return {
    appendAgentMessage: vi.fn<RunEventRepository["appendAgentMessage"]>((input) =>
      Promise.resolve({ kind: "agent_message", messageId: input.id, content: input.content }),
    ),
    appendUsage: vi.fn<RunEventRepository["appendUsage"]>((input) =>
      Promise.resolve({
        kind: "usage",
        used: (input.usage.inputTokens ?? 0) + (input.usage.outputTokens ?? 0),
        size: input.contextSize,
      }),
    ),
    appendPlan: vi.fn(),
    appendAgentThought: vi.fn(),
    appendToolProgress: vi.fn(),
    appendRejectedToolCall: vi.fn(),
    startToolAttempt: vi.fn(),
    finishToolAttempt: vi.fn(),
    interruptToolAttempts: vi.fn(),
  };
}

function sequentialIds(): () => string {
  let next = 0;
  return () => `id-${++next}`;
}
