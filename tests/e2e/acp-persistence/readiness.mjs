import { AssertionError } from "node:assert";
import assert from "node:assert/strict";
import { PrivateACPExecutionStateUnavailableError } from "../../support/private-acp-execution-state-error.mjs";

export async function readPersistenceExecutionState(
  agentId,
  browser,
  options = {},
) {
  const { preserve, ...readerOptions } = options;
  assert.equal(typeof preserve, "function", "private state archive required");
  // Restart still imports the legacy readiness predicate without a schema
  // mount. Load the complete private reader only for this migrated consumer.
  const errors = [];
  let state;
  try {
    const { readPrivateExecutionState } =
      await import("../../support/private-acp-execution-state.mjs");
    state = await readPrivateExecutionState(agentId, browser, readerOptions);
    assert.equal(state.access_allowed, true, "Persistence owner access denied");
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
    throw new AggregateError(
      errors,
      "Persistence state read and archive failed",
    );
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
    if (
      error instanceof AssertionError &&
      error.actual === 503 &&
      error.expected === 200
    )
      return false;
    throw error;
  }
}
