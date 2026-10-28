import { inspect } from "node:util";
import { readFileSync } from "node:fs";
import {
  shellStoragePreflight,
  writeEvidenceFile,
} from "../../support/storage.mjs";
import { summarizeFailure } from "../../support/verification/failure.mjs";

function sourceLocation(error, source) {
  try {
    if (
      !source ||
      !/^tests\/e2e\/[a-zA-Z0-9/_.-]+\.mjs$/u.test(source.file) ||
      source.file.includes("..")
    )
      return {};
    const count = readFileSync(new URL(source.url), "utf8").split("\n").length;
    const location = source.url.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const pattern = new RegExp(
      `^\\s+at (?:async )?(?:[^()]* \\()?${location}:([0-9]+):[0-9]+\\)?$`,
      "u",
    );
    for (const frame of String(error.stack).split("\n").slice(1)) {
      const match = pattern.exec(frame);
      const line = Number(match?.[1]);
      if (Number.isSafeInteger(line) && line > 0 && line <= count)
        return { source: { file: source.file, line } };
    }
  } catch {
    /* Missing source diagnostics cannot replace the original failure. */
  }
  return {};
}

export async function preserveFileFailure({
  directory,
  error,
  stage,
  inventory,
  publicSource,
  fetchStatus = () =>
    fetch("http://file-model:8080/status", {
      signal: AbortSignal.timeout(5000),
    }),
}) {
  const result = {
    status: "failed",
    stage,
    ...summarizeFailure(error),
    ...sourceLocation(error, publicSource),
  };
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
