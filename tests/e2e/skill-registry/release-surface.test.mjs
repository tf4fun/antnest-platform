import assert from "node:assert/strict";
import test from "node:test";
import { assertReleasedSkillSurface } from "./release-surface.mjs";

test("retired-route probes use an owned peer without extending a production workload's networks", async () => {
  const project = "antnest-lifecycle-1234abcd";
  const calls = [];
  const docker = async (args) => {
    calls.push(args);
    if (args[0] === "run") return "runtime-controller";
    if (args[0] === "create") return "own-peer";
    if (args[0] === "network") return "";
    if (args[0] === "start")
      return JSON.stringify({
        checks: Array.from({ length: 36 }, () => ({ status: 404 })),
      });
    if (args[0] === "rm") return "";
    throw new Error(
      "cannot use a production container as a cross-network probe",
    );
  };
  const report = await assertReleasedSkillSurface({
    docker,
    project,
    rcImage: "antnest/runtime-controller:candidate",
    networkPrefix: "10.244.45",
    credentials: "/fixture/credentials",
    user: "501:20",
  });
  assert.equal(report.retired_routes.length, 36);
  const created = calls.find((args) => args[0] === "create");
  assert(created.includes(`${project}_controller-runtime`));
  assert(!created.includes("production-acp"));
  assert(!created.includes("/etc/antnest/service-auth"));
  assert(
    created.includes(
      "/fixture/credentials/agent-controller/tokens/runtime-controller:/run/auth/rc-token:ro",
    ),
  );
  assert(
    created.includes(
      "/fixture/credentials/admin-console/tokens/agent-controller:/run/auth/controller-token:ro",
    ),
  );
  assert.equal(created.filter((arg) => arg === "-v").length, 2);
  const connected = calls.find((args) => args[0] === "network");
  assert.deepEqual(connected, [
    "network",
    "connect",
    `${project}_controller-clients`,
    `${project}-retired-route-probe`,
  ]);
  assert(calls.at(-1).includes("rm"));
});
