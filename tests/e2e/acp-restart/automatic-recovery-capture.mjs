import assert from "node:assert/strict";
import { createRecoveryInventoryReader } from "./recovery-inventory.mjs";
import { readFile, writeFile, chmod, rename, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { dockerClient } from "../lifecycle-closeout/docker.mjs";
import { writeEvidenceFile } from "../../support/storage.mjs";
import { assertAutomaticRecoveryEvidence } from "./automatic-recovery-evidence.mjs";

export async function publishAutomaticRecoveryCheckpoint(
  checkpoint,
  snapshot,
  { signal, files = { writeFile, chmod, rename, rm } },
) {
  signal?.throwIfAborted();
  const pending = checkpoint + ".pending";
  let published = false;
  try {
    await files.writeFile(pending, JSON.stringify(snapshot), {
      flag: "wx",
      mode: 0o600,
    });
    signal?.throwIfAborted();
    await files.chmod(pending, 0o644);
    signal?.throwIfAborted();
    await files.rename(pending, checkpoint);
    published = true;
    signal?.throwIfAborted();
  } catch (error) {
    const failures = [error];
    for (const path of published ? [pending, checkpoint] : [pending]) {
      try {
        await files.rm(path, { force: true });
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    }
    if (failures.length > 1)
      throw new AggregateError(
        failures,
        "checkpoint publication and cleanup failed",
      );
    throw error;
  }
}

async function main() {
  const [expectedFile, checkpoint, directory] = process.argv.slice(2);
  assert(expectedFile && checkpoint && directory);
  const expected = JSON.parse(await readFile(expectedFile, "utf8"));
  const project = process.env.COMPOSE_PROJECT_NAME;
  assert.match(project ?? "", /^antnest-stage3-e2e-[0-9]+$/u);
  const abort = new AbortController();
  const interrupt = () =>
    abort.abort(new Error("automatic recovery capture interrupted"));
  for (const event of ["SIGINT", "SIGTERM"]) process.once(event, interrupt);
  const budget = Math.min(
    110000,
    Number(process.env.ANTNEST_E2E_DEADLINE_MS) - Date.now(),
  );
  assert(Number.isFinite(budget) && budget > 0);
  const signal = AbortSignal.any([
    abort.signal,
    AbortSignal.timeout(Math.ceil(budget)),
  ]);
  const docker = dockerClient(process.env, signal, budget);
  const observations = [];
  try {
    const readSnapshot = await createRecoveryInventoryReader({
      expected,
      project,
      signal,
      docker,
    });
    for (;;) {
      const snapshot = await readSnapshot();
      observations.push({ at: new Date().toISOString(), ...snapshot });
      writeEvidenceFile(
        directory,
        "automatic-recovery-observations.private.json",
        JSON.stringify(observations) + "\n",
      );
      for (const rows of Object.values(snapshot))
        assert(rows.length <= 1, "duplicated recovery inventory");
      assert.notEqual(
        snapshot.receipts[0]?.state,
        "failed",
        "automatic Rebuild failed",
      );
      if (
        snapshot.cycles[0]?.retired_at &&
        snapshot.receipts[0]?.started_at &&
        snapshot.receipts[0]?.state === "completed"
      ) {
        assertAutomaticRecoveryEvidence(snapshot, expected);
        // The disposable client runs under its service-auth UID. Only these
        // credential-free binding/receipt fields cross the temporary checkpoint.
        await publishAutomaticRecoveryCheckpoint(checkpoint, snapshot, {
          signal,
        });
        return;
      }
      await delay(250, undefined, { signal });
    }
  } finally {
    abort.abort();
    for (const event of ["SIGINT", "SIGTERM"])
      process.removeListener(event, interrupt);
  }
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  try {
    await main();
  } catch (error) {
    const directory = process.argv[4];
    if (directory)
      writeEvidenceFile(
        directory,
        "automatic-recovery-failure.private.json",
        JSON.stringify({
          name: error.name,
          message: error.message,
          stack: error.stack,
        }) + "\n",
      );
    console.error(
      "Automatic recovery database capture failed; private observations retained",
    );
    process.exitCode = 1;
  }
}
