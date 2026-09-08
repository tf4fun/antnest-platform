import { vi } from "vitest";
import type {
  AcpApplicationPort,
  SessionEvent,
  SessionOutputSnapshot,
  ExecuteRunResult,
} from "../../src/ports/acp-application.js";

// Protocol mapping tests use a deterministic output store. PostgreSQL wire
// tests exercise the actual atomic transcript snapshot separately.
export function withOutputHistory(
  application: Omit<AcpApplicationPort, "readSessionOutput">,
): AcpApplicationPort {
  const history = new Map<string, SessionEvent[]>();
  const states = new Map<string, SessionOutputSnapshot["state"]>();
  return {
    ...application,
    readSessionOutput: vi.fn<AcpApplicationPort["readSessionOutput"]>(
      ({ sessionId, afterSequence }) => {
        const events = history.get(sessionId) ?? [];
        return Promise.resolve({
          sequence: events.length,
          events: afterSequence === undefined ? [] : events.slice(afterSequence),
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
    executeRun: vi.fn<AcpApplicationPort["executeRun"]>(async (input) => {
      const sessionId = input.accepted.sessionId;
      const events = history.get(sessionId) ?? [];
      history.set(sessionId, events);
      const result = await application.executeRun({
        ...input,
        publish: async (event) => {
          if (event.kind === "state") states.set(sessionId, event);
          else events.push(structuredClone(event));
          await input.publish(event);
        },
      });
      states.set(sessionId, terminalState(result));
      return result;
    }),
  };
}

function terminalState(result: ExecuteRunResult): SessionOutputSnapshot["state"] {
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
