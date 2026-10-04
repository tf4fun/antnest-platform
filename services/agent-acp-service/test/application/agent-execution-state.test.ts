import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentExecutionState } from "../../src/application/agent-execution-state.js";
import { RunSupervisor } from "../../src/application/run-supervisor.js";
import type { AgentExecutionStateView } from "../../src/domain/agent-execution-state.js";
import type { RuntimeProtectionRepository } from "../../src/ports/execution-repository.js";
import type { ExecuteRunResult, SubmittedAcpRun } from "../../src/ports/acp-application.js";
import {
  executionConfiguration,
  executionIdentity,
  runtimeConfiguration,
} from "../fixtures/execution-configuration.js";
import { localExecution } from "../support/local-execution.js";
import { snapshot } from "../support/fixtures.js";

const completed: ExecuteRunResult = {
  terminalClass: "completed",
  executorState: "quiescent",
  toolEffectState: "none",
  stopReason: "end_turn",
};
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function setup(initialize = true) {
  const local = await localExecution(initialize);
  const completion = Promise.withResolvers<ExecuteRunResult>();
  const supervisor = new RunSupervisor({ execute: () => completion.promise });
  const protection = {
    hasUnstoppedRuntimeCalls: vi
      .fn<RuntimeProtectionRepository["hasUnstoppedRuntimeCalls"]>()
      .mockResolvedValue(false),
  };
  const service = new AgentExecutionState({ directory: local.directory, supervisor, protection });
  cleanup.push(async () => {
    completion.resolve(completed);
    await supervisor.shutdown();
  });
  const start = (principalId = executionIdentity().principalId) =>
    supervisor.submit(
      {
        binding: { ...executionIdentity(), principalId, connectionId: "connection-A" },
        sessionId: "session-1",
        outputChanged: () => undefined,
      },
      () =>
        Promise.resolve({
          runId: "run-1",
          requestId: "request-1",
          sessionId: "session-1",
          userMessageId: "message-1",
          outputSequence: 0,
          snapshot: snapshot(),
        }),
    );
  return { ...local, service, supervisor, protection, completion, start };
}

async function read(service: AgentExecutionState, identity = executionIdentity()) {
  let result: AgentExecutionStateView | undefined;
  await service.read(
    identity,
    (state) => {
      result = state;
      return Promise.resolve();
    },
    new AbortController().signal,
  );
  if (result === undefined) throw new Error("State was not delivered");
  return result;
}

describe("ACP-owned workspace execution state", () => {
  it("projects idle availability without exposing Run or credential data", async () => {
    const test = await setup();
    const state = await read(test.service);
    expect(state).toEqual({
      agent_id: "agent-1",
      availability: "ready",
      access_allowed: true,
      active_session_id: null,
      configuration_revision: state.configuration_revision,
      unavailable_reason: null,
    });
    expect(state.configuration_revision).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.each([executionIdentity().principalId, "another-user"])(
    "discloses an active Session only to its owner (%s)",
    async (owner) => {
      const test = await setup();
      await test.start(owner);
      expect(await read(test.service)).toMatchObject({
        availability: "busy",
        active_session_id: owner === executionIdentity().principalId ? "session-1" : null,
      });
    },
  );

  it("includes pending acceptance and releases occupancy after acceptance failure", async () => {
    const test = await setup();
    const pending = Promise.withResolvers<never>();
    const running = test.supervisor.submit(
      {
        binding: { ...executionIdentity(), connectionId: "A" },
        sessionId: "session-1",
        outputChanged: () => undefined,
      },
      () => pending.promise,
    );
    const rejected = expect(running).rejects.toThrow("Rejected");
    expect(await read(test.service)).toMatchObject({
      availability: "busy",
      active_session_id: "session-1",
    });
    pending.reject(new Error("Rejected"));
    await rejected;
    expect(await read(test.service)).toHaveProperty("availability", "ready");
  });

  it("keeps an existing Run discoverable and cancellable after closing new execution", async () => {
    const test = await setup();
    const active = await test.start();
    const closed = executionConfiguration();
    closed.revision = 2;
    closed.agents[0]!.accepting_runs = false;
    delete closed.agents[0]!.runtime?.credential;
    await test.directory.apply(closed);
    const state = await read(test.service);
    expect(state).toMatchObject({
      availability: "busy",
      active_session_id: "session-1",
      unavailable_reason: "agent_unavailable",
    });
    const cancelled = test.supervisor.cancel(state.active_session_id!);
    test.completion.resolve(completed);
    await active.completion;
    await cancelled;
    expect(await read(test.service)).toMatchObject({
      availability: "offline",
      active_session_id: null,
    });
  });

  it.each(["principal", "agent"])(
    "does not disclose configuration or Session identifiers across %s",
    async (kind) => {
      const test = await setup();
      await test.start();
      const identity = {
        ...executionIdentity(),
        ...(kind === "principal" ? { principalId: "other" } : { agentId: "other" }),
      };
      expect(await read(test.service, identity)).toEqual({
        agent_id: identity.agentId,
        availability: "offline",
        access_allowed: false,
        active_session_id: null,
        configuration_revision: null,
        unavailable_reason: "access_denied",
      });
      expect(test.protection.hasUnstoppedRuntimeCalls).not.toHaveBeenCalled();
    },
  );

  it("does not fabricate idle on a cold organization or failed evidence read", async () => {
    const test = await setup(false);
    await expect(read(test.service)).rejects.toMatchObject({ code: "configuration_not_ready" });
    await test.directory.apply(executionConfiguration());
    test.protection.hasUnstoppedRuntimeCalls.mockRejectedValue(new Error("Database unavailable"));
    await expect(read(test.service)).rejects.toThrow("Database unavailable");
  });

  it("projects durable stopping protection without changing the configuration token", async () => {
    const test = await setup();
    const before = await read(test.service);
    test.protection.hasUnstoppedRuntimeCalls.mockResolvedValue(true);
    expect(await read(test.service)).toMatchObject({
      availability: "offline",
      unavailable_reason: "runtime_barrier_required",
      configuration_revision: before.configuration_revision,
    });
  });

  it.each(["organization revision", "another Agent", "credential", "lifecycle"])(
    "does not reset configuration for %s",
    async (change) => {
      const test = await setup();
      const before = await read(test.service);
      const next = executionConfiguration();
      next.revision = 2;
      if (change === "another Agent")
        next.agents.push({
          ...next.agents[0]!,
          agent_id: "other",
          system_prompt: "Different",
          runtime: runtimeConfiguration(2),
        });
      if (change === "credential") {
        next.providers[0]!.credential_revision = "rotated";
        next.providers[0]!.credential.secret = "rotated-secret";
      }
      if (change === "lifecycle") {
        next.agents[0]!.accepting_runs = false;
        delete next.agents[0]!.runtime?.credential;
        next.agents[0]!.operation_id = "operation-2";
      }
      await test.directory.apply(next);
      expect((await read(test.service)).configuration_revision).toBe(before.configuration_revision);
    },
  );

  it.each(["Agent settings", "Runtime", "model catalog"])(
    "changes configuration comparison for %s",
    async (change) => {
      const test = await setup();
      const before = await read(test.service);
      const next = executionConfiguration();
      next.revision = 2;
      if (change === "Agent settings") next.agents[0]!.system_prompt = "Changed";
      if (change === "Runtime") next.agents[0]!.runtime = runtimeConfiguration(2);
      if (change === "model catalog") next.models[0]!.context_window += 100;
      await test.directory.apply(next);
      expect((await read(test.service)).configuration_revision).not.toBe(
        before.configuration_revision,
      );
    },
  );

  it("rechecks access after a pending database read without delaying revocation", async () => {
    const test = await setup();
    const evidence = Promise.withResolvers<boolean>();
    const entered = Promise.withResolvers<void>();
    test.protection.hasUnstoppedRuntimeCalls.mockImplementation(() => {
      entered.resolve();
      return evidence.promise;
    });
    const pending = read(test.service);
    await entered.promise;
    await test.directory.apply({ ...executionConfiguration(), revision: 2, agents: [] });
    evidence.resolve(false);
    expect(await pending).toMatchObject({
      access_allowed: false,
      active_session_id: null,
      configuration_revision: null,
    });
  });

  it("does not enqueue a stale idle view when execution starts after reading evidence", async () => {
    const test = await setup();
    const started = Promise.withResolvers<SubmittedAcpRun>();
    const occupancy = test.supervisor.occupancy.bind(test.supervisor);
    vi.spyOn(test.supervisor, "occupancy")
      .mockImplementationOnce(occupancy)
      .mockImplementationOnce((identity) => {
        const value = occupancy(identity);
        queueMicrotask(() => started.resolve(test.start()));
        return value;
      });
    expect(await read(test.service)).toMatchObject({
      availability: "busy",
      active_session_id: "session-1",
    });
    await started.promise;
  });

  it("rechecks a replaced Runtime instead of applying old stopping evidence", async () => {
    const test = await setup();
    const entered = Promise.withResolvers<void>();
    const evidence = Promise.withResolvers<boolean>();
    test.protection.hasUnstoppedRuntimeCalls.mockImplementationOnce(() => {
      entered.resolve();
      return evidence.promise;
    });
    const result = read(test.service);
    await entered.promise;
    const next = executionConfiguration();
    next.revision = 2;
    next.agents[0]!.runtime = runtimeConfiguration(2);
    await test.directory.apply(next);
    evidence.resolve(true);
    expect(await result).toHaveProperty("availability", "ready");
    expect(test.protection.hasUnstoppedRuntimeCalls).toHaveBeenLastCalledWith(
      expect.objectContaining({ runtimeRevision: runtimeConfiguration(2).runtime_revision }),
      expect.any(AbortSignal),
    );
  });

  it("keeps configuration identity stable across service restarts and access-only changes", async () => {
    const test = await setup();
    const before = await read(test.service);
    const restarted = await setup();
    expect((await read(restarted.service)).configuration_revision).toBe(
      before.configuration_revision,
    );
    const next = executionConfiguration();
    next.revision = 2;
    next.agents[0]!.principal_ids.push("other");
    next.agents[0]!.access_revision = "access-2";
    await test.directory.apply(next);
    expect((await read(test.service)).configuration_revision).toBe(before.configuration_revision);
  });

  it.each(["disconnect", "service stop", "source failure", "failure handler failure"])(
    "cleans up a live subscription on %s",
    async (reason) => {
      const test = await setup();
      const stopConfiguration = vi.fn();
      const stopOccupancy = vi.fn();
      const subscribeConfiguration = test.directory.subscribe.bind(test.directory);
      const subscribeOccupancy = test.supervisor.subscribe.bind(test.supervisor);
      vi.spyOn(test.directory, "subscribe").mockImplementation((id, callback) => {
        const stop = subscribeConfiguration(id, callback);
        return () => {
          stopConfiguration();
          stop();
        };
      });
      vi.spyOn(test.supervisor, "subscribe").mockImplementation((id, callback) => {
        const stop = subscribeOccupancy(id, callback);
        return () => {
          stopOccupancy();
          stop();
        };
      });
      const caller = new AbortController();
      const states: AgentExecutionStateView[] = [];
      const task = test.service
        .watch(
          executionIdentity(),
          (state) => {
            states.push(state);
            return Promise.resolve();
          },
          caller.signal,
        )
        .catch((error: unknown) => error);
      try {
        await vi.waitFor(() => expect(states).toHaveLength(1));
        if (reason === "disconnect") caller.abort();
        if (reason === "service stop") test.supervisor.stop(new Error("Stopped"));
        if (reason === "source failure" || reason === "failure handler failure") {
          test.onApplied.mockRejectedValueOnce(new Error("Publication failed"));
          if (reason === "failure handler failure")
            test.onUnavailable.mockImplementationOnce(() => {
              throw new Error("Cleanup failed");
            });
          await expect(
            test.directory.apply({ ...executionConfiguration(), revision: 2 }),
          ).rejects.toThrow(reason === "source failure" ? "Publication failed" : "Cleanup failed");
        }
        await vi.waitFor(() => expect(stopConfiguration).toHaveBeenCalled());
        const result = await task;
        expect(result === undefined).toBe(reason === "disconnect");
        expect(stopConfiguration).toHaveBeenCalled();
        expect(stopOccupancy).toHaveBeenCalled();
        expect(states).toHaveLength(1);
      } finally {
        caller.abort();
        await task;
      }
    },
  );

  it("interrupts backpressure on revocation, then sends one sanitized final view", async () => {
    const test = await setup();
    await test.start();
    const entered = Promise.withResolvers<void>();
    const states: AgentExecutionStateView[] = [];
    const caller = new AbortController();
    const task = test.service
      .watch(
        executionIdentity(),
        (state, signal) => {
          states.push(state);
          if (!state.access_allowed) return Promise.resolve();
          entered.resolve();
          return new Promise<void>((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(new Error("Delivery cancelled")), {
              once: true,
            }),
          );
        },
        caller.signal,
      )
      .catch((error: unknown) => error);
    try {
      await entered.promise;
      await test.directory.apply({ ...executionConfiguration(), revision: 2, agents: [] });
      expect(await task).toBeUndefined();
      expect(states).toHaveLength(2);
      expect(states[1]).toMatchObject({
        access_allowed: false,
        active_session_id: null,
        configuration_revision: null,
      });
    } finally {
      caller.abort();
      await task;
    }
  });

  it("watches busy/idle transitions and preserves configuration identity", async () => {
    const test = await setup();
    const lifetime = new AbortController();
    const states: AgentExecutionStateView[] = [];
    const watching = test.service.watch(
      executionIdentity(),
      (state) => {
        states.push(state);
        return Promise.resolve();
      },
      lifetime.signal,
    );
    const finished = watching.catch((error: unknown) => error);
    try {
      await vi.waitFor(() => expect(states).toHaveLength(1));
      const active = await test.start();
      await vi.waitFor(() => expect(states.at(-1)?.availability).toBe("busy"));
      test.completion.resolve(completed);
      await active.completion;
      await vi.waitFor(() => expect(states.at(-1)?.availability).toBe("ready"));
      expect(new Set(states.map((state) => state.configuration_revision)).size).toBe(1);
    } finally {
      lifetime.abort();
    }
    expect(await finished).toBeUndefined();
  });

  it("clears and terminates a revoked subscription even after immediate regrant", async () => {
    const test = await setup();
    await test.start();
    const states: AgentExecutionStateView[] = [];
    const lifetime = new AbortController();
    const task = test.service
      .watch(
        executionIdentity(),
        (state) => {
          states.push(state);
          return Promise.resolve();
        },
        lifetime.signal,
      )
      .catch((error: unknown) => error);
    try {
      await vi.waitFor(() => expect(states.at(-1)?.active_session_id).toBe("session-1"));
      await test.directory.apply({ ...executionConfiguration(), revision: 2, agents: [] });
      await test.directory.apply({ ...executionConfiguration(), revision: 3 });
      expect(await task).toBeUndefined();
      expect(states.at(-1)).toMatchObject({
        access_allowed: false,
        active_session_id: null,
        configuration_revision: null,
      });
      expect(states.filter((state) => !state.access_allowed)).toHaveLength(1);
    } finally {
      lifetime.abort();
      await task;
    }
  });
});
