import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dockerClient } from "../lifecycle-closeout/docker.mjs";
import { runCommand } from "../../support/run-command.mjs";
import { skillArtifact } from "./stage3-fixture.mjs";
import {
  createFixture,
  callerContext,
} from "../service-authentication/registry/auth-fixture.mjs";
import { authenticationProbes } from "../service-authentication/registry/probes.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const id = randomUUID().slice(0, 8);
const project = `antnest-skill-discovery-${id}`;
const image = `antnest/skill-registry:discovery-${id}`;
const callerAware = process.env.ANTNEST_E2E_DISCOVERY_CALLER === "true";
const traceBatch = process.env.ANTNEST_E2E_REGISTRY_TRACE === "true";
const output = resolve(
  root,
  `artifacts/verification/issue-31-registry-auth-20261004/docker-${id}`,
);
mkdirSync(output, { recursive: true, mode: 0o700 });
const authDirectory = mkdtempSync(resolve(tmpdir(), "antnest-registry-auth-"));
const auth = createFixture(authDirectory);
const env = {
  ...process.env,
  ANTNEST_DISCOVERY_TEST_IMAGE: image,
  ANTNEST_DISCOVERY_AUTH_DIRECTORY: authDirectory,
  ANTNEST_DISCOVERY_UID: String(process.getuid()),
  ANTNEST_DISCOVERY_GID: String(process.getgid()),
};
const controller = new AbortController();
const stop = () => controller.abort();
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stop);
const docker = dockerClient(env, controller.signal, 1200000);
const compose = [
  "compose",
  "--env-file",
  "/dev/null",
  "--project-name",
  project,
  "-f",
  resolve(root, "tests/e2e/skill-registry/discovery.compose.yaml"),
];
const credentialHeaders = (caller, changes = {}) => ({
  "Antnest-Service-Authorization": "Bearer " + auth.incoming[caller],
  ...(caller === "admin-console"
    ? { "Antnest-Caller-Context": callerContext(auth, changes) }
    : {}),
});
const callerFor = (path) =>
  path.includes("/skill-projections/promote")
    ? "admin-console"
    : path.includes("/skill-versions/resolve")
      ? "agent-controller"
      : path.startsWith("/internal/skills")
        ? "admin-console"
        : "agent-acp-service";
const org = `org_${"a".repeat(32)}`;
const owner = `user_${"c".repeat(32)}`;
const otherOwner = `user_${"d".repeat(32)}`;
const checks = [];
const save = (name, value) =>
  writeFileSync(resolve(output, name), JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  });
const inventory = async (client) => ({
  containers: (await client(["ps", "-aq"])).split(/\s+/).filter(Boolean).sort(),
  running: (await client(["ps", "-q"])).split(/\s+/).filter(Boolean).sort(),
  networks: (await client(["network", "ls", "-q"]))
    .split(/\s+/)
    .filter(Boolean)
    .sort(),
  volumes: (await client(["volume", "ls", "-q"]))
    .split(/\s+/)
    .filter(Boolean)
    .sort(),
});
let baseline,
  primaryError,
  built = false;
try {
  baseline = await inventory(docker);
  save("baseline.json", baseline);
  console.log(JSON.stringify({ project, stage: "build" }));
  await docker(
    [
      "build",
      "--tag",
      image,
      "--file",
      "services/skill-registry/Dockerfile",
      ".",
    ],
    true,
  );
  built = true;
  console.log(JSON.stringify({ project, stage: "start" }));
  await docker(
    [
      ...compose,
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      "120",
      "--no-build",
      "--pull",
      "never",
    ],
    true,
  );
  const ids = (await docker([...compose, "ps", "-q"]))
    .split(/\s+/)
    .filter(Boolean);
  const rows = JSON.parse(await docker(["inspect", ...ids]));
  const port = (service, internal) => {
    const row = rows.find(
      (row) => row.Config.Labels["com.docker.compose.service"] === service,
    );
    const binding = row.NetworkSettings.Ports[`${internal}/tcp`][0];
    assert.equal(binding.HostIp, "127.0.0.1");
    return binding.HostPort;
  };
  let registry = `http://127.0.0.1:${port("registry", 8080)}`;
  const source = `http://127.0.0.1:${port("source", 8080)}`;
  console.log(
    JSON.stringify({ project, stage: "postgres-and-http-components" }),
  );
  const integration = await runCommand({
    command: [
      process.execPath,
      "tests/integration/go/run.mjs",
      "skill-registry",
      "--output",
      output,
      "--",
      "-race",
      "-timeout",
      "90s",
    ],
    cwd: root,
    output,
    name: "registry-components",
    env: {
      ...env,
      GOCACHE: resolve(root, ".cache/go-build"),
      GOMODCACHE: resolve(root, ".cache/go-mod"),
      ANTNEST_SKILL_REGISTRY_TEST_DATABASE_URL: `postgres://registry_service:discovery-fixture-registry@127.0.0.1:${port("postgres", 5432)}/registry?sslmode=disable`,
    },
    timeoutMs: 180000,
    graceMs: 5000,
  });
  assert.equal(integration.exit_code, 0, "Registry component tests failed");
  checks.push("unit-contract-http-postgres-race");
  console.log(JSON.stringify({ project, stage: "deployed-registry-flow" }));
  async function call(path, value, status = 200, method = "POST") {
    const response = await fetch(registry + path, {
      method,
      headers: {
        ...credentialHeaders(callerFor(path)),
        "Content-Type": "application/json",
        Connection: "close",
      },
      body: JSON.stringify(value),
      signal: AbortSignal.timeout(20000),
    });
    const type = response.headers.get("content-type") ?? "";
    const result = type.startsWith("application/zip")
      ? Buffer.from(await response.arrayBuffer())
      : await response.json();
    assert.equal(
      response.status,
      status,
      `Unexpected Registry status for ${path}: ${response.status}`,
    );
    return { response, result };
  }
  async function sourceState(next) {
    const response = await fetch(source + "/fixture/state", {
      method: next ? "POST" : "GET",
      headers: { "Content-Type": "application/json" },
      body: next ? JSON.stringify(next) : undefined,
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    return response.json();
  }
  const asProjection = (value) => {
    const projection = { ...value };
    delete projection.artifact_reads;
    delete projection.inspections;
    return projection;
  };
  let projection = asProjection(await sourceState());
  const update = (value) =>
    call("/internal/skill-projections", value, 200, "PUT");
  const search = (actor = owner, organization = org, status = 200) =>
    call(
      "/internal/skill-discovery/search",
      {
        organization_id: organization,
        actor_id: actor,
        query: "review",
        limit: 20,
      },
      status,
    );
  const loadInput = (item) => ({
    organization_id: org,
    actor_id: owner,
    skill_ref: item.skill_ref,
    expected_digest: item.content_digest,
  });
  const countVersions = async () =>
    Number(
      await docker([
        ...compose,
        "exec",
        "-T",
        "postgres",
        "psql",
        "-U",
        "postgres",
        "-d",
        "registry",
        "-At",
        "-c",
        `SELECT count(*) FROM skill_versions v JOIN skills s USING(skill_id) WHERE s.organization_id='${org}'`,
      ]),
    );
  const authentication = await authenticationProbes({
    registry,
    credentialHeaders,
    archive: skillArtifact(1),
    owner,
    organization: org,
    check: (name) => checks.push(name),
  });
  const createdBy = await docker([
    ...compose,
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "postgres",
    "-d",
    "registry",
    "-At",
    "-c",
    `SELECT created_by FROM skills WHERE skill_id='${authentication.published.skill_id}'`,
  ]);
  assert.equal(createdBy, owner);
  assert.equal((await update(projection)).result.outcome, "applied");
  assert.equal((await update(projection)).result.outcome, "replayed");
  const oldItem = (await search()).result.items[0];
  assert.equal(oldItem.skill_ref.kind, "agent");
  const loaded = await call(
    "/internal/skill-discovery/load",
    loadInput(oldItem),
  );
  assert.deepEqual(loaded.result, skillArtifact(1));
  assert.equal(loaded.response.headers.get("cache-control"), "no-store");
  assert.equal(await countVersions(), 0);
  const binaryColumns = Number(
    await docker([
      ...compose,
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "postgres",
      "-d",
      "registry",
      "-At",
      "-c",
      "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='skill_projections' AND column_name IN ('artifact','skill_text','instructions','file_manifest')",
    ]),
  );
  assert.equal(binaryColumns, 0);
  assert.deepEqual((await search(otherOwner)).result.items, []);
  assert.deepEqual(
    (await search(owner, `org_${"e".repeat(32)}`)).result.items,
    [],
  );
  assert.equal(
    (
      await call(
        "/internal/skill-discovery/load",
        { ...loadInput(oldItem), actor_id: otherOwner },
        404,
      )
    ).result.error.code,
    "not_found",
  );
  checks.push("metadata-only-no-ownership-transfer-owner-org-isolation");

  await sourceState({ version: 2, sequence: 2 });
  const currentItem = (await search()).result.items[0];
  assert.equal(
    currentItem.skill_ref.sequence,
    2,
    "Live inspection must refresh the lagging index",
  );
  assert.equal(
    (await call("/internal/skill-discovery/load", loadInput(oldItem), 409))
      .result.error.code,
    "content_changed",
  );
  assert.deepEqual(
    (await call("/internal/skill-discovery/load", loadInput(currentItem)))
      .result,
    skillArtifact(2),
  );
  await sourceState({ unavailable: true });
  assert.equal(
    (await call("/internal/skill-discovery/load", loadInput(currentItem), 503))
      .result.error.code,
    "source_unavailable",
  );
  assert.equal(
    (
      await call(
        "/internal/skill-discovery/search",
        { organization_id: org, actor_id: owner, query: "review" },
        503,
      )
    ).result.error.code,
    "source_unavailable",
  );
  await sourceState({ unavailable: false, active: false });
  assert.deepEqual((await search()).result.items, []);
  assert.equal(
    (await call("/internal/skill-discovery/load", loadInput(currentItem), 404))
      .result.error.code,
    "not_found",
  );
  await sourceState({ active: true });
  projection = asProjection(await sourceState());
  assert.equal((await update(projection)).result.outcome, "applied");
  checks.push("live-source-refresh-drift-offline-revocation");

  const promote = { request_id: "docker-promote", ...loadInput(currentItem) };
  const published = (
    await call("/internal/skill-projections/promote", promote, 201)
  ).result;
  assert.equal(published.version, 1);
  assert.equal(published.content_digest, currentItem.content_digest);
  assert.equal(await countVersions(), 1);
  assert.deepEqual(
    (await call("/internal/skill-projections/promote", promote, 201)).result,
    published,
  );
  assert.equal(
    (
      await call(
        "/internal/skill-projections/promote",
        { ...promote, expected_digest: oldItem.content_digest },
        409,
      )
    ).result.error.code,
    "request_conflict",
  );
  const origins = Number(
    await docker([
      ...compose,
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "postgres",
      "-d",
      "registry",
      "-At",
      "-c",
      `SELECT count(*) FROM skill_version_sources p JOIN skills s USING(skill_id) WHERE s.organization_id='${org}'`,
    ]),
  );
  assert.equal(origins, 1);
  checks.push("promotion-immutable-package-receipt-and-provenance");

  await docker([...compose, "stop", "--timeout", "10", "source"], true);
  await docker([...compose, "restart", "--timeout", "10", "registry"], true);
  await docker(
    [
      ...compose,
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      "60",
      "--no-deps",
      "--no-build",
      "--pull",
      "never",
      "registry",
    ],
    true,
  );
  const restartedID = await docker([...compose, "ps", "-q", "registry"]);
  const restarted = JSON.parse(await docker(["inspect", restartedID]))[0];
  const restartedBinding = restarted.NetworkSettings.Ports["8080/tcp"][0];
  assert.equal(restartedBinding.HostIp, "127.0.0.1");
  const previousRegistry = registry;
  registry = `http://127.0.0.1:${restartedBinding.HostPort}`;
  save("restart-endpoints.json", { before: previousRegistry, after: registry });
  const formalInput = {
    organization_id: org,
    actor_id: owner,
    skill_ref: { kind: "registry", skill_id: published.skill_id, version: 1 },
    expected_digest: published.content_digest,
  };
  assert.deepEqual(
    (await call("/internal/skill-discovery/load", formalInput)).result,
    skillArtifact(2),
  );
  if (callerAware) {
    const found = await call("/internal/skill-discovery/search", {
      organization_id: org,
      actor_id: owner,
      requesting_agent_id: projection.agent_id,
      query: "review",
      limit: 1,
    });
    assert.equal(found.result.items.length, 1);
    assert.deepEqual(found.result.items[0].skill_ref, formalInput.skill_ref);
    assert.equal(
      found.result.items[0].content_digest,
      published.content_digest,
    );
    assert.equal(
      (await search(owner, org, 503)).result.error.code,
      "source_unavailable",
    );
    checks.push(
      "caller-exclusion-before-limit-keeps-formal-search-with-source-offline",
    );
  }
  assert.deepEqual(
    (await call("/internal/skill-projections/promote", promote, 201)).result,
    published,
  );
  assert.equal(
    (
      await call(
        "/internal/skill-projections/promote",
        { ...promote, request_id: "new-offline-promote" },
        503,
      )
    ).result.error.code,
    "source_unavailable",
  );
  assert.equal(await countVersions(), 1);
  assert.equal(
    (await update({ ...projection, active: false, sequence: 3 })).result
      .outcome,
    "applied",
  );
  assert.equal((await update(projection)).result.outcome, "superseded");
  assert.deepEqual(
    (await call("/internal/skill-projections/promote", promote, 201)).result,
    published,
  );
  assert.deepEqual(
    (await search()).result.items.map((item) => item.skill_ref.kind),
    ["registry"],
  );
  assert.equal(
    (
      await call(
        "/internal/skill-discovery/load",
        { ...formalInput, organization_id: `org_${"e".repeat(32)}` },
        404,
      )
    ).result.error.code,
    "not_found",
  );
  checks.push("restart-and-source-removal-independent-formal-lifecycle");

  const badBody = await fetch(registry + "/internal/skill-projections", {
    method: "PUT",
    headers: {
      ...credentialHeaders("agent-acp-service"),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ...projection, active: null }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(badBody.status, 400);
  save("result.json", {
    project,
    image,
    checks,
    authentication_checks: authentication.count,
    source:
      "explicit deterministic HTTP fixture; actual ACP source integration is a separate gate",
    scope: traceBatch
      ? "Registry D1T producer; real ACP/Runtime/Jaeger source Trace integration is DI3"
      : "Registry producer only; no dual-Agent, Runtime temporary files, UI or Template/rebuild integration claim",
  });
  console.log(JSON.stringify({ project, stage: "passed", checks }));
} catch (error) {
  primaryError = error;
  process.exitCode = 1;
  save("failure.json", {
    project,
    error: String(error),
    stack: error.stack,
    cause: error.cause ? String(error.cause) : undefined,
    checks,
  });
  console.error(String(error));
} finally {
  const cleanup = dockerClient(env, undefined, 240000);
  let cleanupError;
  try {
    try {
      const logs = await cleanup([...compose, "logs", "--no-color"]);
      writeFileSync(resolve(output, "containers.log"), logs, { mode: 0o600 });
    } catch {
      /* A failed build may have no containers. */
    }
    await cleanup(
      [...compose, "down", "--volumes", "--remove-orphans", "--timeout", "15"],
      true,
    );
    if (built) await cleanup(["image", "rm", image]);
    const after = await inventory(cleanup);
    if (baseline)
      assert.deepEqual(
        after,
        baseline,
        "Disposable resources differ from baseline",
      );
    save("cleanup.json", { project, after, matches_baseline: true });
  } catch (error) {
    cleanupError = error;
    save("cleanup-failure.json", { project, error: String(error) });
  }
  rmSync(authDirectory, { recursive: true, force: true });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.removeListener(signal, stop);
  if (cleanupError) {
    console.error(String(cleanupError));
    process.exitCode = 1;
  }
  if (!primaryError && !cleanupError)
    console.log(JSON.stringify({ project, stage: "cleaned", output }));
}
