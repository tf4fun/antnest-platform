import { DomainError } from "./errors.js";
import type { RunState } from "./types.js";

export type RunRecoveryAction = "retry_admission" | "finish_unresolved" | "none";

const VALID_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  admitting: ["running", "failed", "unresolved"],
  running: ["completed", "cancelled", "failed", "unresolved"],
  completed: [],
  cancelled: [],
  failed: [],
  unresolved: [],
};

export function classifyRunRecovery(state: RunState): RunRecoveryAction {
  if (state === "admitting") {
    return "retry_admission";
  }
  if (state === "running") {
    return "finish_unresolved";
  }
  return "none";
}

export function transitionRun(current: RunState, next: RunState): RunState {
  if (!VALID_TRANSITIONS[current].includes(next)) {
    throw new DomainError("invalid_run_transition", `Invalid Run transition ${current} -> ${next}`);
  }
  return next;
}
