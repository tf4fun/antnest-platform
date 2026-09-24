import { describe, expect, it, vi } from "vitest";

import { PromptCoordinator } from "../../src/application/prompt-coordinator.js";
import { bridgeIntentDigest } from "../../src/domain/bridge-intent.js";
import type { ContentBlock } from "../../src/domain/types.js";
import type { RunIntent, RunRepository } from "../../src/ports/run-repository.js";
import { executionConfiguration } from "../fixtures/execution-configuration.js";
import { binding, sessionRecord } from "../support/fixtures.js";
import { localExecution } from "../support/local-execution.js";

const now = new Date("2026-08-30T00:00:00Z");

async function setup(initialize = true) {
  const local = await localExecution(false);
  const configuration = executionConfiguration();
  configuration.agents[0]!.execution_revision = "execution-2";
  configuration.agents[0]!.runtime = {
    runtime_revision: "runtime-2",
    runtime_execution_id: "runtime-execution-2",
    mcp_endpoint: "http://runtime-2:8080/mcp",
  };
  if (initialize) await local.directory.apply(configuration);
  const session = {
    ...sessionRecord(),
    lastExecutionRevision: "execution-1",
    lastMessageSequence: 1,
  };
  const repository = {
    getSession: vi.fn<RunRepository["getSession"]>().mockResolvedValue(session),
    createRunIntent: vi.fn<RunRepository["createRunIntent"]>((input) =>
      Promise.resolve({
        id: input.runId,
        requestId: input.requestId,
        sessionId: input.sessionId,
        clientMcpRevisionId: session.clientMcpRevisionId,
        expectedAccessRevision: input.expectedAccessRevision,
        state: "admitting",
        userMessageId: input.userMessageId,
        prompt: input.prompt,
      }),
    ),
    findBridgeIntent: vi.fn().mockResolvedValue(null),
    acceptRun: vi.fn<RunRepository["acceptRun"]>().mockResolvedValue("accepted"),
    requestCancellation: vi.fn<RunRepository["requestCancellation"]>().mockResolvedValue(),
    rejectRun: vi.fn<RunRepository["rejectRun"]>().mockResolvedValue("failed"),
  };
  const recoveryRequired = vi.fn();
  let nextId = 0;
  const coordinator = new PromptCoordinator({
    repository,
    directory: local.directory,
    protection: { hasUnstoppedRuntimeCalls: () => Promise.resolve(false) },
    runTimeoutMs: 600_000,
    recoveryRequired,
    id: () => `id-${++nextId}`,
    now: () => now,
  });
  const input = {
    binding: binding(),
    sessionId: session.id,
    prompt: [{ type: "text", text: "hello" }],
  };
  return { ...local, configuration, repository, recoveryRequired, coordinator, input };
}

describe("PromptCoordinator", () => {
  it("passes a Bridge intent through authorization into durable Run reservation", async () => {
    const test = await setup();
    const bridgeIntent = { intentId: "intent-1", expectedAppendVersion: 3 };
    await test.coordinator.accept({ ...test.input, bridgeIntent });
    expect(test.repository.createRunIntent).toHaveBeenCalledWith(
      expect.objectContaining({ bridgeIntent }),
    );
  });

  it("detects a duplicate or conflicting Bridge intent before new admission", async () => {
    const test = await setup();
    const bridgeIntent = { intentId: "intent-1", expectedAppendVersion: 0 };
    const digest = bridgeIntentDigest(0, test.input.prompt);
    test.repository.findBridgeIntent.mockResolvedValueOnce({ digest });
    await expect(
      test.coordinator.checkBridgeIntent({ ...test.input, bridgeIntent }),
    ).rejects.toMatchObject({ code: "intent_already_recorded" });
    test.repository.findBridgeIntent.mockResolvedValueOnce({ digest: "0".repeat(64) });
    await expect(
      test.coordinator.checkBridgeIntent({ ...test.input, bridgeIntent }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(test.repository.createRunIntent).not.toHaveBeenCalled();
  });

  it.each(["/帮助", "ordinary request"])(
    "classifies %s after local acceptance without changing the saved prompt",
    async (text) => {
      const test = await setup();
      const prompt: ContentBlock[] = [
        {
          type: "resource",
          resource: { uri: "file:///notes.txt", mimeType: "text/plain", text: "/help" },
        },
        { type: "text", text },
      ];
      const result = await test.coordinator.accept({ ...test.input, prompt });
      expect(result.command).toEqual(text === "/帮助" ? { name: "help", locale: "zh" } : undefined);
      expect(test.repository.acceptRun).toHaveBeenCalledOnce();
      expect(test.repository.createRunIntent).toHaveBeenCalledWith(
        expect.objectContaining({ prompt }),
      );
    },
  );

  it("rejects an unavailable Agent before creating an intent or accepting a message", async () => {
    const test = await setup();
    test.configuration.revision = 2;
    test.configuration.agents[0]!.accepting_runs = false;
    test.configuration.agents[0]!.unavailable_reason = "Agent is rebuilding";
    await test.directory.apply(test.configuration);
    await expect(test.coordinator.accept(test.input)).rejects.toMatchObject({
      code: "agent_unavailable",
    });
    expect(test.repository.createRunIntent).not.toHaveBeenCalled();
    expect(test.repository.acceptRun).not.toHaveBeenCalled();
    expect(test.repository.rejectRun).not.toHaveBeenCalled();
    expect(test.recoveryRequired).not.toHaveBeenCalled();
  });

  it("refuses cold-start execution without manufacturing an uncertain Controller admission", async () => {
    const test = await setup(false);
    await expect(test.coordinator.accept(test.input)).rejects.toMatchObject({
      code: "configuration_not_ready",
    });
    expect(test.repository.createRunIntent).not.toHaveBeenCalled();
    expect(test.repository.acceptRun).not.toHaveBeenCalled();
    expect(test.recoveryRequired).not.toHaveBeenCalled();
  });

  it.each(["createRunIntent", "acceptRun"] as const)(
    "leaves uncertain local %s commits for interruption cleanup without replay",
    async (operation) => {
      const test = await setup();
      test.repository[operation].mockRejectedValueOnce(new Error("commit acknowledgement lost"));
      await expect(test.coordinator.accept(test.input)).rejects.toThrow(
        "commit acknowledgement lost",
      );
      expect(test.repository[operation]).toHaveBeenCalledOnce();
      expect(test.repository.rejectRun).not.toHaveBeenCalled();
      expect(test.recoveryRequired).toHaveBeenCalledOnce();
    },
  );

  it("rejects an invalid local model without persisting an accepted prompt", async () => {
    const test = await setup();
    test.configuration.revision = 2;
    test.configuration.models[0]!.enabled = false;
    await test.directory.apply(test.configuration);
    await expect(test.coordinator.accept(test.input)).rejects.toMatchObject({
      code: "model_unavailable",
    });
    expect(test.repository.createRunIntent).toHaveBeenCalledOnce();
    expect(test.repository.acceptRun).not.toHaveBeenCalled();
    expect(test.repository.rejectRun).toHaveBeenCalledExactlyOnceWith(
      "id-1",
      "model_unavailable",
      now,
    );
    expect(test.recoveryRequired).not.toHaveBeenCalled();
  });

  it("requires interruption cleanup if persisting the rejected intent fails", async () => {
    const test = await setup();
    test.configuration.revision = 2;
    test.configuration.models[0]!.enabled = false;
    await test.directory.apply(test.configuration);
    test.repository.rejectRun.mockRejectedValueOnce(new Error("rejection commit lost"));
    await expect(test.coordinator.accept(test.input)).rejects.toThrow("rejection commit lost");
    expect(test.repository.rejectRun).toHaveBeenCalledOnce();
    expect(test.repository.acceptRun).not.toHaveBeenCalled();
    expect(test.recoveryRequired).toHaveBeenCalledOnce();
  });

  it("atomically accepts the snapshot, environment fact, and user message", async () => {
    const test = await setup();
    const result = await test.coordinator.accept(test.input);
    expect(result.snapshot.executionRevision).toBe("execution-2");
    expect(result.snapshot.deadlineAt).toEqual(new Date("2026-08-30T00:10:00Z"));
    expect(result.outputSequence).toBe(1);
    expect(test.repository.acceptRun).toHaveBeenCalledOnce();
    expect(test.repository.acceptRun.mock.calls[0]?.[0]).toMatchObject({
      runId: result.runId,
      snapshot: result.snapshot,
      environmentFact: {
        kind: "environment_change",
        visible: false,
        previousExecutionRevision: "execution-1",
        currentExecutionRevision: "execution-2",
      },
      sessionTitle: "hello",
    });
    expect(test.repository.acceptRun.mock.calls[0]?.[0].environmentFact?.content).toContain("/tmp");
    expect(test.repository.createRunIntent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        userMessageId: result.userMessageId,
        expectedAccessRevision: "access-1",
        prompt: test.input.prompt,
      }),
    );
    expect(test.recoveryRequired).not.toHaveBeenCalled();
  });

  it("captures a fresh immutable local execution snapshot for every accepted prompt", async () => {
    const test = await setup();
    const first = await test.coordinator.accept(test.input);
    const original = structuredClone(first.snapshot);
    test.configuration.revision = 2;
    test.configuration.agents[0]!.execution_revision = "execution-3";
    test.configuration.agents[0]!.runtime = {
      runtime_revision: "runtime-3",
      runtime_execution_id: "runtime-execution-3",
      mcp_endpoint: "http://runtime-3:8080/mcp",
    };
    await test.directory.apply(test.configuration);
    const second = await test.coordinator.accept(test.input);
    expect(first.snapshot).toEqual(original);
    expect(first.snapshot).toMatchObject({
      executionRevision: "execution-2",
      runtime: { revision: "runtime-2" },
    });
    expect(second.snapshot).toMatchObject({
      configurationRevision: 2,
      executionRevision: "execution-3",
      runtime: { revision: "runtime-3" },
    });
    expect(test.repository.acceptRun).toHaveBeenCalledTimes(2);
  });

  it("records cancellation during intent persistence locally before accepting the prompt", async () => {
    const test = await setup();
    const intent = Promise.withResolvers<RunIntent>();
    const started = Promise.withResolvers<RunIntent>();
    const original = test.repository.createRunIntent.getMockImplementation()!;
    test.repository.createRunIntent.mockImplementationOnce(async (input) => {
      started.resolve(await original(input));
      return intent.promise;
    });
    const cancellation = new AbortController();
    const acceptance = test.coordinator.accept(test.input, cancellation.signal);
    const record = await started.promise;
    cancellation.abort();
    intent.resolve(record);
    await expect(acceptance).rejects.toMatchObject({ code: "run_cancelled" });
    expect(test.repository.requestCancellation).toHaveBeenCalledExactlyOnceWith(record.id, now);
    expect(test.repository.rejectRun).toHaveBeenCalledExactlyOnceWith(
      record.id,
      "run_cancelled",
      now,
    );
    expect(test.repository.acceptRun).not.toHaveBeenCalled();
    expect(test.recoveryRequired).not.toHaveBeenCalled();
  });

  it("does not expose an accepted result when the commit observes cancellation", async () => {
    const test = await setup();
    test.repository.acceptRun.mockResolvedValueOnce("cancelled");
    await expect(test.coordinator.accept(test.input)).rejects.toMatchObject({
      code: "run_cancelled",
    });
    expect(test.repository.acceptRun).toHaveBeenCalledOnce();
    expect(test.repository.rejectRun).not.toHaveBeenCalled();
    expect(test.recoveryRequired).not.toHaveBeenCalled();
  });

  it("does not create an intent when cancellation is already known", async () => {
    const test = await setup();
    const cancellation = new AbortController();
    cancellation.abort();
    await expect(test.coordinator.accept(test.input, cancellation.signal)).rejects.toMatchObject({
      code: "run_cancelled",
    });
    expect(test.repository.createRunIntent).not.toHaveBeenCalled();
  });

  it("rejects unsupported attachments before creating an intent", async () => {
    const test = await setup();
    await expect(
      test.coordinator.accept({
        ...test.input,
        prompt: [
          {
            type: "resource",
            resource: {
              uri: "attachment:///file.pdf",
              mimeType: "application/pdf",
              blob: "JVBERg==",
            },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "unsupported_resource_content" });
    expect(test.repository.createRunIntent).not.toHaveBeenCalled();
    expect(test.repository.acceptRun).not.toHaveBeenCalled();
    expect(test.recoveryRequired).not.toHaveBeenCalled();
  });
});
