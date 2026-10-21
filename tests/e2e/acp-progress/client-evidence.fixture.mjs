import { terminalStatus } from "./evidence.mjs";
import { admissionErrorReceipt } from "../../support/acp-errors.mjs";

// Controlled complete client inventory. Real SDK serialization/close provenance
// and raw Trace admission remain the separate connection/collector gates.
export function progressClientFixture() {
  const barrier = admissionErrorReceipt("runtime_barrier_required");
  const agents = [],
    connections = [],
    scenarios = [],
    outcomes = [],
    models = [];
  let connectionIndex = 0;
  for (const version of [1, 2])
    for (const source of ["bash", "managed"]) {
      const agentId = `agent-v${version}-${source}`;
      agents.push(agentId);
      for (const ending of ["success", "failure", "cancel"]) {
        const phase = `v${version}-${source}-${ending}`;
        const sessionId = `session-${phase}`,
          toolCallId = `tool-${phase}`;
        scenarios.push({ phase, sessionId, toolCallId });
        outcomes.push({
          phase,
          early_progress: true,
          replay: true,
          terminal: terminalStatus(version, source, ending),
          ...(ending === "cancel" ? { actual_execution_stopped: true } : {}),
        });
        const traceID = (scenarios.length + 100).toString(16).padStart(32, "0");
        for (const stage of ending === "cancel" ? ["tool"] : ["tool", "final"])
          models.push({ phase, stage, trace_id: traceID });
        for (const role of ending === "success"
          ? ["prompt", "live-replay", "terminal-replay"]
          : ["prompt", "terminal-replay"]) {
          const connectionTraceID = (++connectionIndex)
            .toString(16)
            .padStart(32, "0");
          const clientSpanID = connectionIndex.toString(16).padStart(16, "0");
          const connection = {
            phase,
            version,
            source,
            ending,
            agentId,
            sessionId,
            role,
            connectionTraceID,
            clientSpanID,
            requests: [],
            evidence: [],
            notifications: [],
            raw_frames: [],
          };
          const methods =
            role === "prompt"
              ? ["session/new", "session/prompt"]
              : [
                  version === 1 ? "session/load" : "session/resume",
                  ...(ending === "cancel" ? ["session/prompt"] : []),
                ];
          for (const method of ["initialize", ...methods]) {
            const requestId = String(connection.requests.length + 1);
            const inputSessionID = ["initialize", "session/new"].includes(
              method,
            )
              ? null
              : sessionId;
            connection.requests.push({
              requestId,
              method,
              ...(inputSessionID ? { sessionId } : {}),
            });
            const row = {
              boundary: "private-acp",
              transport: "websocket",
              protocolVersion: version,
              agentId,
              method,
              requestId,
              connectionTraceID,
              clientSpanID,
              inputSessionID,
              outcome: "succeeded",
              ...(method !== "initialize" ? { sessionId } : {}),
            };
            if (method === "session/prompt" && role === "terminal-replay")
              Object.assign(row, {
                outcome: "rejected",
                rejection: "runtime_barrier_required",
                rejectionReceipt: {
                  rpcCode: barrier.code,
                  ...barrier.data,
                },
              });
            if (
              method === "session/prompt" &&
              role === "prompt" &&
              version === 1 &&
              ending === "success"
            )
              Object.assign(row, {
                outcome: "failed",
                closedBeforeResponse: true,
              });
            if (method === "initialize") connection.initialization = row;
            else connection.evidence.push(row);
          }
          if (ending === "cancel" && role === "prompt")
            connection.notifications.push(
              Object.freeze({
                version,
                agentId,
                sessionId,
                method: "session/cancel",
                connectionTraceID,
                clientSpanID,
                index: 0,
                status: "write_completed",
                origin: "notify",
                wireObserved: true,
                writeOutcome: "completed",
              }),
            );
          connections.push(connection);
        }
      }
    }
  return { agents, connections, scenarios, outcomes, models };
}
