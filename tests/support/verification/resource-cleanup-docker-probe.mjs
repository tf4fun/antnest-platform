// Manual probe only: pass a fresh artifacts/verification directory as argv[2].
// This creates one named volume; it does not exercise anonymous volumes or Runtime.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dockerClient } from "../../e2e/lifecycle-closeout/docker.mjs";
import { createResourceCheckedRunner, verdict } from "../ci-shard.mjs";
import { durablePath } from "../storage.mjs";
import { compareEnvironment, snapshotEnvironment } from "./environment.mjs";

async function main() {
  assert.equal(
    process.argv.length,
    3,
    "expected one fresh private evidence directory",
  );
  const directory = durablePath(process.argv[2]);
  mkdirSync(dirname(directory), { recursive: true, mode: 0o700 });
  mkdirSync(directory, { mode: 0o700 });
  const save = (name, value) =>
    writeFileSync(
      join(directory, name),
      `${JSON.stringify(value, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
  const owner = randomUUID();
  const volume = `antnest-resource-cleanup-${owner}`;
  const ownerLabel = "io.antnest.verification.owner";
  const probeLabel = "io.antnest.verification.probe";
  const probe = "named_volume_inventory_detection";
  const suite = "skill-registry-rc-prepare";
  const cancellation = new AbortController();
  const stop = () =>
    cancellation.abort(new Error("manual resource probe interrupted"));
  const failures = [];
  const failed = (stage, error) =>
    failures.push({
      stage,
      name: error?.name ?? "Error",
      message: String(error?.message ?? error),
    });
  let before, after, admission, evidence, comparison;
  let creationAttempted = false,
    removed = false;
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stop);
  try {
    before = await snapshotEnvironment({ signal: cancellation.signal });
    save("before.json", before);
    assert(
      !before.resources.volumes.includes(volume),
      "probe volume must be newly owned",
    );
    const checked = createResourceCheckedRunner({
      snapshot: snapshotEnvironment,
      stopped: () => cancellation.signal.aborted,
      run: async () => {
        cancellation.signal.throwIfAborted();
        creationAttempted = true;
        const created = await dockerClient(
          process.env,
          cancellation.signal,
          120000,
        )([
          "volume",
          "create",
          "--label",
          `${ownerLabel}=${owner}`,
          "--label",
          `${probeLabel}=${probe}`,
          volume,
        ]);
        assert.equal(
          created,
          volume,
          "Docker must return the exact owned volume name",
        );
        return {
          code: 0,
          output: "named-volume probe business completed\n",
          timedOut: false,
        };
      },
      record: (id, value) => {
        assert.equal(id, suite);
        evidence = value;
        save("admission-evidence.json", value);
      },
    });
    admission = await checked("create one owned named volume", suite);
    save("admission.json", admission);
    assert.equal(
      admission.code,
      1,
      "real volume drift must reject business exit zero",
    );
    assert.deepEqual(evidence.business, {
      executed: true,
      code: 0,
      timedOut: false,
    });
    assert.equal(
      evidence.error,
      undefined,
      "inventory observation must actually succeed",
    );
    assert.deepEqual(
      evidence.baseline,
      before,
      "admission must use the original environment",
    );
    assert.equal(evidence.comparison.unchanged, false);
    assert.deepEqual(evidence.comparison.resources, {
      containers: { added: [], removed: [] },
      volumes: { added: [volume], removed: [] },
      networks: { added: [], removed: [] },
    });
    assert.deepEqual(evidence.comparison.retained_changes, []);
    assert.deepEqual(evidence.comparison.image_changes, []);
    assert.equal(
      verdict(admission.code, admission.output, false, suite),
      "failed",
    );
    cancellation.signal.throwIfAborted();
  } catch (error) {
    failed("admission", error);
  } finally {
    // A fresh budget is independent of business cancellation. Every real
    // Docker child is awaited, including on abort; no global delta is deleted.
    const cleanup = dockerClient(process.env, undefined, 120000);
    if (creationAttempted) {
      try {
        const rows = JSON.parse(await cleanup(["volume", "inspect", volume]));
        assert.equal(rows.length, 1, "inspect exactly one owned volume");
        assert.equal(
          rows[0].Name,
          volume,
          "preserve any differently named resource",
        );
        assert.equal(
          rows[0].Labels?.[ownerLabel],
          owner,
          "preserve resources with another owner",
        );
        assert.equal(
          rows[0].Labels?.[probeLabel],
          probe,
          "preserve resources without the probe label",
        );
        assert(
          !before.resources.volumes.includes(volume),
          "preserve every original volume",
        );
        await cleanup(["volume", "rm", volume]);
        removed = true;
      } catch (error) {
        failed("owned-volume-cleanup", error);
      }
    }
    if (before) {
      try {
        after = await snapshotEnvironment({ before, docker: cleanup });
        comparison = compareEnvironment(before, after);
        save("after.json", after);
        save("cleanup-comparison.json", comparison);
        assert.equal(
          comparison.unchanged,
          true,
          "global environment must return to the original baseline",
        );
      } catch (error) {
        failed("final-environment", error);
      }
    }
    for (const signal of ["SIGINT", "SIGTERM"]) process.off(signal, stop);
  }
  if (cancellation.signal.aborted)
    failed("cancellation", cancellation.signal.reason);
  try {
    save("evidence.json", {
      probe,
      owner,
      volume,
      creation_attempted: creationAttempted,
      removed,
      comparison,
      failures,
      status: failures.length ? "failed" : "passed",
    });
  } catch (error) {
    failed("evidence", error);
  }
  console.log(
    JSON.stringify({
      probe,
      status: failures.length ? "failed" : "passed",
      business_code: evidence?.business?.code ?? null,
      admission_code: admission?.code ?? null,
      cleanup_verified: removed && comparison?.unchanged === true,
      errors: failures.length,
    }),
  );
  if (failures.length) process.exitCode = 1;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main().catch(() => {
    console.error(
      "Resource cleanup Docker probe failed; inspect the private evidence directory.",
    );
    process.exitCode = 1;
  });
}
