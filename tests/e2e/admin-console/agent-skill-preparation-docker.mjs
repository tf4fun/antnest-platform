import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const container = `antnest-console-skill-progress-${randomBytes(5).toString("hex")}`;
const organization = `org_${randomBytes(16).toString("hex")}`;
const otherOrganization = `org_${randomBytes(16).toString("hex")}`;
const key = "console-skill-preparation-original-0001";
const requestID = `lifecycle-${createHash("sha256").update(`${organization}\0${key}`).digest("hex")}`;
const lifecycleKeys = Object.fromEntries(
  ["rebuild", "enable"].map((kind) => {
    const value = `console-skill-${kind}-original-0001`;
    return [
      kind,
      {
        key: value,
        requestID: `lifecycle-${createHash("sha256").update(`${organization}\0${value}`).digest("hex")}`,
      },
    ];
  }),
);
const evidence = fileURLToPath(
  new URL(
    "../../../artifacts/verification/console-skill-preparation-docker.json",
    import.meta.url,
  ),
);
const docker = (...args) =>
  execFileSync("docker", args, { encoding: "utf8" }).trim();
const principal = (org = organization, role = "admin") => ({
  "X-Antnest-User-ID": "user-admin",
  "X-Antnest-Organization-ID": org,
  "X-Antnest-Membership-ID": "membership-1",
  "X-Antnest-System-Role": "user",
  "X-Antnest-Organization-Role": role,
});

let controller;
let started = false;
const calls = [];
function stop() {
  if (started) docker("rm", "-f", container);
  started = false;
}
const interrupt = () => {
  stop();
  process.exit(130);
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
try {
  controller = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    calls.push({ path: url.pathname, query: url.searchParams.toString() });
    const kind =
      url.pathname === `/internal/agent-skill-preparations/${requestID}`
        ? "create"
        : Object.keys(lifecycleKeys).find(
            (item) =>
              url.pathname ===
              `/internal/agent-skill-preparations/${lifecycleKeys[item].requestID}`,
          );
    if (
      request.method !== "GET" ||
      !kind ||
      url.searchParams.get("organization_id") !== organization
    ) {
      response.writeHead(404, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          code: "preparation_not_found",
          message: "Skill preparation was not found",
          retryable: false,
        }),
      );
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        request_id:
          kind === "create" ? requestID : lifecycleKeys[kind].requestID,
        agent_id: "agent-1",
        kind,
        state: "retry_wait",
        progress: {
          verified_packages: 1,
          verified_bytes: 128,
          total_packages: 2,
          total_bytes: 256,
        },
        updated_at: "2026-09-27T12:00:00Z",
        target_spec: { system_prompt: "secret" },
        prepared_reference_id: "secret",
      }),
    );
  });
  await new Promise((resolve, reject) => {
    controller.once("error", reject);
    controller.listen(0, "0.0.0.0", resolve);
  });
  const port = controller.address().port;
  docker(
    "run",
    "-d",
    "--name",
    container,
    "-p",
    "127.0.0.1::8080",
    "-e",
    `ANTNEST_IDENTITY_SERVICE_URL=http://host.docker.internal:${port}`,
    "-e",
    `ANTNEST_AGENT_CONTROLLER_URL=http://host.docker.internal:${port}`,
    "-e",
    `ANTNEST_AGENT_ACP_SERVICE_URL=http://host.docker.internal:${port}`,
    "-e",
    "OTEL_SDK_DISABLED=true",
    "antnest/admin-console:local",
  );
  started = true;
  const base = `http://${docker("port", container, "8080/tcp").split("\n")[0]}`;
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      if ((await fetch(base + "/status")).ok) {
        ready = true;
        break;
      }
    } catch {
      /* starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(ready, "Console did not start");
  const path = "/api/admin/agent-skill-preparations/by-idempotency-key";
  const read = async (headers, suffix = "") => {
    const response = await fetch(base + path + suffix, { headers });
    return {
      status: response.status,
      cache: response.headers.get("cache-control"),
      body: await response.json(),
    };
  };
  const progress = await read({ ...principal(), "Idempotency-Key": key });
  assert.equal(progress.status, 200, JSON.stringify(progress.body));
  assert.equal(progress.cache, "no-store");
  assert.deepEqual(progress.body.progress, {
    verified_packages: 1,
    verified_bytes: 128,
    total_packages: 2,
    total_bytes: 256,
  });
  assert.ok(!JSON.stringify(progress.body).includes("secret"));
  for (const kind of ["rebuild", "enable"]) {
    const result = await read({
      ...principal(),
      "Idempotency-Key": lifecycleKeys[kind].key,
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.kind, kind);
    assert.equal(result.body.request_id, lifecycleKeys[kind].requestID);
  }
  const scoped = await read({
    ...principal(otherOrganization),
    "Idempotency-Key": key,
  });
  assert.equal(scoped.status, 404);
  const forbidden = await read({
    ...principal(organization, "member"),
    "Idempotency-Key": key,
  });
  assert.equal(forbidden.status, 403);
  const invalid = await read(
    { ...principal(), "Idempotency-Key": key },
    "?organization_id=" + otherOrganization,
  );
  assert.equal(invalid.status, 400);
  assert.equal(calls.length, 4);
  const result = {
    scope: "Docker Admin Console BFF with isolated Controller stub",
    kinds: ["create", "rebuild", "enable"],
    progress: progress.body.progress,
    crossOrganization: scoped.status,
    member: forbidden.status,
    invalidQuery: invalid.status,
    upstreamCalls: calls.length,
  };
  await mkdir(
    fileURLToPath(new URL("../../../artifacts/verification/", import.meta.url)),
    { recursive: true },
  );
  await writeFile(evidence, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
} finally {
  stop();
  if (controller) {
    controller.closeAllConnections();
    await new Promise((resolve) => controller.close(resolve));
  }
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
