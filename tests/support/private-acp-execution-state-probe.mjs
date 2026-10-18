import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateACPExecutionStateUnavailableError } from "./private-acp-execution-state-error.mjs";

export async function probePrivateExecutionState(
  input,
  {
    read = async (...args) =>
      (
        await import("./private-acp-execution-state.mjs")
      ).readPrivateExecutionState(...args),
    save,
  },
) {
  assert(
    Number.isSafeInteger(input.timeoutMs) &&
      input.timeoutMs > 0 &&
      input.timeoutMs <= 15000,
  );
  assert.equal(typeof save, "function");
  const receipt = {
    version: 1,
    agentId: input.agentId,
    outcome: "failed",
    receipts: [],
  };
  let failure;
  try {
    receipt.state = await read(
      input.agentId,
      { accessToken: input.accessToken },
      {
        principal: input.principal,
        receipts: receipt.receipts,
        secrets: [],
        signal: AbortSignal.timeout(input.timeoutMs),
      },
    );
    receipt.outcome = "passed";
  } catch (error) {
    failure = error;
    receipt.outcome =
      error instanceof PrivateACPExecutionStateUnavailableError
        ? "unavailable"
        : "failed";
    receipt.error = { name: error.name, message: error.message };
  }
  try {
    await save(receipt);
  } catch (error) {
    if (failure)
      throw new AggregateError(
        [failure, error],
        "Private state read and archive failed",
      );
    throw error;
  }
  // A completed observation, including a rejection, is communicated through
  // its private file. A nonzero process exit is always an orchestration failure.
  return receipt;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const input = JSON.parse(await readFile(process.argv[2], "utf8"));
  await probePrivateExecutionState(input, {
    save: (receipt) =>
      writeFile(process.argv[3], JSON.stringify(receipt), {
        flag: "wx",
        mode: 0o600,
      }),
  });
}
