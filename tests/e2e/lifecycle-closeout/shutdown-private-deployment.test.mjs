import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { foundationPrivateDeploymentFixture } from "./foundation-private-deployment.fixture.mjs";
import { inspectFoundationPrivateDeployment } from "./foundation-private-deployment.mjs";
import { inspectFoundationDeployment } from "./foundation-setup.mjs";
import { assertDeployment } from "./deployment.mjs";
test("Shutdown keeps sixteen raw private services, nine application images and fresh candidate admission", () => {
  const f = foundationPrivateDeploymentFixture(),
    original = structuredClone(f.rows);
  const base = inspectFoundationPrivateDeployment(f.rows, f.config);
  assert.equal(f.rows.length, 16);
  assert.deepEqual(f.rows, original);
  assert.equal(inspectFoundationDeployment(base, f.config).services, 15);
  assert.equal(
    assertDeployment(
      f.config,
      base.map((r) => ({
        labels: r.Config.Labels,
        image: r.Image,
        running: r.State.Running,
        health: r.State.Health?.Status ?? "none",
        ports: r.NetworkSettings.Ports,
      })),
      f.images,
    ).applicationImages,
    9,
  );
  const source = readFileSync(
    new URL("./foundation-run.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /if \(profile === "shutdown"\) configureFoundationPrivate\(config\)/u,
  );
  assert.match(
    source,
    /profile === "shutdown"\s*\? inspectFoundationPrivateDeployment\(rows, config\)/u,
  );
  assert.match(
    source,
    /admission = await admitRecoveryBusiness\(profile, result, \{/u,
  );
  const make = readFileSync(
    new URL("../../../Makefile", import.meta.url),
    "utf8",
  );
  assert.match(
    make,
    /e2e-lifecycle-shutdown:\n\s+node tests\/support\/authenticated-shell-e2e\.mjs lifecycle-shutdown/u,
  );
});
