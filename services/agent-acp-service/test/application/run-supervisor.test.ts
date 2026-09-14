import { describe, expect, it, vi } from "vitest";
import { RunSupervisor } from "../../src/application/run-supervisor.js";
import { DomainError } from "../../src/domain/errors.js";
import type { AcceptedAcpRun, ExecuteRunResult } from "../../src/ports/acp-application.js";
import type { RunExecutionPort } from "../../src/application/run-executor.js";
import { binding, snapshot } from "../support/fixtures.js";

const completed: ExecuteRunResult = {
  terminalClass: "completed",
  executorState: "quiescent",
  toolEffectState: "none",
  stopReason: "end_turn",
};
const cancelled: ExecuteRunResult = {
  terminalClass: "cancelled",
  executorState: "quiescent",
  toolEffectState: "none",
};

function input(sessionId = "session-1", agentId = "agent-1", organizationId = "organization-1") {
  return { binding: { ...binding(), agentId, organizationId }, sessionId, outputChanged: vi.fn() };
}

function acceptedRun(sessionId = "session-1"): AcceptedAcpRun {
  return {
    outputSequence: 0,
    runId: `run-${sessionId}`,
    requestId: `request-${sessionId}`,
    sessionId,
    userMessageId: `message-${sessionId}`,
    snapshot: snapshot(),
  };
}

describe("RunSupervisor ownership", () => {
  it("quiesces an idle Agent without inventing an execution slot", async () => {
    const execute = vi.fn<RunExecutionPort["execute"]>();
    const supervisor = new RunSupervisor({ execute });
    await expect(
      supervisor.quiesceAgent(input().binding, "wait", new AbortController().signal),
    ).resolves.toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it("waits for pending acceptance and its executor without sending cancellation", async () => {
    const acceptance = Promise.withResolvers<AcceptedAcpRun>();
    const completion = Promise.withResolvers<ExecuteRunResult>();
    const execute = vi.fn<RunExecutionPort["execute"]>().mockReturnValue(completion.promise);
    const supervisor = new RunSupervisor({ execute });
    const submission = supervisor.submit(input(), () => acceptance.promise);
    const finished = vi.fn();
    const settling = supervisor
      .quiesceAgent(input().binding, "wait", new AbortController().signal)
      .then((result) => {
        finished(result);
        return result;
      });
    await Promise.resolve();
    expect(finished).not.toHaveBeenCalled();
    acceptance.resolve(acceptedRun());
    const submitted = await submission;
    expect(execute.mock.calls[0]?.[0].signal.aborted).toBe(false);
    expect(finished).not.toHaveBeenCalled();
    completion.resolve(completed);
    await expect(settling).resolves.toBe(true);
    await submitted.completion;
  });

  it("bounds a cancellation wait without releasing an executor that ignored cancellation", async () => {
    const completion = Promise.withResolvers<ExecuteRunResult>();
    const execute = vi.fn<RunExecutionPort["execute"]>().mockReturnValue(completion.promise);
    const supervisor = new RunSupervisor({ execute });
    const submitted = await supervisor.submit(input(), () => Promise.resolve(acceptedRun()));
    const deadline = new AbortController();
    const settling = supervisor.quiesceAgent(input().binding, "cancel", deadline.signal);
    expect(execute.mock.calls[0]?.[0].signal.aborted).toBe(true);
    deadline.abort(new Error("Lifecycle wait expired"));
    await expect(settling).resolves.toBe(false);
    await expect(
      supervisor.submit(input("session-2"), () => Promise.resolve(acceptedRun("session-2"))),
    ).rejects.toMatchObject({ code: "agent_busy" });
    completion.resolve(cancelled);
    await submitted.completion;
    await expect(
      supervisor.quiesceAgent(input().binding, "wait", new AbortController().signal),
    ).resolves.toBe(true);
  });

  it("does not cancel or free pending acceptance when a wait-only deadline expires", async () => {
    const acceptance = Promise.withResolvers<AcceptedAcpRun>();
    const execute = vi.fn<RunExecutionPort["execute"]>().mockResolvedValue(completed);
    const supervisor = new RunSupervisor({ execute });
    const submission = supervisor.submit(input(), () => acceptance.promise);
    const deadline = new AbortController();
    const settling = supervisor.quiesceAgent(input().binding, "wait", deadline.signal);
    deadline.abort();
    await expect(settling).resolves.toBe(false);
    await expect(
      supervisor.submit(input("session-2"), () => Promise.resolve(acceptedRun("session-2"))),
    ).rejects.toMatchObject({ code: "agent_busy" });
    acceptance.resolve(acceptedRun());
    const submitted = await submission;
    await submitted.completion;
    expect(execute.mock.calls[0]?.[0].signal.aborted).toBe(false);
  });

  it("does not send a late cancellation when the waiting deadline is already expired", async () => {
    const completion = Promise.withResolvers<ExecuteRunResult>();
    const execute = vi.fn<RunExecutionPort["execute"]>().mockReturnValue(completion.promise);
    const supervisor = new RunSupervisor({ execute });
    const submitted = await supervisor.submit(input(), () => Promise.resolve(acceptedRun()));
    await expect(
      supervisor.quiesceAgent(input().binding, "cancel", AbortSignal.abort()),
    ).resolves.toBe(false);
    expect(execute.mock.calls[0]?.[0].signal.aborted).toBe(false);
    completion.resolve(completed);
    await submitted.completion;
  });

  it("scopes lifecycle cancellation to one organization's Agent across all Sessions", async () => {
    const completion = Promise.withResolvers<ExecuteRunResult>();
    const execute = vi.fn<RunExecutionPort["execute"]>().mockReturnValue(completion.promise);
    const supervisor = new RunSupervisor({ execute });
    const target = input("session-1");
    const otherAgent = input("session-2", "agent-2");
    const otherOrganization = input("session-3", "agent-1", "organization-2");
    const submitted = [];
    for (const request of [target, otherAgent, otherOrganization]) {
      submitted.push(
        await supervisor.submit(request, () => Promise.resolve(acceptedRun(request.sessionId))),
      );
    }
    const settling = supervisor.quiesceAgent(
      target.binding,
      "cancel",
      new AbortController().signal,
    );
    expect(execute.mock.calls.map(([call]) => call.signal.aborted)).toEqual([true, false, false]);
    completion.resolve(cancelled);
    await expect(settling).resolves.toBe(true);
    await Promise.all(submitted.map((run) => run.completion));
  });

  it("cancels the same pending lifetime when acceptance commits during lifecycle settlement", async () => {
    const acceptance = Promise.withResolvers<AcceptedAcpRun>();
    const execute = vi.fn<RunExecutionPort["execute"]>(({ signal }) => {
      expect(signal.aborted).toBe(true);
      return Promise.resolve(cancelled);
    });
    const supervisor = new RunSupervisor({ execute });
    const submission = supervisor.submit(input(), () => acceptance.promise);
    const settling = supervisor.quiesceAgent(
      input().binding,
      "cancel",
      new AbortController().signal,
    );
    acceptance.resolve(acceptedRun());
    const submitted = await submission;
    await expect(settling).resolves.toBe(true);
    await expect(submitted.completion).resolves.toEqual(cancelled);
  });

  it("starts accepted work without a transport execute callback and notifies after durable completion", async () => {
    const execute = vi.fn<RunExecutionPort["execute"]>().mockResolvedValue(completed);
    const supervisor = new RunSupervisor({ execute });
    const request = input();
    const submitted = await supervisor.submit(request, () => Promise.resolve(acceptedRun()));
    await expect(submitted.completion).resolves.toEqual(completed);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0].accepted.runId).toBe("run-session-1");
    expect(request.outputChanged).toHaveBeenCalled();
    expect("execute" in supervisor).toBe(false);
  });

  it("owns the Agent across Sessions while acceptance is still pending", async () => {
    const gate = Promise.withResolvers<AcceptedAcpRun>();
    const execute = vi.fn<RunExecutionPort["execute"]>().mockResolvedValue(completed);
    const supervisor = new RunSupervisor({ execute });
    const first = supervisor.submit(input(), () => gate.promise);
    const second = vi.fn(() => Promise.resolve(acceptedRun("session-2")));
    await expect(supervisor.submit(input("session-2"), second)).rejects.toMatchObject({
      code: "agent_busy",
    });
    expect(second).not.toHaveBeenCalled();
    gate.resolve(acceptedRun());
    await (
      await first
    ).completion;
  });

  it("retains exclusivity until execution and local terminal persistence finish", async () => {
    const gate = Promise.withResolvers<ExecuteRunResult>();
    const execute = vi.fn<RunExecutionPort["execute"]>().mockReturnValue(gate.promise);
    const supervisor = new RunSupervisor({ execute });
    const first = await supervisor.submit(input(), () => Promise.resolve(acceptedRun()));
    await expect(
      supervisor.submit(input("session-2"), () => Promise.resolve(acceptedRun("session-2"))),
    ).rejects.toMatchObject({ code: "agent_busy" });
    gate.resolve(completed);
    await first.completion;
    await (
      await supervisor.submit(input("session-2"), () => Promise.resolve(acceptedRun("session-2")))
    ).completion;
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("does not share an Agent slot across organizations or different Agents", async () => {
    const gate = Promise.withResolvers<ExecuteRunResult>();
    const execute = vi.fn<RunExecutionPort["execute"]>().mockReturnValue(gate.promise);
    const supervisor = new RunSupervisor({ execute });
    const submitted = await Promise.all([
      supervisor.submit(input(), () => Promise.resolve(acceptedRun())),
      supervisor.submit(input("session-2", "agent-2"), () =>
        Promise.resolve(acceptedRun("session-2")),
      ),
      supervisor.submit(input("session-3", "agent-1", "organization-2"), () =>
        Promise.resolve(acceptedRun("session-3")),
      ),
    ]);
    expect(execute).toHaveBeenCalledTimes(3);
    gate.resolve(completed);
    await Promise.all(submitted.map((run) => run.completion));
  });

  it("releases a rejected acceptance without executing or retaining a phantom slot", async () => {
    const execute = vi.fn<RunExecutionPort["execute"]>().mockResolvedValue(completed);
    const supervisor = new RunSupervisor({ execute });
    await expect(
      supervisor.submit(input(), () =>
        Promise.reject(new DomainError("agent_unavailable", "Disabled")),
      ),
    ).rejects.toMatchObject({ code: "agent_unavailable" });
    expect(execute).not.toHaveBeenCalled();
    await (
      await supervisor.submit(input(), () => Promise.resolve(acceptedRun()))
    ).completion;
    expect(execute).toHaveBeenCalledOnce();
  });

  it("cancels pending acceptance and waits for the acceptance operation to settle", async () => {
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const execute = vi.fn<RunExecutionPort["execute"]>();
    const supervisor = new RunSupervisor({ execute });
    let signal: AbortSignal | undefined;
    const submission = supervisor.submit(input(), async (current) => {
      signal = current;
      entered.resolve();
      await gate.promise;
      current.throwIfAborted();
      return acceptedRun();
    });
    const failed = expect(submission).rejects.toThrow();
    await entered.promise;
    const cancellation = supervisor.cancel("session-1");
    expect(signal?.aborted).toBe(true);
    await expect(
      supervisor.submit(input("session-2"), () => Promise.resolve(acceptedRun("session-2"))),
    ).rejects.toMatchObject({ code: "agent_busy" });
    gate.resolve();
    await cancellation;
    await failed;
    expect(execute).not.toHaveBeenCalled();
  });

  it("finishes a committed acceptance locally when cancellation races the commit", async () => {
    const gate = Promise.withResolvers<AcceptedAcpRun>();
    const execute = vi.fn<RunExecutionPort["execute"]>(({ signal }) => {
      expect(signal.aborted).toBe(true);
      return Promise.resolve(cancelled);
    });
    const supervisor = new RunSupervisor({ execute });
    const submission = supervisor.submit(input(), () => gate.promise);
    const cancellation = supervisor.cancel("session-1");
    gate.resolve(acceptedRun());
    const submitted = await submission;
    await cancellation;
    await expect(submitted.completion).resolves.toEqual(cancelled);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("does not report cancellation complete while an executor ignores its signal", async () => {
    const gate = Promise.withResolvers<ExecuteRunResult>();
    const execute = vi.fn<RunExecutionPort["execute"]>().mockReturnValue(gate.promise);
    const supervisor = new RunSupervisor({ execute });
    const submitted = await supervisor.submit(input(), () => Promise.resolve(acceptedRun()));
    let stopped = false;
    const cancellation = supervisor.cancel("session-1").then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(execute.mock.calls[0]?.[0].signal.aborted).toBe(true);
    expect(stopped).toBe(false);
    await expect(
      supervisor.submit(input("session-2"), () => Promise.resolve(acceptedRun("session-2"))),
    ).rejects.toMatchObject({ code: "agent_busy" });
    gate.resolve(cancelled);
    await cancellation;
    await submitted.completion;
    expect(stopped).toBe(true);
  });

  it("stops admissions during shutdown and waits for accepted work to finish", async () => {
    const gate = Promise.withResolvers<ExecuteRunResult>();
    const execute = vi.fn<RunExecutionPort["execute"]>().mockReturnValue(gate.promise);
    const supervisor = new RunSupervisor({ execute });
    const submitted = await supervisor.submit(input(), () => Promise.resolve(acceptedRun()));
    const shutdown = supervisor.shutdown();
    expect(execute.mock.calls[0]?.[0].signal.aborted).toBe(true);
    await expect(
      supervisor.submit(input("session-2", "agent-2"), () =>
        Promise.resolve(acceptedRun("session-2")),
      ),
    ).rejects.toMatchObject({ code: "service_stopping" });
    gate.resolve(cancelled);
    await shutdown;
    await submitted.completion;
  });

  it("observes executor failure even when the submitting connection does not observe completion", async () => {
    const execute = vi
      .fn<RunExecutionPort["execute"]>()
      .mockRejectedValue(new Error("terminal write failed"));
    const supervisor = new RunSupervisor({ execute });
    const request = input();
    const submitted = await supervisor.submit(request, () => Promise.resolve(acceptedRun()));
    await supervisor.shutdown();
    await expect(submitted.completion).rejects.toThrow("terminal write failed");
    expect(request.outputChanged).toHaveBeenCalled();
  });

  it("does not let a failed output hint replace the persisted execution result", async () => {
    const execute = vi.fn<RunExecutionPort["execute"]>(async ({ publish }) => {
      await publish({ kind: "state", state: "running" });
      return completed;
    });
    const supervisor = new RunSupervisor({ execute });
    const submitted = await supervisor.submit(
      {
        ...input(),
        outputChanged: () => {
          throw new Error("connection gone");
        },
      },
      () => Promise.resolve(acceptedRun()),
    );
    await expect(submitted.completion).resolves.toEqual(completed);
  });
});
