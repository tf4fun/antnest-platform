import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dockerClient } from "../../lifecycle-closeout/docker.mjs";
import { gatewaySessionCookies } from "../../../support/gateway-session-cookies.mjs";
import { browserSessionChecks } from "./browser-sessions.mjs";
import {
  passwordFailures,
  assertPasswordCaseCounts,
} from "./password-admission.mjs";
import {
  admissionConfiguration,
  assertAdmissionSources,
  loginAdmissionChecks,
  requestAdmission,
} from "./login-admission.mjs";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const project = `antnest-gateway-auth-${randomUUID()}`;
const evidence = resolve(
  root,
  "artifacts/verification/gateway-authentication",
  project,
);
const credentials = resolve(evidence, "credentials");
const outgoing = resolve(credentials, "outgoing");
mkdirSync(outgoing, { recursive: true, mode: 0o700 });
const ports = {
  "identity-service": 8101,
  "admin-console": 8102,
  "agent-ui": 8103,
  "agent-controller": 8104,
  "agent-acp-service": 8105,
};
const tokens = Object.fromEntries(
  Object.keys(ports).map((name) => [
    name,
    randomBytes(32).toString("base64url"),
  ]),
);
const next = randomBytes(32).toString("base64url");
const hashes = Object.fromEntries(
  Object.entries(tokens).map(([name, token]) => [
    name,
    [createHash("sha256").update(token).digest("hex")],
  ]),
);
hashes["admin-console"].push(createHash("sha256").update(next).digest("hex"));
const fixture = {
  passwordFailures: passwordFailures.map(
    ({ name, status, body, retry, mixedSuccess }) => ({
      name,
      status,
      body,
      retry,
      mixedSuccess,
    }),
  ),
  ports,
  hashes,
  password: randomBytes(24).toString("base64url"),
  access: randomBytes(32).toString("base64url"),
  scim: randomBytes(32).toString("base64url"),
};
const { privateKey } = generateKeyPairSync("ed25519");
writeFileSync(
  resolve(credentials, "issuer.pem"),
  privateKey.export({ format: "pem", type: "pkcs8" }),
  { mode: 0o600 },
);
writeFileSync(resolve(credentials, "fixture.json"), JSON.stringify(fixture), {
  mode: 0o600,
});
writeFileSync(resolve(credentials, "callers.json"), "{}", { mode: 0o600 });
writeFileSync(resolve(credentials, "csrf.key"), randomBytes(32), {
  mode: 0o600,
});
for (const [name, token] of Object.entries(tokens))
  writeFileSync(resolve(outgoing, name), token, { mode: 0o600 });
assert(process.getuid() > 0, "use a nonroot user for this disposable fixture");
const env = {
  ...process.env,
  GATEWAY_TEST_UID: String(process.getuid()),
  GATEWAY_TEST_GID: String(process.getgid()),
  GATEWAY_TEST_AUTH_DIRECTORY: credentials,
};
const compose = [
  "compose",
  "--env-file",
  "/dev/null",
  "--project-name",
  project,
  "-f",
  resolve(root, "tests/e2e/service-authentication/gateway/compose.yaml"),
];
const controller = new AbortController();
const stop = () => controller.abort();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
const timer = setTimeout(stop, 600000);
const docker = dockerClient(env, controller.signal, 600000);
const recordEvidence = (name, value) =>
  writeFileSync(
    resolve(evidence, name),
    JSON.stringify(value, null, 2) + "\n",
    { mode: 0o600 },
  );
const readPasswordEvidence = async () =>
  JSON.parse(
    await docker([
      ...compose,
      "exec",
      "-T",
      "dependencies",
      "node",
      "--input-type=module",
      "-e",
      "import {readFileSync} from 'node:fs'; const token=readFileSync('/run/auth/outgoing/identity-service','utf8'); const r=await fetch('http://127.0.0.1:8101/__fixture/password-evidence',{headers:{'Antnest-Service-Authorization':'Bearer '+token},signal:AbortSignal.timeout(5000)}); if(!r.ok) throw Error('evidence unavailable'); console.log(JSON.stringify(await r.json()));",
    ]),
  );
let complete = false,
  cleaned = false,
  checks = 0;
try {
  await docker(
    [...compose, "up", "-d", "--build", "--wait", "--wait-timeout", "120"],
    true,
  );
  const id = await docker([...compose, "ps", "-q", "edge-gateway"]);
  const [gateway] = JSON.parse(await docker(["inspect", id]));
  const binding = gateway.NetworkSettings.Ports["8080/tcp"][0];
  assert.equal(binding.HostIp, "127.0.0.1");
  const url = `http://127.0.0.1:${binding.HostPort}`;
  const publicOrigin = "http://127.0.0.1";
  const userAgentHint = "Gateway Docker <plain-text> session A";
  const forged = {
    "Antnest-Service-Authorization": "Bearer browser-forgery",
    "Antnest-Caller-Context": "browser-forgery",
    "X-Antnest-Future-Privilege": "admin",
    "X-Antnest-Organization-ID": "forged",
    "X-Antnest-Principal-ID": "forged",
    "X-Antnest-Agent-ID": "forged",
  };
  const login = await fetch(`${url}/api/session/login`, {
    method: "POST",
    headers: {
      ...forged,
      "content-type": "application/json",
      Origin: publicOrigin,
      "User-Agent": userAgentHint,
    },
    body: JSON.stringify({
      organization_slug: "auth-test",
      email: "admin@example.test",
      password: fixture.password,
    }),
    signal: controller.signal,
  });
  assert.equal(login.status, 200);
  checks++;
  const cookies = login.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
  const { csrf, sessionName } = gatewaySessionCookies(
    login.headers.getSetCookie(),
  );
  assert.equal(sessionName, "__Host-antnest_session");
  assert(csrf, "bound CSRF delivery missing");
  const loginBody = await login.json();
  assert(!JSON.stringify(loginBody).includes(fixture.access));
  assert(!JSON.stringify(loginBody).includes("caller_context"));
  checks++;
  const request = async (
    path,
    {
      status = 200,
      method = "GET",
      anonymous = false,
      headers = {},
      body,
    } = {},
  ) => {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: {
        ...forged,
        ...(anonymous ? {} : { cookie: cookies }),
        Origin: publicOrigin,
        ...headers,
      },
      ...(body === undefined ? {} : { body }),
      signal: controller.signal,
      redirect: "error",
    });
    assert.equal(response.status, status, `${method} ${path}`);
    checks++;
    assert.equal(response.headers.get("Antnest-Service-Authorization"), null);
    assert.equal(response.headers.get("Antnest-Caller-Context"), null);
    assert.equal(response.headers.getSetCookie().length, 0);
    checks++;
    const value = await response.json();
    assert(!JSON.stringify(value).includes(fixture.access));
    assert(!JSON.stringify(value).includes("caller_context"));
    return value;
  };
  await request("/api/session");
  for (const [path, audience, agent] of [
    ["/api/admin/agents", "admin-console", null],
    ["/api/admin/agents/agent-1", "admin-console", "agent-1"],
    ["/api/app/workspace/v1/bootstrap", "agent-ui", null],
    [
      "/api/app/workspace/v1/agents/agent-1/configuration",
      "agent-ui",
      "agent-1",
    ],
    ["/workspace/agent-1/", "agent-ui", null],
    ["/api/app/agents/agent-1/v1/acp", "agent-acp-service", "agent-1"],
  ]) {
    const value = await request(path);
    assert(value.audience.includes(audience));
    assert.equal(value.agent, agent);
    assert.equal(value.subject, "user-admin");
    checks++;
    if (path.endsWith("/v1/acp")) {
      assert.deepEqual(value.audience, ["agent-acp-service"]);
      checks++;
    }
  }
  await request("/api/app/bootstrap");
  const state = await request("/api/app/agents/agent-1/state");
  assert.equal(state.agent_id, "agent-1");
  assert.equal(state.access_allowed, true);
  checks++;
  await request("/", { anonymous: true });
  await request("/workspace/assets/app.js", { anonymous: true });
  await request("/scim/v2/Users", {
    anonymous: true,
    headers: { authorization: `Bearer ${fixture.scim}` },
  });
  await request("/api/admin/agents", {
    method: "POST",
    headers: {
      "X-Antnest-CSRF-Token": csrf,
      "content-type": "application/json",
    },
    body: "{}",
  });
  await request("/api/admin/agents", {
    method: "POST",
    status: 403,
    headers: { "X-Antnest-CSRF-Token": `${csrf}, ${csrf}` },
    body: "{}",
  });
  await request("/api/admin/agents", { anonymous: true, status: 401 });
  const precondition = encodeURIComponent(
    JSON.stringify(["organization-1", "user-admin"]),
  );
  await request("/api/admin/agents/agent-1/network-policy", {
    method: "PUT",
    headers: {
      "X-Antnest-CSRF-Token": csrf,
      "X-Antnest-Expected-Principal": precondition,
      "content-type": "application/json",
    },
    body: "{}",
  });
  for (const value of [
    undefined,
    encodeURIComponent(JSON.stringify(["organization-old", "user-admin"])),
    precondition + ", " + precondition,
  ])
    await request("/api/admin/agents/agent-1/network-policy", {
      method: "PUT",
      status: 409,
      headers: {
        "X-Antnest-CSRF-Token": csrf,
        ...(value ? { "X-Antnest-Expected-Principal": value } : {}),
        "content-type": "application/json",
      },
      body: "{}",
    });
  await request("/api/admin/agents", {
    headers: { "X-Antnest-Expected-Principal": precondition },
  });
  const consoleFile = resolve(outgoing, "admin-console");
  writeFileSync(consoleFile + ".next", next, { mode: 0o600 });
  renameSync(consoleFile + ".next", consoleFile);
  await request("/api/admin/agents");
  writeFileSync(consoleFile, next + "\n", { mode: 0o600 });
  await request("/api/admin/agents", { status: 503 });
  rmSync(consoleFile);
  await request("/api/admin/agents", { status: 503 });
  writeFileSync(consoleFile, next, { mode: 0o600 });
  await request("/api/admin/agents");
  checks += await browserSessionChecks({
    readPasswordEvidence,
    recordEvidence,
    url,
    origin: publicOrigin,
    fixture,
    signal: controller.signal,
    initial: {
      cookie: cookies,
      csrf,
      metadata: loginBody,
      hint: userAgentHint,
    },
  });
  await docker([
    "exec",
    "--env",
    "HTTP_PROXY=http://127.0.0.1:9",
    "--env",
    "HTTPS_PROXY=http://127.0.0.1:9",
    id,
    "/usr/local/bin/edge-gateway",
    "--healthcheck",
  ]);
  checks++;
  await assert.rejects(
    docker([
      "exec",
      "--env",
      "ANTNEST_EDGE_LISTEN=127.0.0.1:8080",
      id,
      "/usr/local/bin/edge-gateway",
      "--healthcheck",
    ]),
  );
  checks++;
  await docker(["stop", "--time", "10", id], true);
  const [stopped] = JSON.parse(await docker(["inspect", id]));
  assert.equal(stopped.Config.Labels["com.docker.compose.project"], project);
  assert.equal(stopped.State.ExitCode, 0);
  const passwordEvidence = await readPasswordEvidence();
  assertPasswordCaseCounts(passwordEvidence);
  recordEvidence("password-admission-after-stop.json", passwordEvidence);
  checks++;
  // Recreate only Gateway with small explicit limits. This isolates the new
  // fixed windows from the preceding browser/password regression matrix.
  const admissionEnv = {
    ...env,
    GATEWAY_TEST_LOGIN_WINDOW: admissionConfiguration.ANTNEST_EDGE_LOGIN_WINDOW,
    GATEWAY_TEST_LOGIN_SOURCE_MAX:
      admissionConfiguration.ANTNEST_EDGE_LOGIN_SOURCE_MAX,
    GATEWAY_TEST_LOGIN_ACCOUNT_MAX:
      admissionConfiguration.ANTNEST_EDGE_LOGIN_ACCOUNT_MAX,
    GATEWAY_TEST_LOGIN_MAX_KEYS:
      admissionConfiguration.ANTNEST_EDGE_LOGIN_MAX_KEYS,
    GATEWAY_TEST_OIDC_START_SOURCE_MAX:
      admissionConfiguration.ANTNEST_EDGE_OIDC_START_SOURCE_MAX,
  };
  await docker(
    [
      ...compose,
      "up",
      "-d",
      "--no-build",
      "--no-deps",
      "--force-recreate",
      "--wait",
      "--wait-timeout",
      "120",
      "edge-gateway",
    ],
    true,
    { env: admissionEnv },
  );
  const admissionID = await docker([...compose, "ps", "-q", "edge-gateway"]);
  const dependenciesID = await docker([...compose, "ps", "-q", "dependencies"]);
  const [admissionGateway, dependencies] = JSON.parse(
    await docker(["inspect", admissionID, dependenciesID]),
  );
  assert.equal(
    admissionGateway.Image,
    gateway.Image,
    "same built candidate required",
  );
  assert.notEqual(admissionID, dependenciesID);
  const actualConfiguration = Object.fromEntries(
    admissionGateway.Config.Env.map((entry) => {
      const split = entry.indexOf("=");
      return [entry.slice(0, split), entry.slice(split + 1)];
    }),
  );
  for (const [key, value] of Object.entries(admissionConfiguration))
    assert.equal(actualConfiguration[key], value, key + " was not applied");
  const network = Object.keys(admissionGateway.NetworkSettings.Networks);
  assert.equal(network.length, 1);
  const sourceB = dependencies.NetworkSettings.Networks[network[0]]?.IPAddress;
  assert(sourceB, "dependency client must share the Gateway network");
  const admissionBinding =
    admissionGateway.NetworkSettings.Ports["8080/tcp"][0];
  assert.equal(admissionBinding.HostIp, "127.0.0.1");
  const admissionURL = `http://127.0.0.1:${admissionBinding.HostPort}`;
  const readAdmissionEvidence = async () =>
    JSON.parse(
      await docker([
        ...compose,
        "exec",
        "-T",
        "dependencies",
        "node",
        "--input-type=module",
        "-e",
        "import {readFileSync} from 'node:fs'; const token=readFileSync('/run/auth/outgoing/identity-service','utf8'); const r=await fetch('http://127.0.0.1:8101/__fixture/login-admission-evidence',{headers:{'Antnest-Service-Authorization':'Bearer '+token},signal:AbortSignal.timeout(5000)}); if(!r.ok) throw Error('admission evidence unavailable'); console.log(JSON.stringify(await r.json()));",
      ]),
    );
  const admission = await loginAdmissionChecks({
    request: async (source, flow, body) => {
      if (source === "A")
        return requestAdmission({
          url: admissionURL,
          origin: publicOrigin,
          flow,
          body,
          signal: controller.signal,
        });
      assert.equal(source, "B");
      return JSON.parse(
        await docker([
          ...compose,
          "exec",
          "-T",
          "dependencies",
          "node",
          "/fixture/login-admission.mjs",
          JSON.stringify({
            url: "http://edge-gateway:8080",
            origin: publicOrigin,
            flow,
            body,
          }),
        ]),
      );
    },
    readEvidence: readAdmissionEvidence,
    recordEvidence,
  });
  checks += admission.checks;
  await docker(["stop", "--time", "10", admissionID], true);
  const [admissionStopped] = JSON.parse(await docker(["inspect", admissionID]));
  assert.equal(admissionStopped.State.ExitCode, 0);
  assert.deepEqual(
    await readAdmissionEvidence(),
    admission.final,
    "late admission RPC",
  );
  assertPasswordCaseCounts(await readPasswordEvidence());
  const logs = await docker(["logs", admissionID]);
  writeFileSync(
    resolve(evidence, "login-admission-runtime.private.log"),
    logs,
    { mode: 0o600 },
  );
  const events = logs.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    const row = JSON.parse(line);
    if (
      ![
        "Edge Gateway request completed",
        "Edge Gateway request failed",
      ].includes(row.msg)
    )
      return [];
    return [row];
  });
  const sources = assertAdmissionSources(events, sourceB);
  recordEvidence("login-admission-container.json", {
    configuration: admissionConfiguration,
    image: admissionGateway.Image,
    gatewayContainer: admissionID,
    clientBContainer: dependenciesID,
    sources,
    checks: admission.checks,
    timing: admission.timing,
    afterStop: admission.final,
    gatewayExitCode: admissionStopped.State.ExitCode,
    boundary:
      "Gateway image with authenticated Identity double; real signed SSO is a separate integration gate",
  });
  checks++;
  complete = true;
} finally {
  clearTimeout(timer);
  controller.abort();
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  const cleanup = dockerClient(env, undefined, 120000);
  try {
    await cleanup([...compose, "down", "--volumes", "--remove-orphans"], true);
    assert.equal(
      await cleanup([
        "ps",
        "-aq",
        "--filter",
        `label=com.docker.compose.project=${project}`,
      ]),
      "",
    );
    // Only remove the unique image built by this disposable project.
    const image = `${project}-edge-gateway:latest`;
    if (
      await cleanup(["image", "ls", "-q", "--filter", `reference=${image}`])
    ) {
      const [candidate] = JSON.parse(
        await cleanup(["image", "inspect", image]),
      );
      assert.equal(
        candidate.Config.Labels["com.docker.compose.project"],
        project,
      );
      assert.equal(
        candidate.Config.Labels["com.docker.compose.service"],
        "edge-gateway",
      );
      assert.equal(
        await cleanup(["ps", "-aq", "--filter", `ancestor=${image}`]),
        "",
      );
      await cleanup(["image", "rm", image]);
    }
    cleaned = true;
  } finally {
    rmSync(credentials, { recursive: true, force: true });
    writeFileSync(
      resolve(evidence, "result.json"),
      JSON.stringify({ project, complete, cleaned, checks }) + "\n",
      { mode: 0o600 },
    );
  }
}
console.log(JSON.stringify({ project, complete, cleaned, checks }));
