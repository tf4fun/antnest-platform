import assert from "node:assert/strict";
import { PrivateACPExecutionStateUnavailableError } from "../../support/private-acp-execution-state-error.mjs";

export async function readRestartExecutionState(
  agentId,
  browser,
  options = {},
) {
  const { preserve, ...readerOptions } = options;
  assert.equal(typeof preserve, "function", "private state archive required");
  // Reuse the complete private reader when a state observation is issued.
  const errors = [];
  let state;
  try {
    const { readPrivateExecutionState } =
      await import("../../support/private-acp-execution-state.mjs");
    state = await readPrivateExecutionState(agentId, browser, readerOptions);
    assert.equal(state.access_allowed, true, "Restart owner access denied");
  } catch (error) {
    errors.push(error);
  }
  try {
    await preserve(structuredClone(readerOptions.receipts));
  } catch (error) {
    errors.push(error);
  }
  if (
    readerOptions.signal?.aborted &&
    !errors.includes(readerOptions.signal.reason)
  )
    errors.push(readerOptions.signal.reason);
  if (errors.length === 1) throw errors[0];
  if (errors.length)
    throw new AggregateError(errors, "Restart state read and archive failed");
  return state;
}

export async function stateReady(
  read,
  accepts = (state) => state.availability === "ready",
) {
  try {
    return accepts(await read());
  } catch (error) {
    if (error instanceof PrivateACPExecutionStateUnavailableError) return false;
    throw error;
  }
}
