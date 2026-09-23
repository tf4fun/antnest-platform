import { setTimeout as delay } from "node:timers/promises";
import { annotateFailure } from "./failure.mjs";

const timeout = 120000;

async function deleteAgent(agent, api, options) {
  const { now = Date.now, wait = delay } = options;
  let cleanupPhase = "delete-request";
  let last = {};
  try {
    const submitted = await api(
      `/api/admin/agents/${encodeURIComponent(agent)}/delete`,
      {},
      202,
    );
    if (typeof submitted?.request_id !== "string" || !submitted.request_id)
      throw annotateFailure(new Error("Agent deletion response invalid"), {
        reason: "delete-response-invalid",
      });
    cleanupPhase = "operation-poll";
    const deadline = now() + timeout;
    while (now() < deadline) {
      const result = await api(
        `/api/admin/operations/${encodeURIComponent(submitted.request_id)}`,
      );
      last = {
        operation_kind: result?.kind,
        operation_phase: result?.phase,
        operation_state: result?.state,
      };
      if (result?.state === "completed") return;
      if (result?.state !== "running")
        throw annotateFailure(new Error("Agent deletion operation failed"), {
          reason:
            result?.state === "failed"
              ? "operation-failed"
              : "operation-response-invalid",
        });
      await wait(100);
    }
    throw annotateFailure(new Error("Agent deletion operation timed out"), {
      reason: "operation-timeout",
      timeout_ms: timeout,
    });
  } catch (error) {
    throw annotateFailure(error, { cleanup_phase: cleanupPhase, ...last });
  }
}

// The action may append newly created IDs to agents. Cleanup owns only that list.
export async function withAgentCleanup(agents, api, action, options = {}) {
  let result,
    primary,
    failed = false;
  try {
    result = await action();
  } catch (error) {
    primary = error;
    failed = true;
  }
  const failures = [];
  for (const [index, agent] of agents.entries()) {
    try {
      await deleteAgent(agent, api, options);
    } catch (error) {
      failures.push(annotateFailure(error, { agent_index: index }));
    }
  }
  if (failures.length) {
    const cleanup = annotateFailure(
      new AggregateError(failures, "Agent fixture cleanup failed"),
      { stage: "agent-cleanup" },
    );
    if (failed)
      throw annotateFailure(
        new AggregateError(
          [primary, cleanup],
          "Business and Agent fixture cleanup failed",
        ),
        { stage: "business-and-agent-cleanup" },
      );
    throw cleanup;
  }
  if (failed) throw primary;
  return result;
}
