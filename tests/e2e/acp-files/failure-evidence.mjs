import { inspect } from "node:util";
import {
  shellStoragePreflight,
  writeEvidenceFile,
} from "../../support/storage.mjs";
import { summarizeFailure } from "../../support/verification/failure.mjs";

export async function preserveFileFailure({
  directory,
  error,
  stage,
  inventory,
  fetchStatus = () =>
    fetch("http://file-model:8080/status", {
      signal: AbortSignal.timeout(5000),
    }),
}) {
  const result = { status: "failed", stage, ...summarizeFailure(error) };
  const failures = [];
  try {
    shellStoragePreflight(directory);
  } catch (failure) {
    return { ...result, evidence_failures: [summarizeFailure(failure)] };
  }
  for (const collect of [
    () =>
      writeEvidenceFile(
        directory,
        "failure.private.txt",
        inspect(error, {
          depth: 8,
          maxArrayLength: 1000,
          breakLength: Infinity,
        }) + "\n",
      ),
    () =>
      writeEvidenceFile(
        directory,
        "failure-inventory.private.json",
        JSON.stringify(inventory) + "\n",
      ),
    async () => {
      const response = await fetchStatus();
      writeEvidenceFile(
        directory,
        "failure-model-status.private.json",
        await response.text(),
      );
    },
  ]) {
    try {
      await collect();
    } catch (failure) {
      failures.push(summarizeFailure(failure));
    }
  }
  return {
    ...result,
    ...(failures.length ? { evidence_failures: failures } : {}),
  };
}
