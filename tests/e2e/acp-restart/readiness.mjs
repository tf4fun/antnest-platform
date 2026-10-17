import { AssertionError } from "node:assert";
import { PrivateACPExecutionStateUnavailableError } from "../../support/private-acp-execution-state-error.mjs";

export async function stateReady(
  read,
  accepts = (state) => state.availability === "ready",
) {
  try {
    return accepts(await read());
  } catch (error) {
    if (error instanceof PrivateACPExecutionStateUnavailableError) return false;
    if (
      error instanceof AssertionError &&
      error.actual === 503 &&
      error.expected === 200
    )
      return false;
    throw error;
  }
}
