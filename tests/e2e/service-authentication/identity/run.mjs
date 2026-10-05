import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  createPublicKey,
  verify,
} from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { dockerClient } from "../../lifecycle-closeout/docker.mjs";
import { assertJsonRpcContentTypeRejection } from "../../../support/json-rpc-security.mjs";
import { runCommand } from "../../../support/run-command.mjs";
import { rotateIdentityFixture } from "./rekey-flow.mjs";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const project = `antnest-identity-auth-${randomUUID()}`;
const evidence = resolve(
  root,
  "artifacts/verification/identity-authentication",
  project,
);
const credentials = resolve(evidence, "credentials");
mkdirSync(credentials, { recursive: true, mode: 0o700 });
const tokens = Object.fromEntries(
  [
    "edge-gateway",
    "admin-console",
    "agent-controller",
    "runtime-controller",
  ].map((name) => [name, randomBytes(32).toString("base64url")]),
);
const hashes = Object.fromEntries(
  Object.entries(tokens).map(([name, token]) => [
    name,
    [`sha256:${createHash("sha256").update(token).digest("hex")}`],
  ]),
);
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const jwks = {
  keys: [
    {
      ...publicKey.export({ format: "jwk" }),
      kid: "current",
      use: "sig",
      alg: "EdDSA",
    },
  ],
};
writeFileSync(resolve(credentials, "callers.json"), JSON.stringify(hashes), {
  mode: 0o600,
});
writeFileSync(
  resolve(credentials, "cct.pem"),
  privateKey.export({ format: "pem", type: "pkcs8" }),
  { mode: 0o600 },
);
writeFileSync(resolve(credentials, "jwks.json"), JSON.stringify(jwks), {
  mode: 0o600,
});
assert(process.getuid() > 0, "run this disposable fixture as a nonroot user");
const env = {
  ...process.env,
  IDENTITY_TEST_UID: String(process.getuid()),
  IDENTITY_TEST_GID: String(process.getgid()),
  IDENTITY_TEST_DATABASE_PASSWORD: randomBytes(32).toString("hex"),
  IDENTITY_TEST_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  IDENTITY_TEST_ADMIN_PASSWORD: randomBytes(24).toString("base64url"),
  IDENTITY_TEST_AUTH_DIRECTORY: credentials,
};
const compose = [
  "compose",
  "--env-file",
  "/dev/null",
  "--project-name",
  project,
  "-f",
  resolve(root, "tests/e2e/service-authentication/identity/compose.yaml"),
];
const controller = new AbortController();
const stop = () => controller.abort();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
const timer = setTimeout(stop, 600000);
const docker = dockerClient(env, controller.signal, 600000);
let checks = 0,
  complete = false,
  cleaned = false,
  stage = "starting";
try {
  await docker(
    [...compose, "up", "-d", "--build", "--wait", "--wait-timeout", "120"],
    true,
  );
  stage = "authentication";
  const id = await docker([...compose, "ps", "-q", "identity-service"]);
  const [identity] = JSON.parse(await docker(["inspect", id]));
  const binding = identity.NetworkSettings.Ports["8080/tcp"][0];
  assert.equal(binding.HostIp, "127.0.0.1");
  const port = binding.HostPort;
  let url = `http://127.0.0.1:${port}`;
  const rpc = async (
    path,
    body,
    { caller = "edge-gateway", cct, status = 200 } = {},
  ) => {
    const headers = { "content-type": "application/json" };
    if (caller)
      headers["Antnest-Service-Authorization"] = `Bearer ${tokens[caller]}`;
    if (cct) headers["Antnest-Caller-Context"] = cct;
    const response = await fetch(`${url}/rpc/identity/${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: "error",
    });
    assert.equal(response.status, status, `unexpected status on ${path}`);
    checks++;
    const result = await response.json();
    if (status !== 200) assert.equal(result.retryable, false);
    return result;
  };
  const login = await rpc("local-login", {
    request_id: randomUUID(),
    organization_slug: "auth-test",
    email: "admin@example.test",
    password: env.IDENTITY_TEST_ADMIN_PASSWORD,
  });
  const resolved = await rpc("resolve-access-token", {
    access_token: login.access_token,
    profile: "console",
  });
  assert.deepEqual(resolved.principal, login.principal);
  const [header, claims, signature] = resolved.caller_context.split(".");
  assert(
    verify(
      null,
      Buffer.from(`${header}.${claims}`),
      createPublicKey({ key: jwks.keys[0], format: "jwk" }),
      Buffer.from(signature, "base64url"),
    ),
  );
  const context = JSON.parse(Buffer.from(claims, "base64url"));
  assert.equal(context.sid, login.token_id);
  assert.equal(context.sub, login.principal.user_id);
  assert.equal(context.exp - context.iat, 60);
  const contract = JSON.parse(
    readFileSync(
      resolve(root, "contracts/identity/identity-contract.json"),
      "utf8",
    ),
  );
  for (const method of Object.values(contract.methods)) {
    if (!method.request.properties.actor_principal_id) continue;
    const body = {
      actor_principal_id: login.principal.user_id,
      organization_id: login.principal.organization_id,
    };
    const rejected = await rpc(method.path.slice(1), body, {
      caller: "admin-console",
      status: 401,
    });
    assert.equal(rejected.code, "caller_context_required");
  }
  const body = {
    actor_principal_id: login.principal.user_id,
    organization_id: login.principal.organization_id,
  };
  await rpc("list-directory", body, { caller: null, status: 401 });
  await rpc("list-directory", body, {
    caller: "runtime-controller",
    cct: resolved.caller_context,
    status: 403,
  });
  await rpc(
    "list-directory",
    { ...body, actor_principal_id: "forged-admin" },
    { caller: "admin-console", cct: resolved.caller_context, status: 403 },
  );
  await rpc(
    "list-directory",
    { ...body, organization_id: "another-organization" },
    { caller: "admin-console", cct: resolved.caller_context, status: 401 },
  );
  await rpc("list-directory", body, {
    caller: "admin-console",
    cct: "forged-context",
    status: 401,
  });
  await rpc("list-directory", body, {
    caller: "admin-console",
    cct: resolved.caller_context,
  });
  checks += await assertJsonRpcContentTypeRejection({
    url: `${url}/rpc/identity/list-directory`,
    headers: {
      "Antnest-Service-Authorization": `Bearer ${tokens["admin-console"]}`,
      "Antnest-Caller-Context": resolved.caller_context,
    },
    signal: controller.signal,
  });
  for (const caller of [
    null,
    "edge-gateway",
    "admin-console",
    "runtime-controller",
  ]) {
    const response = await fetch(`${url}/rpc/identity/jwks`, {
      headers: caller
        ? { "Antnest-Service-Authorization": `Bearer ${tokens[caller]}` }
        : {},
      signal: controller.signal,
    });
    assert.equal(
      response.status,
      caller === null ? 401 : caller === "runtime-controller" ? 403 : 200,
    );
    checks++;
    if (response.ok) {
      assert.deepEqual(await response.json(), jwks);
      assert.equal(response.headers.get("cache-control"), "no-store");
    } else await response.body.cancel();
  }
  const workspace = await rpc("resolve-access-token", {
    access_token: login.access_token,
    profile: "workspace",
  });
  await rpc("list-directory", body, {
    caller: "admin-console",
    cct: workspace.caller_context,
    status: 401,
  });
  await rpc("revoke-access-token", { access_token: login.access_token });
  await rpc("list-directory", body, {
    caller: "admin-console",
    cct: resolved.caller_context,
    status: 401,
  });
  const counters = await docker([
    ...compose,
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "antnest_identity",
    "-d",
    "identity_auth_test",
    "-tA",
    "-c",
    "SELECT (SELECT count(*) FROM users), (SELECT count(*) FROM scim_tokens), (SELECT count(*) FROM oidc_providers)",
  ]);
  assert.equal(
    counters,
    "1|0|0",
    "rejected administrative calls changed business facts",
  );
  checks++;

  // A second instance binds only its own Docker address, not loopback. An
  // unreachable environment proxy must not replace the actual health target.
  stage = "purpose-health";
  const networks = Object.keys(identity.NetworkSettings.Networks);
  assert.equal(networks.length, 1);
  const [network] = JSON.parse(
    await docker(["network", "inspect", networks[0]]),
  );
  assert.equal(network.Labels["com.docker.compose.project"], project);
  const healthName = `${project}-purpose-health`;
  await docker([
    "create",
    "--name",
    healthName,
    "--label",
    `com.docker.compose.project=${project}`,
    "--label",
    "com.docker.compose.service=purpose-health",
    "--network",
    networks[0],
    "--network-alias",
    "purpose-health",
    "--user",
    identity.Config.User,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--mount",
    `type=bind,source=${credentials},target=/run/auth,readonly`,
    ...identity.Config.Env.filter(
      (value) =>
        !/^(ANTNEST_IDENTITY_LISTEN|HTTP_PROXY|HTTPS_PROXY|http_proxy|https_proxy)=/u.test(
          value,
        ),
    ).flatMap((value) => ["--env", value]),
    "--env",
    "ANTNEST_IDENTITY_LISTEN=purpose-health:8080",
    "--env",
    "HTTP_PROXY=http://127.0.0.1:9",
    "--env",
    "HTTPS_PROXY=http://127.0.0.1:9",
    identity.Config.Image,
  ]);
  await docker(["start", healthName]);
  const deadline = Date.now() + 30000;
  let healthy = false;
  while (Date.now() < deadline) {
    try {
      await docker([
        "exec",
        healthName,
        "/usr/local/bin/identity-service",
        "--healthcheck",
      ]);
      healthy = true;
      break;
    } catch {
      controller.signal.throwIfAborted();
      await delay(100);
    }
  }
  assert(healthy, "configured Docker-address health probe never became ready");
  checks++;
  await assert.rejects(
    docker([
      "exec",
      "--env",
      "ANTNEST_IDENTITY_LISTEN=127.0.0.1:8080",
      healthName,
      "/usr/local/bin/identity-service",
      "--healthcheck",
    ]),
  );
  checks++;
  await docker(["stop", "--time", "10", healthName], true);
  const [stopped] = JSON.parse(await docker(["inspect", healthName]));
  assert.equal(stopped.Config.Labels["com.docker.compose.project"], project);
  assert.equal(stopped.State.ExitCode, 0);
  checks++;
  await docker(["rm", healthName]);
  stage = "encryption-key-rotation";
  const rotation = await rotateIdentityFixture({
    env,
    docker,
    compose,
    rebind: (value) => {
      url = value;
    },
    organizationID: login.principal.organization_id,
    login: async () => {
      const fresh = await rpc("local-login", {
        request_id: randomUUID(),
        organization_slug: "auth-test",
        email: "admin@example.test",
        password: env.IDENTITY_TEST_ADMIN_PASSWORD,
      });
      assert.deepEqual(fresh.principal, login.principal);
    },
  });
  writeFileSync(resolve(evidence, "rotation.json"), JSON.stringify(rotation), {
    mode: 0o600,
  });
  complete = true;
} catch (error) {
  // Preserve only this disposable project's diagnostics before removing it.
  // Never capture the complete container environment or print private logs.
  const diagnostics = dockerClient(env, undefined, 30000);
  try {
    const ids = (
      await diagnostics([
        "ps",
        "-aq",
        "--filter",
        `label=com.docker.compose.project=${project}`,
      ])
    )
      .split(/\s+/u)
      .filter(Boolean);
    for (const id of ids) {
      const [row] = JSON.parse(await diagnostics(["inspect", id]));
      assert.equal(row.Config.Labels["com.docker.compose.project"], project);
      const service = row.Config.Labels["com.docker.compose.service"];
      assert(
        ["identity-service", "postgres", "purpose-health"].includes(service),
      );
      writeFileSync(
        resolve(evidence, `${service}.state.json`),
        JSON.stringify({
          status: row.State.Status,
          exit_code: row.State.ExitCode,
          health: row.State.Health,
        }),
        { flag: "wx", mode: 0o600 },
      );
      await runCommand({
        command: ["docker", "logs", id],
        name: `${service}-container`,
        output: evidence,
        env,
        cwd: root,
        timeoutMs: 10000,
        graceMs: 5000,
      });
    }
  } catch {
    writeFileSync(
      resolve(evidence, "diagnostics-unavailable.json"),
      JSON.stringify({ stage }),
      { flag: "wx", mode: 0o600 },
    );
  }
  throw error;
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
    cleaned = true;
  } finally {
    rmSync(credentials, { recursive: true, force: true });
    writeFileSync(
      resolve(evidence, "result.json"),
      JSON.stringify({ project, stage, complete, cleaned, checks }) + "\n",
      { mode: 0o600 },
    );
  }
}
console.log(JSON.stringify({ project, complete, cleaned, checks }));
