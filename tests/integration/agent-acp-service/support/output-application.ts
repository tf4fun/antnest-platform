import { vi } from "vitest";
import { RunSupervisor } from "../../../../services/agent-acp-service/src/application/run-supervisor.js";
import type {
  AcpApplicationPort,
  SessionEvent,
  SessionOutputSnapshot,
  ExecuteRunResult,
  AcceptedAcpRun,
  RunExecutionInput,
} from "../../../../services/agent-acp-service/src/ports/acp-application.js";

export type OutputApplication = Omit<
  AcpApplicationPort,
  "readSessionOutput" | "acceptPrompt"
> & {
  acceptPrompt(
    input: Parameters<AcpApplicationPort["acceptPrompt"]>[0],
  ): Promise<AcceptedAcpRun>;
  execute(input: RunExecutionInput): Promise<ExecuteRunResult>;
};

// Protocol mapping tests use a deterministic output store. PostgreSQL wire
// tests exercise the actual atomic transcript snapshot separately.
export function withOutputHistory(
  application: OutputApplication,
  infoAfterAccept?: SessionOutputSnapshot["info"],
): AcpApplicationPort {
  const history = new Map<string, SessionEvent[]>();
  const infos = new Map<string, SessionOutputSnapshot["info"]>();
  const states = new Map<string, SessionOutputSnapshot["state"]>();
  const supervisor = new RunSupervisor({
    execute: async (input) => {
      const sessionId = input.accepted.sessionId;
      const events = history.get(sessionId) ?? [];
      history.set(sessionId, events);
      const result = await application.execute({
        ...input,
        publish: async (event) => {
          if (event.kind === "state") states.set(sessionId, event);
          else events.push(structuredClone(event));
          await input.publish(event);
        },
      });
      states.set(sessionId, terminalState(result));
      return result;
    },
  });
  return {
    ...application,
    readSessionOutput: vi.fn<AcpApplicationPort["readSessionOutput"]>(
      ({ sessionId, afterSequence }) => {
        const events = history.get(sessionId) ?? [];
        const info = infos.get(sessionId);
        return Promise.resolve({
          ...(info === undefined ? {} : { info }),
          sequence: events.length,
          events:
            afterSequence === undefined ? [] : events.slice(afterSequence),
          state: states.get(sessionId) ?? { kind: "state", state: "running" },
        });
      },
    ),
    resumeSession: vi.fn<AcpApplicationPort["resumeSession"]>(async (input) => {
      const snapshot = await application.resumeSession(input);
      const state = snapshot.replay.find((event) => event.kind === "state");
      if (state !== undefined) states.set(input.sessionId, state);
      return snapshot;
    }),
    acceptPrompt: vi.fn<AcpApplicationPort["acceptPrompt"]>((input) =>
      supervisor.submit(input, async () => {
        const accepted = await application.acceptPrompt(input);
        if (infoAfterAccept !== undefined)
          infos.set(accepted.sessionId, infoAfterAccept);
        states.set(accepted.sessionId, { kind: "state", state: "running" });
        return {
          ...accepted,
          outputSequence: history.get(accepted.sessionId)?.length ?? 0,
        };
      }),
    ),
  };
}

function terminalState(
  result: ExecuteRunResult,
): SessionOutputSnapshot["state"] {
  switch (result.terminalClass) {
    case "completed":
      return { kind: "state", state: "idle", stopReason: result.stopReason };
    case "cancelled":
      return { kind: "state", state: "idle", stopReason: "cancelled" };
    case "failed":
      return { kind: "state", state: "idle", stopReason: "_failed" };
    case "unresolved":
      return { kind: "state", state: "idle", stopReason: "_unresolved" };
  }
}
