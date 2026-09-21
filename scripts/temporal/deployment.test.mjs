import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(
  new URL("../../services/agent-acp-service/package.json", import.meta.url),
);
const { parse } = require("yaml");
const root = new URL("../../", import.meta.url);
test("Temporal readiness gates Controller even after namespace initialization has exited", async () => {
  const { services } = parse(
    await readFile(new URL("compose.yaml", root), "utf8"),
  );
  assert.equal(
    services["agent-controller"].depends_on.temporal?.condition,
    "service_healthy",
  );
  assert.equal(
    services["agent-controller"].depends_on["temporal-namespace"].condition,
    "service_completed_successfully",
  );
  assert.equal(
    services["temporal-namespace"].depends_on.temporal.condition,
    "service_healthy",
  );
});
test("Temporal probe runs inside the pinned derived image without publishing HTTP", async () => {
  const { services } = parse(
    await readFile(new URL("compose.yaml", root), "utf8"),
  );
  const temporal = services.temporal;
  assert.equal(temporal.image, "antnest/temporal:local");
  assert.equal(temporal.build.dockerfile, "scripts/temporal/Dockerfile");
  assert.deepEqual(temporal.healthcheck.test, [
    "CMD",
    "sh",
    "/etc/temporal/readiness.sh",
  ]);
  assert.equal(temporal.healthcheck.timeout, "10s");
  assert(temporal.ports.every((port) => !port.includes("7243")));
  const dockerfile = await readFile(
    new URL(temporal.build.dockerfile, root),
    "utf8",
  );
  assert.match(dockerfile, /FROM temporalio\/admin-tools:1\.31\.0 AS tools/);
  assert.match(dockerfile, /FROM temporalio\/server:1\.31\.0/);
  for (const target of ["docker-build", "docker-build-stage3"]) {
    const make = await readFile(new URL("Makefile", root), "utf8");
    const recipe = make.split(`${target}:`)[1].split("\n\n")[0];
    assert.match(recipe, /build temporal/);
  }
});
