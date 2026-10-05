import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { request as httpRequest } from "node:http";
import { dockerClient } from "../../lifecycle-closeout/docker.mjs";
import { createFixture, callerContext } from "./auth-fixture.mjs";
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const project = "antnest-controller-auth-" + randomUUID();
const evidence = resolve(
  root,
  "artifacts/verification/controller-authentication",
  project,
);
const credentials = resolve(evidence, "credentials");
const providerSecret = randomBytes(32).toString("base64url");
const fixture = createFixture(credentials, providerSecret);
const env = {
  ...process.env,
  CONTROLLER_TEST_AUTH_DIRECTORY: credentials,
  CONTROLLER_TEST_UID: String(process.getuid()),
  CONTROLLER_TEST_GID: String(process.getgid()),
  CONTROLLER_TEST_DATABASE_PASSWORD: randomBytes(32).toString("hex"),
  CONTROLLER_TEST_TEMPORAL_PASSWORD: randomBytes(32).toString("hex"),
  CONTROLLER_TEST_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  CONTROLLER_TEST_PROVIDER_SUBNET:
    "100." +
    (128 + (randomBytes(1)[0] % 128)) +
    "." +
    randomBytes(1)[0] +
    ".0/24",
};
const compose = [
  "compose",
  "--env-file",
  "/dev/null",
  "--project-name",
  project,
  "-f",
  resolve(root, "tests/e2e/service-authentication/controller/compose.yaml"),
];
const abort = new AbortController(),
  stop = () => abort.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const timer = setTimeout(stop, 600000);
const docker = dockerClient(env, abort.signal, 600000);
let checks = 0,
  complete = false,
  cleaned = false;
try {
  await docker(
    [...compose, "up", "-d", "--build", "--wait", "--wait-timeout", "180"],
    true,
  );
  const id = await docker([...compose, "ps", "-q", "agent-controller"]);
  const [container] = JSON.parse(await docker(["inspect", id]));
  const binding = container.NetworkSettings.Ports["8120/tcp"][0];
  assert.equal(binding.HostIp, "127.0.0.1");
  let base = "http://127.0.0.1:" + binding.HostPort;
  const request = async (
    path,
    {
      method = "GET",
      body,
      service = "admin-console",
      context = callerContext(fixture),
      status = 200,
      code,
      headers = {},
    } = {},
  ) => {
    const outgoing = { ...headers };
    if (service !== null)
      outgoing["Antnest-Service-Authorization"] =
        "Bearer " + fixture.incoming[service];
    if (context !== null) outgoing["Antnest-Caller-Context"] = context;
    const response = await fetch(base + path, {
      method,
      body,
      headers: outgoing,
      signal: abort.signal,
    });
    const text = await response.text();
    assert.equal(response.status, status, method + " " + path + ": " + text);
    if (code) assert.equal(JSON.parse(text).code, code);
    for (const secret of [
      providerSecret,
      ...Object.values(fixture.incoming),
      ...Object.values(fixture.tokens),
      fixture.runtimeAuthority.token,
      context,
    ].filter(Boolean))
      assert(!text.includes(secret), "response leaked private credential");
    assert.equal(response.headers.get("Antnest-Caller-Context"), null);
    checks++;
    return {
      response,
      text,
      json:
        text &&
        response.headers.get("content-type")?.includes("application/json")
          ? JSON.parse(text)
          : null,
    };
  };
  const path = "/internal/agents?organization_id=org-1";
  await request("/status", { service: null, context: null });
  await docker([
    "exec",
    "--env",
    "HTTP_PROXY=http://127.0.0.1:9",
    "--env",
    "HTTPS_PROXY=http://127.0.0.1:9",
    "--env",
    "ANTNEST_TLS_CA_FILE=",
    id,
    "/usr/local/bin/agent-controller",
    "--healthcheck",
  ]);
  checks++;
  await assert.rejects(
    docker([
      "exec",
      "--env",
      "ANTNEST_AGENT_CONTROLLER_LISTEN=127.0.0.1:8120",
      id,
      "/usr/local/bin/agent-controller",
      "--healthcheck",
    ]),
  );
  checks++;
  const providerNetwork = `${project}_provider`;
  const [network] = JSON.parse(
    await docker(["network", "inspect", providerNetwork]),
  );
  assert.equal(network.Labels["com.docker.compose.project"], project);
  const providerAddress =
    container.NetworkSettings.Networks[providerNetwork].IPAddress;
  const providerID = await docker([...compose, "ps", "-q", "provider"]);
  await docker([
    "exec",
    providerID,
    "node",
    "-e",
    `fetch(${JSON.stringify(`http://${providerAddress}:8120/status`)}, {signal: AbortSignal.timeout(1000)}).then(()=>process.exit(1)).catch(error=>process.exit(error.cause?.code === 'ECONNREFUSED' ? 0 : 1))`,
  ]);
  checks++;
  const missing = await request(path, {
    service: null,
    context: null,
    status: 401,
    code: "service_unauthenticated",
    headers: { "X-Antnest-System-Role": "admin" },
  });
  assert.equal(
    missing.response.headers.get("www-authenticate"),
    'Bearer realm="antnest-service"',
  );
  checks++;
  await request(path, {
    service: "agent-ui",
    status: 403,
    code: "caller_not_allowed",
  });
  await request(path, {
    context: null,
    status: 401,
    code: "caller_context_required",
  });
  await request(path, {
    context: "forged",
    status: 401,
    code: "caller_context_invalid",
  });
  const now = Math.floor(Date.now() / 1000);
  for (const context of [
    callerContext(fixture, { aud: ["admin-console"] }),
    callerContext(fixture, { iat: now - 100, exp: now - 40 }),
    callerContext(fixture, {}, (raw) =>
      raw.replace('"sub":"user-admin"', '"sub":"user-admin","sub":"evil"'),
    ),
    callerContext(fixture, { agt: "agent-1" }),
  ])
    await request(path, {
      context,
      status: 401,
      code: "caller_context_invalid",
    });
  await request(path, {
    context: callerContext(fixture, { org_role: "member" }),
    status: 403,
    code: "forbidden",
    headers: { "X-Antnest-Organization-Role": "admin" },
  });
  await request("/internal/agents?organization_id=org-2", {
    status: 403,
    code: "organization_mismatch",
  });
  await request("/internal/agents/agent-1?organization_id=org-1", {
    context: callerContext(fixture, { agt: "agent-2" }),
    status: 401,
    code: "caller_context_invalid",
  });
  await request(path, {
    headers: {
      "X-Antnest-Organization-ID": "forged",
      Cookie: "private",
      Authorization: "Bearer browser-token",
    },
  });
  for (const [name, value] of [
    [
      "Antnest-Service-Authorization",
      "Bearer " + fixture.incoming["admin-console"],
    ],
    ["Antnest-Caller-Context", callerContext(fixture)],
  ]) {
    const status = await new Promise((resolve, reject) => {
      const r = httpRequest(
        base + path,
        {
          headers: [
            "Host",
            new URL(base).host,
            "Antnest-Service-Authorization",
            "Bearer " + fixture.incoming["admin-console"],
            "Antnest-Caller-Context",
            callerContext(fixture),
            name,
            value,
          ],
        },
        (response) => {
          response.resume();
          response.once("end", () => resolve(response.statusCode));
        },
      );
      r.once("error", reject);
      r.end();
    });
    assert.equal(status, 401);
    checks++;
  }
  for (const [media, body, status, code] of [
    ["text/plain", "{}", 415, "unsupported_media_type"],
    ["application/json; charset=latin1", "{}", 415, "unsupported_media_type"],
    [
      "application/json",
      '{"organization_id":"org-1","actor_principal_id":"evil"}',
      403,
      "actor_mismatch",
    ],
    [
      "application/json",
      '{"organization_id":"org-1","\\u006frganization_id":"other"}',
      400,
      "invalid_request",
    ],
    ["application/json", '{"Organization_ID":"org-1"}', 400, "invalid_request"],
    ["application/json", "{} {}", 400, "invalid_request"],
    [
      "application/json",
      Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
      400,
      "invalid_request",
    ],
    ["application/json", " ".repeat(2 ** 21 + 1), 413, "request_too_large"],
  ])
    await request("/internal/agents", {
      method: "POST",
      headers: { "Content-Type": media },
      body,
      status,
      code,
    });
  await request("/rpc/agent-controller/list-workspace-agents", {
    method: "POST",
    service: "agent-ui",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      request_id: "workspace-auth-1",
      organization_id: "org-1",
      principal_id: "user-admin",
    }),
  });
  await request("/rpc/agent-controller/list-workspace-agents", {
    method: "POST",
    service: "edge-gateway",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      request_id: "workspace-auth-2",
      organization_id: "org-1",
      principal_id: "evil",
    }),
    status: 403,
    code: "actor_mismatch",
  });
  const create = async (path, body) =>
    request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
      status: 201,
    });
  const provider = (
    await create("/internal/provider-connections", {
      request_id: "provider-auth-1",
      organization_id: "org-1",
      provider_key: "deepseek",
      display_name: "Fixture",
      base_url: "http://provider:8110/v1",
      credential: { method: "api_key", api_key: providerSecret },
      models: [],
    })
  ).json;
  const providerState = async () =>
    JSON.parse(
      await docker([
        ...compose,
        "exec",
        "-T",
        "provider",
        "node",
        "-e",
        "fetch('http://127.0.0.1:8110/test/state').then(r=>r.text()).then(t=>process.stdout.write(t))",
      ]),
    );
  assert.equal(
    (await providerState()).calls,
    0,
    "creation sent a credential or Provider request",
  );
  checks++;
  await request(
    "/internal/provider-connections/" +
      provider.connection_id +
      "/access?organization_id=org-1",
    { status: 404 },
  );
  const discover = async (path, body, status = 200, code) =>
    request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      status,
      code,
    });
  const saved = await discover(
    "/internal/provider-connections/" +
      provider.connection_id +
      "/discover-models",
    { organization_id: "org-1" },
  );
  assert.equal(saved.response.headers.get("cache-control"), "no-store");
  assert.deepEqual(saved.json, {
    models: [
      {
        model_id: "fixture-model",
        display_name: "Fixture",
        context_window: 128000,
        max_output_tokens: 8192,
        pricing: {
          currency: "USD",
          input_per_million: 1,
          output_per_million: 2,
        },
      },
    ],
  });
  checks++;
  const draft = {
    organization_id: "org-1",
    provider_key: "deepseek",
    base_url: "http://provider:8110/v1",
    credential: { method: "api_key", api_key: providerSecret },
  };
  await discover("/internal/provider-discovery/draft", draft);
  await discover(
    "/internal/provider-discovery/draft",
    { ...draft, base_url: "http://provider:8110/redirect" },
    502,
    "provider_discovery_failed",
  );
  for (const endpoint of [
    "http://dependencies:8101/rpc/identity/jwks",
    "http://127.0.0.1:8120",
    "http://10.1.2.3",
    "http://169.254.169.254",
    "http://100.100.100.200",
    "http://[::ffff:127.0.0.1]",
  ]) {
    await discover(
      "/internal/provider-discovery/draft",
      { ...draft, base_url: endpoint },
      422,
      "provider_endpoint_forbidden",
    );
  }
  await discover(
    "/internal/provider-discovery/draft",
    { ...draft, base_url: "http://missing-provider.invalid" },
    503,
    "provider_endpoint_unavailable",
  );
  await discover(
    "/internal/provider-connections",
    {
      request_id: "private-create",
      organization_id: "org-1",
      provider_key: "deepseek",
      display_name: "Blocked",
      base_url: "http://dependencies:8101",
      credential: draft.credential,
      models: [],
    },
    422,
    "provider_endpoint_forbidden",
  );
  const providerStats = await providerState();
  assert.deepEqual(providerStats, { calls: 3, failures: 0, redirects: 0 });
  checks++;
  const model = (
    await create("/internal/model-profiles", {
      request_id: "model-auth-1",
      organization_id: "org-1",
      profile_key: "fixture",
      display_name: "Fixture",
      provider_connection_id: provider.connection_id,
      model: {
        model: "deepseek-chat",
        context_window: 128000,
        max_output_tokens: 8192,
        supports_images: false,
      },
    })
  ).json;
  const context = callerContext(fixture);
  const template = (
    await request("/internal/agent-templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request_id: "template-auth-1",
        organization_id: "org-1",
        template_key: "fixture",
        name: "Fixture",
        model_profile_id: model.model_profile_id,
        system_prompt: "Fixture",
        max_model_requests: 4,
        context_policy_version: "context-v1",
        runtime: {
          image_ref: "antnest/antnest-runtime:local",
          resources: {
            memory_bytes: 536870912,
            pids_limit: 256,
            tmpfs_bytes: 67108864,
          },
        },
        skill_refs: [{ skill_id: fixture.skill.skill_id, version: 1 }],
      }),
      context,
      status: 201,
    })
  ).json;
  const stats = async () =>
    JSON.parse(
      await docker([
        ...compose,
        "exec",
        "-T",
        "dependencies",
        "node",
        "-e",
        "fetch('http://127.0.0.1:8101/test/state').then(r=>r.text()).then(t=>process.stdout.write(t))",
      ]),
    );
  let state;
  for (let attempt = 0; attempt < 80; attempt++) {
    state = await stats();
    if (
      [
        "identity-service",
        "runtime-controller",
        "agent-acp-service",
        "skill-registry",
      ].every((name) => (state.calls[name] ?? 0) > 0)
    )
      break;
    await delay(250, undefined, { signal: abort.signal });
  }
  assert.equal(state.failures, 0);
  for (const name of [
    "identity-service",
    "runtime-controller",
    "agent-acp-service",
    "skill-registry",
  ])
    assert(
      state.calls[name] > 0,
      "missing authenticated production dependency: " + name,
    );
  assert(
    state.registryContexts.includes(
      createHash("sha256").update(context).digest("hex"),
    ),
    "verified CCT was replaced",
  );
  checks += 5;
  const eventually = async (read, accept, label) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const value = await read();
      if (accept(value)) return value;
      await delay(200, undefined, { signal: abort.signal });
    }
    throw Error("Controller fixture deadline: " + label);
  };
  const created = (
    await request("/internal/agents", {
      method: "POST",
      status: 202,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request_id: "agent-private-runtime",
        organization_id: "org-1",
        actor_principal_id: "user-admin",
        owner_user_id: "user-admin",
        name: "Private runtime fixture",
        template_id: template.template_id,
        template_revision: template.revision,
      }),
    })
  ).json;
  const agentID = created.agent.agent_id;
  const getAgent = async () =>
    (
      await request("/internal/agents/" + agentID + "?organization_id=org-1", {
        context: callerContext(fixture, { agt: agentID }),
      })
    ).json;
  await eventually(
    getAgent,
    (value) => value.runtime_state === "available",
    "ready Agent",
  );
  const privateHash = createHash("sha256")
    .update(fixture.runtimeAuthority.token)
    .digest("hex");
  const published = await eventually(
    stats,
    (value) => value.lastAgent?.accepting_runs === true,
    "private publication",
  );
  assert.equal(published.lastAgent.agent_id, agentID);
  assert.equal(
    published.lastAgent.connection_id,
    fixture.runtimeAuthority.connection_id,
  );
  assert.equal(published.lastAgent.token_hash, privateHash);
  assert.equal(published.failures, 0);
  checks += 4;
  for (const signal of ["SIGTERM", "SIGINT"]) {
    const beforeRestart = (await stats()).resolves;
    await docker(["kill", "--signal", signal, id]);
    for (let attempt = 0; attempt < 50; attempt++) {
      const [state] = JSON.parse(await docker(["inspect", id]));
      if (!state.State.Running) break;
      await delay(200);
    }
    const [stopped] = JSON.parse(await docker(["inspect", id]));
    assert.equal(stopped.State.Running, false);
    assert.equal(stopped.State.ExitCode, 0);
    checks++;
    await docker([...compose, "start", "agent-controller"], true);
    const [restarted] = JSON.parse(await docker(["inspect", id]));
    const rebound = restarted.NetworkSettings.Ports["8120/tcp"][0];
    assert.equal(rebound.HostIp, "127.0.0.1");
    base = "http://127.0.0.1:" + rebound.HostPort;
    let healthy = false;
    for (let attempt = 0; attempt < 150; attempt++) {
      try {
        const r = await fetch(base + "/status", { signal: abort.signal });
        await r.arrayBuffer();
        if (r.ok) {
          healthy = true;
          break;
        }
      } catch {
        // Retry startup transport failures, but let interruption reach cleanup.
        abort.signal.throwIfAborted();
      }
      await delay(200);
    }
    assert(healthy, "Controller did not recover after normal stop");
    await request(path);
    const restored = await eventually(
      stats,
      (value) =>
        value.resolves > beforeRestart &&
        value.lastAgent?.accepting_runs === true,
      "fresh restart resolution",
    );
    assert.equal(
      restored.lastAgent.connection_id,
      fixture.runtimeAuthority.connection_id,
    );
    assert.equal(restored.lastAgent.token_hash, privateHash);
    assert.equal(restored.failures, 0);
    checks += 3;
    checks++;
  }
  const connectionMode = async (mode) => {
    await docker([
      ...compose,
      "exec",
      "-T",
      "dependencies",
      "node",
      "-e",
      "fetch('http://127.0.0.1:8101/test/connection-mode?mode=" +
        mode +
        "').then(r=>{if(!r.ok)process.exit(1);return r.arrayBuffer()})",
    ]);
  };
  await connectionMode("wrong-endpoint");
  const firstFault = await eventually(
    stats,
    (value) => value.rejectedResolves > 0,
    "mismatch rejection",
  );
  const afterFault = await eventually(
    stats,
    (value) => value.rejectedResolves >= firstFault.rejectedResolves + 2,
    "repeated mismatch rejection",
  );
  assert.equal(
    afterFault.privateApplies,
    firstFault.privateApplies,
    "mismatched authority reached ACP",
  );
  assert.equal(afterFault.failures, 0);
  checks += 2;
  await connectionMode("unavailable");
  const closedBefore = (await stats()).closedApplies;
  await request("/internal/agents/" + agentID + "/disable", {
    context: callerContext(fixture, { agt: agentID }),
    method: "POST",
    status: 202,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      request_id: "disable-without-resolver",
      organization_id: "org-1",
      actor_principal_id: "user-admin",
    }),
  });
  await eventually(
    getAgent,
    (value) => value.activation_state === "disabled",
    "disable without Runtime authority",
  );
  const closedState = await stats();
  assert(closedState.closedApplies > closedBefore);
  assert.equal(closedState.lastAgent.accepting_runs, false);
  assert.equal(closedState.lastAgent.token_hash, null);
  assert.equal(closedState.failures, 0);
  checks += 4;
  const logs = await docker([
    ...compose,
    "logs",
    "--no-color",
    "agent-controller",
  ]);
  for (const secret of [
    providerSecret,
    ...Object.values(fixture.incoming),
    ...Object.values(fixture.tokens),
    fixture.runtimeAuthority.token,
    context,
  ])
    assert(!logs.includes(secret), "private credential in logs");
  for (const [variable, value] of [
    ["ANTNEST_SERVICE_AUTH_MODE", ""],
    ["ANTNEST_SKILL_REGISTRY_API_TOKEN", "legacy"],
    ["ANTNEST_AGENT_ACP_SERVICE_URL", "http://dependencies:8102"],
    ["ANTNEST_PROVIDER_ALLOW_PRIVATE_ENDPOINTS", ""],
    ["ANTNEST_PROVIDER_ALLOW_PRIVATE_ENDPOINTS", "true "],
  ]) {
    const probe = "controller-startup-" + randomUUID();
    try {
      await docker([
        ...compose,
        "run",
        "--name",
        probe,
        "--no-deps",
        "-d",
        "-e",
        "ANTNEST_AGENT_CONTROLLER_LISTEN=:8120",
        "-e",
        variable + "=" + value,
        "agent-controller",
      ]);
      for (let attempt = 0; attempt < 40; attempt++) {
        const [s] = JSON.parse(await docker(["inspect", probe]));
        if (!s.State.Running) break;
        await delay(100);
      }
      const [s] = JSON.parse(await docker(["inspect", probe]));
      assert.equal(s.State.Running, false);
      assert.notEqual(s.State.ExitCode, 0);
      checks++;
    } finally {
      await docker(["rm", "-f", probe], true);
    }
  }
  complete = true;
} catch (error) {
  // Bounded, redacted private diagnostics survive cleanup without retaining the
  // fixture's credentials or Docker environment values.
  try {
    let logs = await docker([
      ...compose,
      "logs",
      "--no-color",
      "--tail",
      "100",
      "agent-controller",
    ]);
    for (const secret of [
      providerSecret,
      ...Object.values(fixture.incoming),
      ...Object.values(fixture.tokens),
      fixture.runtimeAuthority.token,
    ]) {
      logs = logs.replaceAll(secret, "[redacted]");
    }
    writeFileSync(resolve(evidence, "failure.log"), logs.slice(-65536), {
      mode: 0o600,
    });
  } catch {
    // Preserve the original failure if bounded diagnostic capture is unavailable.
  }
  throw error;
} finally {
  clearTimeout(timer);
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  const cleanup = dockerClient(env, undefined, 180000);
  try {
    await cleanup(
      [...compose, "down", "--volumes", "--remove-orphans", "--timeout", "30"],
      true,
    );
    for (const args of [
      ["ps", "-aq"],
      ["volume", "ls", "-q"],
      ["network", "ls", "-q"],
    ])
      assert.equal(
        await cleanup([
          ...args,
          "--filter",
          "label=com.docker.compose.project=" + project,
        ]),
        "",
        "owned resource leak",
      );
    const image = `${project}-agent-controller:latest`;
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
        "agent-controller",
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
      JSON.stringify({ project, checks, complete, cleaned }, null, 2) + "\n",
      { mode: 0o600 },
    );
    console.log(JSON.stringify({ project, checks, complete, cleaned }));
  }
}
