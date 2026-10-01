import assert from "node:assert/strict";

// Inspect the built release image and query actual service handlers from their
// private control network. This runs before the ordinary Skill business flow.
export async function assertReleasedSkillSurface({
  docker,
  project,
  rcImage,
  acpContainer,
}) {
  const executables = await docker([
    "run",
    "--rm",
    "--name",
    `${project}-rc-release-probe`,
    "--label",
    `com.docker.compose.project=${project}`,
    "--network",
    "none",
    "--read-only",
    "--entrypoint",
    "/bin/sh",
    rcImage,
    "-ec",
    "test ! -e /usr/local/bin/legacy-backup-export; test ! -e /usr/local/bin/legacy-backup-attest; ls /usr/local/bin",
  ]);
  assert.deepEqual(executables.trim().split(/\s+/), ["runtime-controller"]);
  const routes = [
    ...[
      "/internal/legacy-system-skills/inventory",
      "/internal/legacy-system-skills/backups",
      "/internal/legacy-system-skills/backups/retired",
      "/internal/runtimes/agent-1/skill-sets/verify-active",
    ].map((path) => ["http://runtime-controller:8080", path]),
    ...[
      "",
      "/choices",
      "/operations",
      "/proof-loss-recovery",
      "/source-recovery",
    ].map((suffix) => [
      "http://agent-controller:8080",
      `/internal/agents/agent-1/legacy-system-skills-migration${suffix}`,
    ]),
  ];
  const program = `
    const routes = ${JSON.stringify(routes)};
    const checks = [];
    for (const [base, path] of routes) {
      for (const method of ["GET", "POST", "HEAD", "DELETE"]) {
        const response = await fetch(base + path, { method, signal: AbortSignal.timeout(10000) });
        await response.arrayBuffer();
        if (response.status !== 404) throw new Error(method + " " + path + " returned " + response.status);
        checks.push({ method, path, status: response.status });
      }
    }
    console.log(JSON.stringify({ checks }));
  `;
  const result = JSON.parse(
    await docker([
      "exec",
      "-e",
      "NODE_OPTIONS=",
      acpContainer,
      "node",
      "--input-type=module",
      "-e",
      program,
    ]),
  );
  assert.equal(result.checks.length, 36);
  return {
    rc_executables: ["runtime-controller"],
    retired_routes: result.checks,
  };
}
