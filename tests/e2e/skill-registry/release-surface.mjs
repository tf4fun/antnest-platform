import assert from "node:assert/strict";

// Inspect the built release image and query actual service handlers from their
// private control network. This runs before the ordinary Skill business flow.
export async function assertReleasedSkillSurface({
  docker,
  project,
  rcImage,
  networkPrefix,
  credentials,
  user,
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
    ].map((path) => [`http://${networkPrefix}.50:8080`, path]),
    ...[
      "",
      "/choices",
      "/operations",
      "/proof-loss-recovery",
      "/source-recovery",
    ].map((suffix) => [
      `http://${networkPrefix}.18:8080`,
      `/internal/agents/agent-1/legacy-system-skills-migration${suffix}`,
    ]),
  ];
  const program = `
    import {readFileSync} from "node:fs";
    const tokens = {
      rc: readFileSync("/run/auth/rc-token", "utf8"),
      controller: readFileSync("/run/auth/controller-token", "utf8"),
    };
    const routes = ${JSON.stringify(routes)};
    const checks = [];
    for (const [base, path] of routes) {
      for (const method of ["GET", "POST", "HEAD", "DELETE"]) {
        const response = await fetch(base + path, {
          method, signal: AbortSignal.timeout(10000),
          headers: {
            "Antnest-Service-Authorization": "Bearer " + tokens[base.includes(".50:") ? "rc" : "controller"],
            "Content-Type": "application/json",
          },
          ...(method === "POST" ? {body:"{}"} : {}),
        });
        await response.arrayBuffer();
        if (response.status !== 404) throw new Error(method + " " + path + " returned " + response.status);
        checks.push({ method, path, status: response.status });
      }
    }
    console.log(JSON.stringify({ checks }));
  `;
  const peer = `${project}-retired-route-probe`;
  let result;
  try {
    await docker([
      "create",
      "--name",
      peer,
      "--label",
      `com.docker.compose.project=${project}`,
      "--network",
      `${project}_controller-runtime`,
      "--user",
      user,
      "--read-only",
      "--cap-drop",
      "ALL",
      "-v",
      `${credentials}/agent-controller/tokens/runtime-controller:/run/auth/rc-token:ro`,
      "-v",
      `${credentials}/admin-console/tokens/agent-controller:/run/auth/controller-token:ro`,
      "node:24.21.0-bookworm-slim",
      "node",
      "--input-type=module",
      "-e",
      program,
    ]);
    await docker(["network", "connect", `${project}_controller-clients`, peer]);
    result = JSON.parse(await docker(["start", "-a", peer]));
  } finally {
    await docker(["rm", "-f", peer]);
  }
  assert.equal(result.checks.length, 36);
  return {
    rc_executables: ["runtime-controller"],
    retired_routes: result.checks,
  };
}
