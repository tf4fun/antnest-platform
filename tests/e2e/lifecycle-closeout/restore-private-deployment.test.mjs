import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { foundationPrivateDeploymentFixture } from "./foundation-private-deployment.fixture.mjs";
import { inspectFoundationPrivateDeployment } from "./foundation-private-deployment.mjs";
import { inspectFoundationDeployment } from "./foundation-setup.mjs";
import { assertDeployment } from "./deployment.mjs";

test("Restore keeps sixteen raw private services, nine application images and its exact fresh-image entrypoint", () => {
  const f = foundationPrivateDeploymentFixture(),
    before = structuredClone(f.rows);
  const base = inspectFoundationPrivateDeployment(f.rows, f.config);
  assert.equal(f.rows.length, 16);
  assert.deepEqual(f.rows, before);
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
    /if \(profile === "restore"\) configureFoundationPrivate\(config\)/u,
  );
  assert.match(
    source,
    /profile === "restore"\s*\? inspectFoundationPrivateDeployment\(rows, config\)/u,
  );
  assert.match(source, /admission = restorePrivateAdmission\(result\)/u);
  const makefile = readFileSync(
    new URL("../../../Makefile", import.meta.url),
    "utf8",
  );
  assert.match(
    makefile,
    /e2e-lifecycle-restore:\n\s+node tests\/support\/authenticated-shell-e2e\.mjs lifecycle-restore/u,
  );
});
