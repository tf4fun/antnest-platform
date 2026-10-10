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
  const csrf = login.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith("antnest_csrf="))
    .split(";")[0]
    .slice("antnest_csrf=".length);
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
