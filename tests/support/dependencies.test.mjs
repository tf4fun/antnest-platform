import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dependencyPlan, withDependencies } from "./dependencies.mjs";

test("dependency plans explicitly select loopback diagnostics", () => {
  for (const profile of ["postgres", "temporal"]) {
    const plan = dependencyPlan(profile, {});
    const files = plan.compose.flatMap((arg, index, args) =>
      arg === "-f" ? [args[index + 1]] : [],
    );
    assert.equal(files.length, 3);
    assert(files[0].endsWith("/compose.yaml"));
    assert(files[1].endsWith("/compose.debug.yaml"));
    assert(files[2].endsWith("/tests/support/compose.dependencies.yaml"));
    assert.deepEqual(
      plan.services,
      profile === "postgres"
        ? ["postgres", "diagnostic-relay"]
        : ["postgres", "temporal", "diagnostic-relay"],
    );
  }
});

test("dependency plans isolate projects and override retained ports and credentials", () => {
  const plan = dependencyPlan("temporal", {
    COMPOSE_PROJECT_NAME: "retained",
    ANTNEST_POSTGRES_HOST_PORT: "55432",
    ANTNEST_POSTGRES_ADMIN_PASSWORD: "private-canary",
    ANTNEST_SERVICE_AUTH_DIRECTORY: "/retained-private-credentials",
    ANTNEST_SERVICE_AUTH_UID: "1000",
    ANTNEST_SERVICE_AUTH_GID: "1000",
    ANTNEST_IDENTITY_CCT_SIGNING_KID: "retained-kid",
    ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KEY: "retained-key",
    ANTNEST_SERVICE_NETWORK_PREFIX: "10.241.0",
    OTEL_SDK_DISABLED: "false",
  });
  assert.match(plan.project, /^antnest-dependencies-[a-f0-9-]+$/);
  assert.equal(plan.env.ANTNEST_POSTGRES_HOST_PORT, "0");
  assert.equal(plan.env.ANTNEST_TEMPORAL_HOST_PORT, "0");
  assert.equal(plan.env.ANTNEST_POSTGRES_ADMIN_PASSWORD, "integration-admin");
  assert.deepEqual(plan.services, ["postgres", "temporal", "diagnostic-relay"]);
  assert.equal(
    plan.env.ANTNEST_SERVICE_AUTH_DIRECTORY,
    "/never-mounted-dependency-credentials",
  );
  assert.equal(plan.env.ANTNEST_SERVICE_AUTH_UID, "65532");
  assert.equal(plan.env.ANTNEST_SERVICE_AUTH_GID, "65532");
  assert.equal(plan.env.ANTNEST_IDENTITY_CCT_SIGNING_KID, "dependency-unused");
  assert.equal(plan.env.ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KEY, undefined);
  assert.equal(plan.env.ANTNEST_SERVICE_NETWORK_PREFIX, undefined);
  assert.equal(plan.env.OTEL_SDK_DISABLED, undefined);
  assert(plan.compose.includes("/dev/null"));
  assert(plan.compose.includes(plan.project));
});
test("Postgres plans omit Temporal and reject unknown profiles", () => {
  assert.deepEqual(dependencyPlan("postgres", {}).services, [
    "postgres",
    "diagnostic-relay",
  ]);
  assert.throws(() => dependencyPlan("retained", {}));
});
test("dependency children use explicit cwd and the disposable ACP database instead of inherited input", async (t) => {
  const output = mkdtempSync(join(tmpdir(), "antnest-dependency-proxy-"));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const previous = process.env.TEST_POSTGRES_URL;
  process.env.TEST_POSTGRES_URL = "postgres://wrong-host/retained-do-not-use";
  t.after(() => {
    if (previous === undefined) delete process.env.TEST_POSTGRES_URL;
    else process.env.TEST_POSTGRES_URL = previous;
  });
  const dockerFactory = () => async (args) => {
    if (args.includes("compose") && args.includes("ps"))
      return "postgres-probe";
    if (args[0] === "inspect")
      return JSON.stringify([
        {
          Config: {
            Labels: { "com.docker.compose.service": "diagnostic-relay" },
          },
          NetworkSettings: {
            Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "15432" }] },
          },
        },
      ]);
    return "";
  };
  const result = await withDependencies({
    profile: "postgres",
    output,
    cwd: output,
    name: "proxy",
    dockerFactory,
    command: [
      process.execPath,
      "-e",
      "const assert=require('node:assert/strict'); assert.equal(process.cwd(),require('node:fs').realpathSync(process.argv[1])); assert.equal(process.env.TEST_POSTGRES_URL,process.env.ANTNEST_ACP_TEST_DATABASE_URL); const u=new URL(process.env.TEST_POSTGRES_URL); assert.equal(u.hostname,'127.0.0.1'); assert.equal(u.port,'15432'); assert.equal(u.pathname,'/antnest_agent_acp_test'); assert.equal(u.username,'antnest_agent_acp')",
      output,
    ],
  });
  assert.equal(
    result.exit_code,
    0,
    readFileSync(join(output, "proxy.log"), "utf8"),
  );
  assert.equal(
    JSON.parse(readFileSync(join(output, "proxy.cleanup.json"))).cleanup,
    true,
  );
});
test("dependency setup and cleanup failures retain both causes and private evidence", async (t) => {
  const output = mkdtempSync(join(tmpdir(), "antnest-dependency-failure-"));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const setup = new TypeError("setup-private"),
    cleanup = new RangeError("cleanup-private");
  const dockerFactory = () => async (args) => {
    throw args.includes("down") ? cleanup : setup;
  };
  await assert.rejects(
    withDependencies({
      profile: "postgres",
      command: [process.execPath, "-e", "process.exit()"],
      output,
      name: "failure",
      dockerFactory,
    }),
    (error) => {
      assert.deepEqual(error.errors, [setup, cleanup]);
      return true;
    },
  );
  const report = JSON.parse(
    readFileSync(join(output, "failure.cleanup.json"), "utf8"),
  );
  assert.equal(report.cleanup, false);
  assert.equal(report.stage, "starting");
  assert.equal(report.primary_error_type, "TypeError");
  assert.equal(report.cleanup_error_type, "RangeError");
  assert(!JSON.stringify(report).includes("private"));
});
test("dependency profiles preserve startup, command and cleanup limits and a discovered network prefix", async (t) => {
  const output = mkdtempSync(join(tmpdir(), "antnest-dependency-timeout-"));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  let startupWait;
  let startedPrefix, cleanupPrefix;
  const dockerFactory = (env) => async (args) => {
    if (args.includes("up")) {
      startupWait = args[args.indexOf("--wait-timeout") + 1];
      startedPrefix = env.ANTNEST_SERVICE_NETWORK_PREFIX;
    }
    if (args.includes("down"))
      cleanupPrefix = env.ANTNEST_SERVICE_NETWORK_PREFIX;
    if (args.includes("compose") && args.includes("ps"))
      return "postgres-probe";
    if (args[0] === "inspect")
      return JSON.stringify([
        {
          Config: {
            Labels: { "com.docker.compose.service": "diagnostic-relay" },
          },
          NetworkSettings: {
            Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "15432" }] },
          },
        },
      ]);
    return "";
  };
  const result = await withDependencies({
    profile: "postgres",
    output,
    name: "timed",
    dockerFactory,
    timeoutMs: 100,
    graceMs: 100,
    startupWaitSeconds: 30,
    command: [process.execPath, "-e", "setTimeout(()=>{},500)"],
  });
  assert.equal(startupWait, "30");
  assert.match(startedPrefix, /^10\.242\.[0-9]{1,3}$/);
  assert.equal(cleanupPrefix, startedPrefix);
  assert.equal(result.exit_code, 124);
  assert.equal(result.complete, false);
  assert.equal(
    JSON.parse(readFileSync(join(output, "timed.cleanup.json"))).cleanup,
    true,
  );
});
