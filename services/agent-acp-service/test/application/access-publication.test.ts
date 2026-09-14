import { getEventListeners } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { RunSupervisor } from "../../src/application/run-supervisor.js";
import type { RunExecutionPort } from "../../src/application/run-executor.js";
import { PermissionConnections } from "../../src/application/permission-connections.js";
import { SessionOutputStreams } from "../../src/transport/acp/session-output.js";
import type {
  AcceptedAcpRun,
  ExecuteRunResult,
  SessionEvent,
  SessionOutputSnapshot,
} from "../../src/ports/acp-application.js";
import { binding, snapshot } from "../support/fixtures.js";
import { executionConfiguration } from "../fixtures/execution-configuration.js";

const completed: ExecuteRunResult = {
  terminalClass: "completed",
  executorState: "quiescent",
  toolEffectState: "none",
  stopReason: "end_turn",
};
const revoked = { organization_id: "organization-1", agents: [] };
const idle = { kind: "state", state: "idle" } as const;
const message = (text: string): SessionEvent => ({
  kind: "agent_message",
  messageId: text,
  content: [{ type: "text", text }],
});
function accepted(): AcceptedAcpRun {
  return {
    runId: "run-1",
    requestId: "request-1",
    sessionId: "session-1",
    userMessageId: "message-1",
    outputSequence: 0,
    snapshot: snapshot(),
  };
}
function submission() {
  return { binding: binding(), sessionId: "session-1", outputChanged: vi.fn() };
}

describe("configuration publication access effects", () => {
  it("aborts revoked executions without waiting for remote completion or releasing exclusivity", async () => {
    const done = Promise.withResolvers<ExecuteRunResult>();
    const execute = vi.fn<RunExecutionPort["execute"]>(() => done.promise);
    const supervisor = new RunSupervisor({ execute });
    const run = await supervisor.submit(submission(), () => Promise.resolve(accepted()));
    try {
      supervisor.revokeAccess(revoked);
      expect(execute.mock.calls[0]?.[0].signal.aborted).toBe(true);
      supervisor.revokeAccess(executionConfiguration());
      expect(execute.mock.calls[0]?.[0].signal.aborted).toBe(true);
      await expect(
        supervisor.submit(submission(), () => Promise.resolve(accepted())),
      ).rejects.toMatchObject({ code: "agent_busy" });
    } finally {
      done.resolve(completed);
      await run.completion;
    }
  });

  it("revokes a pending acceptance even if its database commit subsequently succeeds", async () => {
    const gate = Promise.withResolvers<AcceptedAcpRun>();
    const execute = vi.fn<RunExecutionPort["execute"]>(() => Promise.resolve(completed));
    const supervisor = new RunSupervisor({ execute });
    const pending = supervisor.submit(submission(), () => gate.promise);
    try {
      supervisor.revokeAccess(revoked);
    } finally {
      gate.resolve(accepted());
      await (
        await pending
      ).completion;
    }
    expect(execute.mock.calls[0]?.[0].signal.aborted).toBe(true);
  });

  it("does not cancel an existing Run when only new admission closes or another organization revokes access", async () => {
    const done = Promise.withResolvers<ExecuteRunResult>();
    const execute = vi.fn<RunExecutionPort["execute"]>(() => done.promise);
    const supervisor = new RunSupervisor({ execute });
    const run = await supervisor.submit(submission(), () => Promise.resolve(accepted()));
    try {
      const changed = executionConfiguration();
      changed.agents[0]!.accepting_runs = false;
      supervisor.revokeAccess(changed);
      supervisor.revokeAccess({ ...revoked, organization_id: "organization-2" });
      expect(execute.mock.calls[0]?.[0].signal.aborted).toBe(false);
    } finally {
      done.resolve(completed);
      await run.completion;
    }
  });

  it("closes blocked output reads without publishing their late private payload", async () => {
    const streams = new SessionOutputStreams();
    const blocked = Promise.withResolvers<SessionOutputSnapshot>();
    const send = vi.fn(() => Promise.resolve());
    const onFailure = vi.fn();
    const attachment = streams.attach({
      identity: binding(),
      key: "session",
      connectionId: "connection",
      read: () => blocked.promise,
      send,
      signal: new AbortController().signal,
      initialState: idle,
      onFailure,
    });
    try {
      streams.revokeAccess(revoked);
      await attachment;
      blocked.resolve({ sequence: 1, events: [message("private")], state: idle });
      await streams.flush("session");
      expect(send).not.toHaveBeenCalled();
      expect(onFailure).not.toHaveBeenCalled();
    } finally {
      streams.disconnect("connection");
      blocked.resolve({ sequence: 0, events: [], state: idle });
      await attachment;
    }
  });

  it("discards remaining buffered output when a slow sender outlives access", async () => {
    const streams = new SessionOutputStreams();
    const entered = Promise.withResolvers<void>();
    const blocked = Promise.withResolvers<void>();
    const send = vi.fn(() => {
      entered.resolve();
      return blocked.promise;
    });
    const attachment = streams.attach({
      identity: binding(),
      key: "session",
      connectionId: "connection",
      read: () =>
        Promise.resolve({
          sequence: 2,
          events: [message("first"), message("private")],
          state: idle,
        }),
      send,
      signal: new AbortController().signal,
      initialState: idle,
      onFailure: vi.fn(),
    });
    try {
      await entered.promise;
      streams.revokeAccess(revoked);
      await attachment;
      blocked.resolve();
      await streams.flush("session");
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      streams.disconnect("connection");
      blocked.resolve();
      await attachment;
    }
  });

  it("detaches only revoked permission connections", () => {
    const connections = new PermissionConnections();
    const revokedLifetime = new AbortController();
    const otherLifetime = new AbortController();
    connections.attach({
      binding: binding(),
      sessionId: "session-1",
      signal: revokedLifetime.signal,
      request: vi.fn(),
    });
    connections.attach({
      binding: { ...binding(), organizationId: "organization-2" },
      sessionId: "session-2",
      signal: otherLifetime.signal,
      request: vi.fn(),
    });
    try {
      connections.revokeAccess(revoked);
      expect(getEventListeners(revokedLifetime.signal, "abort")).toHaveLength(0);
      expect(getEventListeners(otherLifetime.signal, "abort")).toHaveLength(1);
    } finally {
      revokedLifetime.abort();
      otherLifetime.abort();
    }
  });
});
