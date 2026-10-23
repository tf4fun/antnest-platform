import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentApplicationRouter } from "../../src/application/agent-application-router.js";
import { AgentGenerations } from "../../src/application/agent-generations.js";
import { AgentOwnershipLostError } from "../../src/domain/agent-ownership.js";
import { DomainError } from "../../src/domain/errors.js";
import {
  RunRecoveryRequiredError,
  type AcpApplicationPort,
  type SubmittedAcpRun,
} from "../../src/ports/acp-application.js";
import type { AgentLeases } from "../../src/ports/agent-leases.js";
import { publicError } from "../../src/transport/public-error.js";
import { binding, snapshot, sessionConfigurationView } from "../support/fixtures.js";

const a = binding();
const b = { ...a, agentId: "agent-b" };
const registration = {
  registration_id: "abcdef01-2345-4abc-8abc-1234567890ab",
  member_id: "acp-a",
  incarnation_id: "abcdef02-2345-4abc-8abc-1234567890ab",
};
const outcome = {
  terminalClass: "completed",
  executorState: "quiescent",
  toolEffectState: "none",
  stopReason: "end_turn",
} as const;
function submitted(completion = Promise.resolve(outcome)): SubmittedAcpRun {
  return {
    runId: "run-a",
    requestId: "request-a",
    sessionId: "session-a",
    userMessageId: "message-a",
    outputSequence: 0,
    snapshot: snapshot(),
    completion,
  };
}
function application() {
  return {
    getSessionConfiguration: vi
      .fn<AcpApplicationPort["getSessionConfiguration"]>()
      .mockResolvedValue(sessionConfigurationView()),
    setSessionConfiguration: vi
      .fn<AcpApplicationPort["setSessionConfiguration"]>()
      .mockResolvedValue(sessionConfigurationView()),
    readSessionOutput: vi
      .fn<AcpApplicationPort["readSessionOutput"]>()
      .mockResolvedValue({ sequence: 0, events: [], state: { kind: "state", state: "idle" } }),
    assertAccess: vi.fn<AcpApplicationPort["assertAccess"]>().mockResolvedValue(),
    createSession: vi
      .fn<AcpApplicationPort["createSession"]>()
      .mockResolvedValue({ sessionId: "session-a" }),
    listSessions: vi.fn<AcpApplicationPort["listSessions"]>().mockResolvedValue({ sessions: [] }),
    deleteSession: vi.fn<AcpApplicationPort["deleteSession"]>().mockResolvedValue(),
    forkSession: vi
      .fn<AcpApplicationPort["forkSession"]>()
      .mockResolvedValue({ sessionId: "session-fork" }),
    resumeSession: vi
      .fn<AcpApplicationPort["resumeSession"]>()
      .mockResolvedValue({ replay: [], sequence: 0 }),
    closeSession: vi.fn<AcpApplicationPort["closeSession"]>().mockResolvedValue(),
    cancelRun: vi.fn<AcpApplicationPort["cancelRun"]>().mockResolvedValue(),
    acceptPrompt: vi.fn<AcpApplicationPort["acceptPrompt"]>().mockResolvedValue(submitted()),
  };
}
const cleanup: Array<() => void> = [];
const managers: AgentGenerations<AcpApplicationPort>[] = [];
function held<T>(fallback: T) {
  const value = Promise.withResolvers<T>();
  cleanup.push(() => value.resolve(fallback));
  return value;
}
async function setup() {
  const leases = {
    tryAcquire: vi.fn<AgentLeases["tryAcquire"]>((scope, ownerInstanceId) =>
      Promise.resolve({
        fence: { ...scope, ownerInstanceId, epoch: "1" },
        observedAt: new Date(),
        expiresAt: new Date(Date.now() + 30_000),
      }),
    ),
    renew: vi.fn<AgentLeases["renew"]>((fence) =>
      Promise.resolve({
        fence,
        observedAt: new Date(),
        expiresAt: new Date(Date.now() + 30_000),
      }),
    ),
    release: vi.fn<AgentLeases["release"]>().mockResolvedValue(true),
    read: vi.fn<AgentLeases["read"]>().mockResolvedValue(null),
  };
  const manager = new AgentGenerations<AcpApplicationPort>({ registration, leases });
  managers.push(manager);
  const graphA = application();
  const graphB = application();
  const generation = await manager.prepare(a, () => Promise.resolve(graphA));
  await manager.prepare(b, () => Promise.resolve(graphB));
  const access = { assert: vi.fn().mockResolvedValue(undefined) };
  const router = new AgentApplicationRouter({ access, generations: manager });
  return { manager, leases, graphA, graphB, generation, access, router };
}
afterEach(async () => {
  for (const finish of cleanup.splice(0)) finish();
  await Promise.all(managers.splice(0).map((manager) => manager.drain()));
});
const create = () => ({
  binding: { ...a },
  cwd: "/workspace",
  additionalDirectories: [],
  mcpServers: [],
});
const prompt = () => ({
  binding: { ...a },
  sessionId: "session-a",
  prompt: [{ type: "text", text: "hello" }],
  outputChanged: vi.fn(),
});
const cases: { [K in keyof AcpApplicationPort]: Parameters<AcpApplicationPort[K]>[0] } = {
  getSessionConfiguration: { binding: a, sessionId: "session-a" },
  setSessionConfiguration: {
    binding: a,
    sessionId: "session-a",
    configId: "model",
    value: "profile-1",
  },
  readSessionOutput: { binding: a, sessionId: "session-a", afterSequence: 12 },
  assertAccess: { binding: a },
  createSession: create(),
  listSessions: { binding: a, cursor: "cursor-a" },
  deleteSession: { binding: a, sessionId: "session-a" },
  forkSession: { ...create(), sessionId: "session-a" },
  resumeSession: { ...create(), sessionId: "session-a", replayFromStart: true },
  closeSession: { binding: a, sessionId: "session-a" },
  cancelRun: { binding: a, sessionId: "session-a", expectedRunId: "run-a" },
  acceptPrompt: prompt(),
};

describe("Agent application routing", () => {
  it.each(Object.keys(cases) as Array<keyof AcpApplicationPort>)(
    "%s authorizes before routing once to the fixed Agent graph",
    async (method) => {
      const { router, graphA, graphB, access, manager } = await setup();
      const authorized = held<void>(undefined);
      access.assert.mockReturnValueOnce(authorized.promise);
      const capture = vi.spyOn(manager, "capture");
      // The mapped table validates each input against its own public method.
      const pending = router[method](cases[method] as never);
      expect(capture).not.toHaveBeenCalled();
      expect(graphA[method]).not.toHaveBeenCalled();
      authorized.resolve();
      await pending;
      expect(access.assert).toHaveBeenCalledExactlyOnceWith(a);
      expect(capture).toHaveBeenCalledExactlyOnceWith(a);
      expect(graphA[method]).toHaveBeenCalledExactlyOnceWith(cases[method]);
      expect(graphB[method]).not.toHaveBeenCalled();
    },
  );

  it("denied access never inspects or acquires an Agent generation", async () => {
    const { router, graphA, manager, access, leases } = await setup();
    const denied = new DomainError("access_denied", "Denied");
    const capture = vi.spyOn(manager, "capture");
    const acquisitions = vi.mocked(leases.tryAcquire).mock.calls.length;
    access.assert.mockRejectedValueOnce(denied);
    await expect(router.createSession(create())).rejects.toBe(denied);
    expect(capture).not.toHaveBeenCalled();
    expect(graphA.createSession).not.toHaveBeenCalled();
    expect(leases.tryAcquire).toHaveBeenCalledTimes(acquisitions);
  });

  it("captures mutable request data before waiting for authorization", async () => {
    const { router, graphA, graphB, access } = await setup();
    const authorized = held<void>(undefined);
    access.assert.mockReturnValueOnce(authorized.promise);
    const input = prompt();
    const outputChanged = input.outputChanged;
    const pending = router.acceptPrompt(input);
    input.binding.agentId = b.agentId;
    input.prompt[0]!.text = "mutated";
    authorized.resolve();
    await pending;
    expect(graphA.acceptPrompt).toHaveBeenCalledExactlyOnceWith({ ...prompt(), outputChanged });
    expect(graphB.acceptPrompt).not.toHaveBeenCalled();
  });

  it("an unavailable Agent is retryable only before dispatch and does not prevent B", async () => {
    const { router, graphA, manager } = await setup();
    await manager.closeScope(a);
    const error = await router.createSession(create()).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "agent_unavailable" });
    expect(publicError(error, "admission").data.retryable).toBe(true);
    expect(graphA.createSession).not.toHaveBeenCalled();
    await expect(router.createSession({ ...create(), binding: b })).resolves.toEqual({
      sessionId: "session-a",
    });
  });

  it("loss after graph invocation is non-retryable and closes only that Agent", async () => {
    const { router, graphA, manager } = await setup();
    const failure = new AgentOwnershipLostError();
    graphA.createSession.mockRejectedValueOnce(failure);
    const error = await router.createSession(create()).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(RunRecoveryRequiredError);
    expect(error).toMatchObject({ cause: failure });
    expect(publicError(error, "admission").data).toMatchObject({
      code: "database_error",
      retryable: false,
    });
    expect(() => manager.capture(a)).toThrow(AgentOwnershipLostError);
    await expect(router.createSession({ ...create(), binding: b })).resolves.toEqual({
      sessionId: "session-a",
    });
  });

  it("loss between capture and invocation is retryable with no graph call", async () => {
    const { router, graphA, manager } = await setup();
    const capture = manager.capture.bind(manager);
    vi.spyOn(manager, "capture").mockImplementationOnce((scope) => {
      const generation = capture(scope);
      queueMicrotask(() => {
        void manager.closeScope(scope);
      });
      return generation;
    });
    await expect(router.createSession(create())).rejects.toMatchObject({
      code: "agent_unavailable",
    });
    expect(graphA.createSession).not.toHaveBeenCalled();
  });

  it("keeps an accepted Run's original completion until cleanup joins", async () => {
    const { router, graphA, manager, leases, generation } = await setup();
    const completion = held(outcome);
    const accepted = submitted(completion.promise);
    const handoff = vi.spyOn(generation, "retainRun");
    graphA.acceptPrompt.mockResolvedValueOnce(accepted);
    expect(await router.acceptPrompt(prompt())).toBe(accepted);
    expect(handoff).toHaveBeenCalledExactlyOnceWith(completion.promise);
    let stopped = false;
    const stopping = manager.closeScope(a).then(() => {
      stopped = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(leases.release).not.toHaveBeenCalled();
    completion.resolve(outcome);
    await stopping;
    expect(leases.release).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ agentId: a.agentId }),
    );
  });

  it("late accepted receipt hands off its original Run even after loss", async () => {
    const { router, graphA, manager, leases } = await setup();
    const completion = held(outcome);
    const accepted = submitted(completion.promise);
    const receipt = held(accepted);
    const invoked = held<void>(undefined);
    graphA.acceptPrompt.mockImplementationOnce(() => {
      invoked.resolve();
      return receipt.promise;
    });
    const pending = router.acceptPrompt(prompt());
    const rejected = expect(pending).rejects.toBeInstanceOf(RunRecoveryRequiredError);
    await invoked.promise;
    const stopping = manager.closeScope(a);
    receipt.resolve(accepted);
    await rejected;
    expect(leases.release).not.toHaveBeenCalled();
    completion.resolve(outcome);
    await stopping;
    expect(leases.release).toHaveBeenCalledOnce();
  });
});
