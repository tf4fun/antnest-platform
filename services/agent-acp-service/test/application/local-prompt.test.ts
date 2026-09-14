import { describe, expect, it, vi } from "vitest";
import { PromptCoordinator } from "../../src/application/prompt-coordinator.js";
import type { ExecutionConfiguration } from "../../src/domain/execution-configuration.js";
import type { SessionConfiguration } from "../../src/domain/session-configuration.js";
import type { SessionRecord } from "../../src/domain/types.js";
import type { RunRepository } from "../../src/ports/run-repository.js";
import type { RuntimeProtectionRepository } from "../../src/ports/execution-repository.js";
import { executionConfiguration, executionIdentity } from "../fixtures/execution-configuration.js";
import { localExecution } from "../support/local-execution.js";

const now = new Date("2026-09-14T00:00:00Z");
const binding = { connectionId: "connection-1", ...executionIdentity() };
const session: SessionRecord = {
  id: "session-1",
  organizationId: binding.organizationId,
  principalId: binding.principalId,
  agentId: binding.agentId,
  cwd: "/workspace",
  state: "active",
  title: null,
  forkedFromSessionId: null,
  clientMcpRevisionId: "client-mcp-1",
  lastExecutionRevision: null,
  lastMessageSequence: 0,
  createdAt: now,
  updatedAt: now,
};

async function setup(overrides: SessionConfiguration = {}) {
  const local = await localExecution();
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
        sessionConfiguration: overrides,
      }),
    ),
    acceptRun: vi.fn<RunRepository["acceptRun"]>().mockResolvedValue("accepted"),
    requestCancellation: vi.fn<RunRepository["requestCancellation"]>().mockResolvedValue(),
    rejectRun: vi.fn<RunRepository["rejectRun"]>().mockResolvedValue("failed"),
  };
  const recoveryRequired = vi.fn();
  const protection = {
    hasUnstoppedRuntimeCalls: vi
      .fn<RuntimeProtectionRepository["hasUnstoppedRuntimeCalls"]>()
      .mockResolvedValue(false),
  };
  let sequence = 0;
  const coordinator = new PromptCoordinator({
    directory: local.directory,
    repository,
    protection,
    recoveryRequired,
    runTimeoutMs: 30 * 60 * 1000,
    id: () => `id-${++sequence}`,
    now: () => now,
  });
  const input = { binding, sessionId: session.id, prompt: [{ type: "text", text: "hello" }] };
  return { ...local, repository, protection, recoveryRequired, coordinator, input };
}

describe("local prompt configuration", () => {
  it.each(["same binding", "changed endpoint", "restarted process"])(
    "rejects new input on protected Runtime with %s",
    async (change) => {
      const test = await setup();
      test.protection.hasUnstoppedRuntimeCalls.mockResolvedValue(true);
      const next = executionConfiguration();
      next.revision = 2;
      if (change === "changed endpoint")
        next.agents[0]!.runtime!.mcp_endpoint = "http://runtime-new-address:8080/mcp";
      if (change === "restarted process")
        next.agents[0]!.runtime!.runtime_execution_id = "restarted-executor";
      await test.directory.apply(next);
      await expect(test.coordinator.accept(test.input)).rejects.toMatchObject({
        code: "runtime_barrier_required",
      });
      expect(test.repository.createRunIntent).not.toHaveBeenCalled();
      expect(test.repository.acceptRun).not.toHaveBeenCalled();
      expect(test.protection.hasUnstoppedRuntimeCalls).toHaveBeenCalledWith(
        {
          organizationId: binding.organizationId,
          agentId: binding.agentId,
          runtimeRevision: "runtime-1",
        },
        expect.any(AbortSignal),
      );
    },
  );

  it("uses confirmed replacement revision without deleting old stopping evidence", async () => {
    const test = await setup();
    test.protection.hasUnstoppedRuntimeCalls.mockImplementation(({ runtimeRevision }) =>
      Promise.resolve(runtimeRevision === "runtime-1"),
    );
    await expect(test.coordinator.accept(test.input)).rejects.toMatchObject({
      code: "runtime_barrier_required",
    });
    const next = executionConfiguration();
    next.revision = 2;
    next.agents[0]!.runtime!.runtime_revision = "runtime-replacement";
    await test.directory.apply(next);
    await expect(test.coordinator.accept(test.input)).resolves.toMatchObject({
      snapshot: { runtime: { revision: "runtime-replacement" } },
    });
    expect(test.repository.acceptRun).toHaveBeenCalledOnce();
  });

  it("does not accept work when durable stopping evidence cannot be read", async () => {
    const test = await setup();
    test.protection.hasUnstoppedRuntimeCalls.mockRejectedValue(
      new Error("protection query failed"),
    );
    await expect(test.coordinator.accept(test.input)).rejects.toThrow("protection query failed");
    expect(test.repository.createRunIntent).not.toHaveBeenCalled();
    expect(test.repository.acceptRun).not.toHaveBeenCalled();
  });

  it("returns the durable pre-submission cursor even if acceptance appends more events", async () => {
    const { coordinator, input, repository } = await setup();
    repository.getSession.mockResolvedValue({ ...session, lastMessageSequence: 17 });
    repository.acceptRun.mockImplementationOnce(() => {
      repository.getSession.mockResolvedValue({ ...session, lastMessageSequence: 20 });
      return Promise.resolve("accepted");
    });
    const accepted = await coordinator.accept(input);
    expect(accepted.outputSequence).toBe(17);
    expect(repository.getSession).toHaveBeenCalledOnce();
  });

  it("accepts from local configuration and preserves the input without a Controller ticket", async () => {
    const { coordinator, input, repository } = await setup();
    const accepted = await coordinator.accept(input);
    expect(accepted.snapshot).toMatchObject({
      organizationId: "organization-1",
      providerConnectionId: "provider-1",
      modelProfileId: "model-1",
      configurationRevision: 1,
      accessRevision: "access-1",
      deadlineAt: new Date("2026-09-14T00:30:00Z"),
      executionSpec: {
        model: { model: "test-model" },
        configuration: { authorization: { mode: "approve" } },
      },
    });
    expect(repository.createRunIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedAccessRevision: "access-1",
        prompt: input.prompt,
      }),
    );
    expect(repository.acceptRun).toHaveBeenCalledOnce();
    for (const forbidden of [
      "admissionId",
      "admissionDeadline",
      "credentialVersion",
      "credentialRef",
      "synthetic-provider-key",
    ]) {
      expect(JSON.stringify(accepted)).not.toContain(forbidden);
    }
  });

  it("resolves Session overrides from the same local model catalog", async () => {
    const { directory, coordinator, input } = await setup({
      modelProfileId: "model-2",
      authorizationMode: "chat",
    });
    const next = executionConfiguration();
    next.revision = 2;
    next.models.push({ ...next.models[0]!, model_profile_id: "model-2", model: "other-model" });
    await directory.apply(next);
    const accepted = await coordinator.accept(input);
    expect(accepted.snapshot).toMatchObject({
      modelProfileId: "model-2",
      executionSpec: {
        model: { model: "other-model" },
        configuration: { authorization: { mode: "chat" } },
      },
    });
  });

  it.each(["disabled", "revoked", "missing-model"] as const)(
    "does not execute with %s configuration",
    async (scenario) => {
      const { directory, coordinator, input, repository, recoveryRequired } = await setup();
      const next: ExecutionConfiguration = executionConfiguration();
      next.revision = 2;
      if (scenario === "disabled") {
        next.agents[0]!.accepting_runs = false;
        next.agents[0]!.unavailable_reason = "Rebuilding";
      }
      if (scenario === "revoked") next.agents[0]!.principal_ids = [];
      if (scenario === "missing-model") next.models[0]!.enabled = false;
      await directory.apply(next);
      await expect(coordinator.accept(input)).rejects.toMatchObject({
        code:
          scenario === "disabled"
            ? "agent_unavailable"
            : scenario === "revoked"
              ? "access_denied"
              : "model_unavailable",
      });
      expect(repository.acceptRun).not.toHaveBeenCalled();
      expect(recoveryRequired).not.toHaveBeenCalled();
    },
  );

  it("cannot access another organization's Session", async () => {
    const { coordinator, input, repository } = await setup();
    repository.getSession.mockResolvedValue({ ...session, organizationId: "another-organization" });
    await expect(coordinator.accept(input)).rejects.toMatchObject({
      code: "session_access_denied",
    });
    expect(repository.createRunIntent).not.toHaveBeenCalled();
  });

  it("records cancellation arriving after local intent creation without accepting a prompt", async () => {
    const { coordinator, input, repository, recoveryRequired } = await setup();
    const cancellation = new AbortController();
    repository.createRunIntent.mockImplementationOnce((request) => {
      cancellation.abort();
      return Promise.resolve({
        id: request.runId,
        requestId: request.requestId,
        sessionId: request.sessionId,
        clientMcpRevisionId: "client-mcp-1",
        expectedAccessRevision: "access-1",
        state: "admitting",
        userMessageId: request.userMessageId,
        prompt: request.prompt,
      });
    });
    await expect(coordinator.accept(input, cancellation.signal)).rejects.toMatchObject({
      code: "run_cancelled",
    });
    expect(repository.requestCancellation).toHaveBeenCalledOnce();
    expect(repository.rejectRun).toHaveBeenCalledOnce();
    expect(repository.acceptRun).not.toHaveBeenCalled();
    expect(recoveryRequired).not.toHaveBeenCalled();
  });

  it("stops the worker on an uncertain local acceptance commit, without replaying it", async () => {
    const { coordinator, input, repository, recoveryRequired } = await setup();
    repository.acceptRun.mockRejectedValue(new Error("commit acknowledgement lost"));
    await expect(coordinator.accept(input)).rejects.toThrow("commit acknowledgement lost");
    expect(repository.acceptRun).toHaveBeenCalledOnce();
    expect(repository.rejectRun).not.toHaveBeenCalled();
    expect(recoveryRequired).toHaveBeenCalledOnce();
  });

  it("does not hold model credentials in a snapshot across rotation", async () => {
    const { coordinator, input, directory } = await setup();
    const before = await coordinator.accept(input);
    const next = executionConfiguration();
    next.revision = 2;
    next.providers[0]!.credential_revision = "credential-2";
    next.providers[0]!.credential.secret = "synthetic-rotated-key";
    await directory.apply(next);
    const after = await coordinator.accept(input);
    expect(after.snapshot.executionSpec).toEqual(before.snapshot.executionSpec);
    expect(after.snapshot.agentExecutionSpecDigest).toBe(before.snapshot.agentExecutionSpecDigest);
    expect(JSON.stringify(after)).not.toContain("synthetic-rotated-key");
  });
});
