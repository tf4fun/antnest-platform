import { durablePath, writeEvidenceFile } from "../../support/storage.mjs";
import { createHash } from "node:crypto";
import { inspect } from "node:util";
import { stage2Step } from "./stage2-step.mjs";
import { assertStage2TraceCredentials } from "./stage2-trace-credentials.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  json,
  startClientTelemetry,
  traced,
  waitFor,
  configureStage2Authentication,
  registerFixturePrincipal,
} from "./stage2-transport.mjs";
import {
  agentReferences,
  inspectExecutionBoundary,
  inspectLifecycleBoundary,
  inspectAuditBoundary,
  assertNoCredentials,
  inspectTemporalHistory,
} from "./stage2-boundary-evidence.mjs";
import { verifyAdministrativeAudit } from "./stage2-audit-flow.mjs";
import {
  waitForTraceParents,
  reviewStage2Trace,
} from "./stage2-trace-read.mjs";
import { gatewayLogin, gatewayCommand } from "./stage2-gateway.mjs";
import { createStage2PrivateAccess } from "./stage2-private-access.mjs";
import { inspectStage2PrivatePrompt } from "./stage2-private-trace.mjs";
import {
  assertStage2Inventory,
  stage2CompletedTraceIDs,
} from "./stage2-inventory.mjs";
import { assertWorkspaceWatchReceipt } from "../workspace-closeout/private-watch.mjs";
import { tag } from "../observability/trace-tree.mjs";

const env = (name) => {
  assert(process.env[name], `${name} is required`);
  return process.env[name];
};
const controller = `http://127.0.0.1:${env("ANTNEST_AGENT_CONTROLLER_HOST_PORT")}`;
const identity = `http://127.0.0.1:${env("ANTNEST_IDENTITY_HOST_PORT")}`;
const execution = `http://127.0.0.1:${env("ANTNEST_ACP_HOST_PORT")}`;
const model = `http://127.0.0.1:${env("ANTNEST_STAGE2_MODEL_HOST_PORT")}`;
const gateway = `http://127.0.0.1:${env("ANTNEST_EDGE_HOST_PORT")}`;
const project = env("COMPOSE_PROJECT_NAME");
assert(
  /^(?:antnest-stage2-e2e-\d+|antnest-lifecycle-[a-f0-9]{8})$/u.test(project),
  "disposable Stage 2 project required",
);
const traceDirectory = `artifacts/verification/stage2-boundary/${project}/traces`;
durablePath(traceDirectory);
await mkdir(traceDirectory, { recursive: true, mode: 0o700 });
const compose = (...args) =>
  execFileSync(
    "docker",
    [
      "compose",
      "--profile",
      "stage2",
      "--profile",
      "stage2-e2e",
      "--profile",
      "observability",
      ...args,
    ],
    { stdio: ["ignore", "pipe", "inherit"], timeout: 240000 },
  );
const sdk = startClientTelemetry(env("ANTNEST_STAGE2_OTLP_URL"));
let telemetryStopped = false;
let privateAccess;
const secrets = [];
const sessions = [];
const failures = [];
let client;
let agentId;
let organizationId;
let principalId;
let management;
const evidence = { scenarios: [], traces: [], management: [], workflows: [] };
const rpc = (method, body, headers = management, status = 200) =>
  json(`${execution}/rpc/agent-acp/${method}`, body, status, headers);
const current = () =>
  json(
    `${controller}/internal/agents/${agentId}?organization_id=${organizationId}`,
  );
const requestBody = (requestId) => ({
  request_id: requestId,
  organization_id: organizationId,
  actor_principal_id: principalId,
});
const operation = (requestId) =>
  waitFor(
    () =>
      json(
        `${controller}/internal/agent-operations/${requestId}?organization_id=${organizationId}`,
      ),
    (value) => {
      assert.notEqual(
        value.state,
        "failed",
        `lifecycle failed: ${JSON.stringify(value)}`,
      );
      return value.state === "completed";
    },
    `operation ${requestId}`,
  );
const synchronized = () =>
  waitFor(
    () =>
      json(
        `${controller}/internal/execution-synchronization?organization_id=${organizationId}`,
      ),
    (value) =>
      value.synchronization?.revision > 0 &&
      value.synchronization.revision === value.synchronization.applied_revision,
    "configuration publication",
  );
const scenario = (name, work) =>
  traced(name, async (traceId) => {
    await work(traceId);
    evidence.scenarios.push(name);
    evidence.traces.push({ name, trace_id: traceId });
    console.log(
      JSON.stringify({ scenario: name, result: "passed", trace_id: traceId }),
    );
  });

configureStage2Authentication({
  "identity-service": identity,
  "agent-controller": controller,
  "agent-acp-service": execution,
});
try {
  privateAccess = await createStage2PrivateAccess(
    {
      evidence: `artifacts/verification/stage2-boundary/${project}/private`,
      privateAccess: {
        acp: execution,
        identity,
        otlp: env("ANTNEST_STAGE2_OTLP_URL"),
        credentials: env("ANTNEST_SERVICE_AUTH_DIRECTORY"),
      },
    },
    { secrets },
  );
  const administrator = await gatewayLogin(
    gateway,
    "stage2",
    "stage2-admin@example.com",
    "stage2-admin-password",
  );
  secrets.push(administrator.accessToken, administrator.csrf);
  sessions.push(administrator.accessToken);
  const login = await json(`${identity}/rpc/identity/local-login`, {
    request_id: "stage2-login",
    organization_slug: "stage2",
    email: "stage2-admin@example.com",
    password: "stage2-admin-password",
  });
  registerFixturePrincipal(login.principal, login.token_id);
  organizationId = login.principal.organization_id;
  principalId = login.principal.user_id;
  management = {
    "x-antnest-user-id": principalId,
    "x-antnest-organization-id": organizationId,
    "x-antnest-membership-id": login.principal.membership_id,
    "x-antnest-system-role": login.principal.system_role,
    "x-antnest-organization-role": login.principal.organization_role,
  };
  const owner = await json(`${identity}/rpc/identity/create-local-user`, {
    ...requestBody("stage2-owner"),
    email: "stage2-owner@example.com",
    display_name: "Stage 2 Owner",
    password: "stage2-owner-password",
    role: "member",
  });
  registerFixturePrincipal({
    organization_id: organizationId,
    user_id: owner.user.id,
    membership_id: owner.membership.id,
    system_role: owner.user.system_role ?? "user",
    organization_role: owner.membership.role,
  });
  const provider = await json(
    `${controller}/internal/provider-connections`,
    {
      request_id: "stage2-provider",
      organization_id: organizationId,
      provider_key: "deepseek",
      display_name: "Stage 2 Provider",
      base_url: "http://stage2-model:8080/v1",
      credential: { method: "api_key", api_key: "stage2-model-secret" },
      models: [],
    },
    201,
  );
  const profile = await json(
    `${controller}/internal/model-profiles`,
    {
      request_id: "stage2-model",
      organization_id: organizationId,
      provider_connection_id: provider.connection_id,
      profile_key: "stage2-model",
      display_name: "Stage 2 Model",
      model: {
        model: "stage2-deterministic",
        context_window: 8192,
        max_output_tokens: 1024,
        supports_images: false,
      },
    },
    201,
  );
  const template = await json(
    `${controller}/internal/agent-templates`,
    {
      request_id: "stage2-template",
      organization_id: organizationId,
      template_key: "stage2-template",
      name: "Stage 2 Template",
      model_profile_id: profile.model_profile_id,
      system_prompt: "Use Runtime Tools to complete the request.",
      max_model_requests: 4,
      context_policy_version: "context-v1",
      runtime: {
        image_ref: env("ANTNEST_STAGE2_RUNTIME_IMAGE"),
        resources: {
          memory_bytes: 536870912,
          pids_limit: 256,
          tmpfs_bytes: 67108864,
        },
      },
    },
    201,
  );
  const templateRef = {
    template_id: template.template_id,
    template_revision: 1,
  };
  const create = {
    ...requestBody("stage2-agent-create"),
    ...templateRef,
    owner_user_id: owner.user.id,
    name: "Stage 2 Agent",
  };
  await scenario("create", async () => {
    const accepted = await gatewayCommand(
      gateway,
      administrator,
      "/api/admin/agents",
      {
        ...templateRef,
        owner_user_id: owner.user.id,
        name: create.name,
      },
      create.request_id,
    );
    const response = accepted.payload;
    create.request_id = response.operation.request_id;
    evidence.workflows.push(`agent-create/${create.request_id}`);
    evidence.management.push({ kind: "create", trace_id: accepted.traceId });
    assert.equal(response.agent_access_subject, undefined);
    agentId = response.agent.agent_id;
    await operation(create.request_id);
    await synchronized();
  });
  const ownerLogin = await gatewayLogin(
    gateway,
    "stage2",
    "stage2-owner@example.com",
    "stage2-owner-password",
  );
  secrets.push(ownerLogin.accessToken, ownerLogin.csrf);
  sessions.push(ownerLogin.accessToken);
  const state = () =>
    privateAccess.state(agentId, ownerLogin, ownerLogin.principal);
  const ready = () =>
    waitFor(
      state,
      (value) => value.access_allowed && value.availability === "ready",
      "ACP ready",
    );
  const privateClient = () =>
    privateAccess.open(agentId, ownerLogin, ownerLogin.principal);
  await ready();
  client = await privateClient();
  const session = await client.newSession();
  const modelState = () => json(`${model}/fixture/state`);
  const control = (command) => json(`${model}/fixture/control`, command);
  await scenario("same-run-credential-rotation", async () => {
    const before = agentReferences(await current());
    await control({ hold_next: true });
    const completion = client.prompt(session.sessionId);
    // Attach the rejection handler before any deliberate service interruption.
    completion.catch(() => {});
    await waitFor(
      modelState,
      (value) => value.held === 1,
      "first model request held",
    );
    await json(
      `${controller}/internal/provider-connections/${provider.connection_id}/credentials`,
      {
        request_id: "stage2-rotate",
        organization_id: organizationId,
        expected_version: provider.credential_version,
        credential: { method: "api_key", api_key: "stage2-model-replacement" },
      },
      201,
    );
    await synchronized();
    await control({ credential: "stage2-model-replacement", release: true });
    await completion;
    const observed = await modelState();
    assert.deepEqual(
      observed.attempts.map((item) => item.status),
      [200, 200],
      "rotation retried with a stale credential",
    );
    assert.deepEqual(
      observed.requests.map((item) => item.credential_generation),
      [1, 2],
    );
    assert.equal(
      new Set(observed.requests.map((item) => item.trace_id)).size,
      1,
      "rotation must remain in the same Run",
    );
    const after = agentReferences(await current());
    assert.deepEqual(
      after,
      before,
      "credentials must not change Agent Runtime or Template bindings",
    );
  });
  await scenario("controller-offline-execution", async () => {
    const before = (await modelState()).requests.length;
    await stage2Step(
      async () => {
        compose("stop", "agent-controller");
        const initialState = await privateAccess.firstState(
          agentId,
          ownerLogin,
          ownerLogin.principal,
        );
        assert.equal(initialState.availability, "ready");
        await client.prompt(session.sessionId);
        await client.close();
        client = await privateClient();
        const other = await client.newSession();
        await client.prompt(other.sessionId);
        const reconnectedState = await privateAccess.firstState(
          agentId,
          ownerLogin,
          ownerLogin.principal,
        );
        assert.equal(reconnectedState.availability, "ready");
        assert.equal(
          reconnectedState.configuration_revision,
          initialState.configuration_revision,
        );
        assert.equal(reconnectedState.active_session_id, null);
      },
      () => compose("up", "-d", "--no-deps", "--wait", "agent-controller"),
    );
    const additional = (await modelState()).requests.slice(before);
    assert.equal(additional.length, 4);
    assert.deepEqual(
      additional.map((item) => item.has_tool_result),
      [false, true, false, true],
    );
  });
  await synchronized();
  const lifecycle = async (kind, extra = {}) => {
    const requestId = `stage2-${kind}`;
    await json(
      `${controller}/internal/agents/${agentId}/${kind}`,
      { ...requestBody(requestId), ...extra },
      202,
    );
    await operation(requestId);
    evidence.workflows.push(`agent-${kind}/${requestId}`);
    await synchronized();
  };
  await scenario("rebuild-active-execution", async () => {
    const spare = await client.newSession();
    const running = await client.newSession();
    const before = agentReferences(await current());
    await control({ hold_next: true });
    const completion = client.prompt(running.sessionId);
    completion.catch(() => {});
    await waitFor(
      modelState,
      (value) => value.held === 1,
      "running before rebuild",
    );
    const rebuild = await gatewayCommand(
      gateway,
      administrator,
      `/api/admin/agents/${agentId}/rebuild`,
      templateRef,
      "stage2-agent-rebuild",
    );
    evidence.management.push({ kind: "rebuild", trace_id: rebuild.traceId });
    evidence.workflows.push(`agent-rebuild/${rebuild.payload.request_id}`);
    await waitFor(
      state,
      (value) =>
        value.access_allowed === true &&
        value.unavailable_reason === "agent_unavailable",
      "closed rebuild admission",
    );
    const beforeDenied = await rpc("list-execution-audits", {
      agent_id: agentId,
    });
    await client.denied(spare.sessionId, ["agent_busy"]);
    assert.deepEqual(
      await rpc("list-execution-audits", { agent_id: agentId }),
      beforeDenied,
      "rejected prompt created execution",
    );
    assert.equal(
      agentReferences(await current()).runtime.runtime_revision,
      before.runtime.runtime_revision,
      "Runtime changed before settlement",
    );
    await control({ release: true });
    await completion;
    await operation(rebuild.payload.request_id);
    await synchronized();
    await ready();
    assert.notEqual(
      agentReferences(await current()).runtime.runtime_revision,
      before.runtime.runtime_revision,
    );
    const persisted = execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "--name",
        `${env("COMPOSE_PROJECT_NAME")}-workspace-check`,
        "--label",
        `io.antnest.runtime-controller-scope=${env("COMPOSE_PROJECT_NAME")}`,
        "--network",
        "none",
        "--read-only",
        "--user",
        "1000:1000",
        "--cap-drop",
        "ALL",
        "--mount",
        `type=volume,src=antnest-workspace-${agentId},dst=/workspace,readonly`,
        "--entrypoint",
        "cat",
        env("ANTNEST_STAGE2_RUNTIME_IMAGE"),
        "/workspace/stage2-evidence.txt",
      ],
      { encoding: "utf8", timeout: 15000 },
    );
    assert.equal(persisted.trim(), "stage2-runtime-tool-ok");
  });
  await scenario("disable-enable", async () => {
    await lifecycle("disable");
    await waitFor(
      state,
      (value) => value.availability === "offline",
      "disabled ACP state",
    );
    await client.denied(session.sessionId);
    const http = await privateAccess.openHTTP(
      agentId,
      ownerLogin,
      ownerLogin.principal,
    );
    await stage2Step(
      async () => {
        const listed = await http.request("list", {});
        assert(
          listed.sessions.some((item) => item.sessionId === session.sessionId),
        );
        await http.request("load", {
          sessionId: session.sessionId,
          cwd: "/workspace",
          mcpServers: [],
        });
        await assert.rejects(
          http.request("prompt", {
            sessionId: session.sessionId,
            prompt: [{ type: "text", text: "must not execute" }],
          }),
          (error) => error?.data?.code === "agent_unavailable",
        );
        await lifecycle("enable");
        await ready();
        await http.prompt();
      },
      () => http.close(),
    );
  });
  await scenario(
    "acp-crash-records-interruption-without-replay",
    async (scenarioTraceId) => {
      // SIGKILL discards the SDK export buffer. Finish exporting earlier,
      // successful scenarios before intentionally interrupting the next Run.
      await client.close();
      client = undefined;
      await delay(6000);
      client = await privateClient();
      const running = await client.newSession();
      await control({ hold_next: true });
      const completion = client.prompt(running.sessionId);
      completion.catch(() => {});
      const held = await waitFor(
        modelState,
        (value) => value.held === 1,
        "unfinished Run before crash",
      );
      const before = await rpc("list-execution-audits", {
        agent_id: agentId,
        session_id: running.sessionId,
      });
      assert.equal(before.items.length, 1);
      assert.equal(before.items[0].state, "running");
      const publication = await synchronized();
      await stage2Step(
        async () => {
          compose("stop", "agent-controller");
          compose("kill", "--signal", "SIGKILL", "agent-acp-service");
          await assert.rejects(completion);
          await client.close();
          client = undefined;
          compose("up", "-d", "--no-deps", "--wait", "agent-acp-service");
          const terminal = await rpc("get-execution-audit", {
            run_id: before.items[0].run_id,
          });
          assert.equal(terminal.state, "failed");
          assert.equal(terminal.error_class, "service_restarted_during_run");
          const cold = await state();
          assert.equal(cold.code, "execution_state_unavailable");
          const coldClient = await privateClient();
          await stage2Step(
            () =>
              assert.rejects(
                coldClient.newSession(),
                (error) => error?.data?.code === "configuration_not_ready",
              ),
            () => coldClient.close(),
          );
          await control({ release: true });
          await delay(1000);
          assert.equal(
            (await modelState()).attempts.length,
            held.attempts.length,
            "startup replayed old execution",
          );
          evidence.interrupted = {
            run_id: terminal.run_id,
            trace_id: held.requests.at(-1).trace_id,
            scenario_trace_id: scenarioTraceId,
            state: terminal.state,
            error_class: terminal.error_class,
            trace_complete: false,
          };
        },
        () => compose("up", "-d", "--no-deps", "--wait", "agent-controller"),
      );
      await ready();
      assert.equal(
        (await synchronized()).synchronization.revision,
        publication.synchronization.revision,
        "restart should replay the same configuration revision",
      );
      assert.equal(
        (await modelState()).attempts.length,
        held.attempts.length,
        "configuration replay restarted old Run",
      );
      client = await privateClient();
      const next = await client.newSession();
      await client.prompt(next.sessionId);
      assert.equal(
        (await modelState()).attempts.length,
        held.attempts.length + 2,
        "only the explicit new Run may execute after restart",
      );
      const interrupted = await rpc("get-execution-audit", {
        run_id: evidence.interrupted.run_id,
      });
      assert.equal(interrupted.state, "failed");
      assert.equal(interrupted.error_class, evidence.interrupted.error_class);
    },
  );
  await scenario("identity-revocation", async (traceId) => {
    const watch = await privateAccess.watch(
      agentId,
      ownerLogin,
      ownerLogin.principal,
    );
    await watch.ready();
    const start = watch.beginRevocation();
    await json(`${identity}/rpc/identity/update-membership`, {
      ...requestBody("stage2-owner-deactivate"),
      membership_id: owner.membership.id,
      email: "stage2-owner@example.com",
      display_name: "Stage 2 Owner",
      role: "member",
      active: false,
    });
    await watch.wait((value) => !value.access_allowed, start.receivedEvents);
    await watch.waitClosed();
    const receipt = await watch.closeAndWait();
    assertWorkspaceWatchReceipt(receipt, {
      mode: "revocation",
      agentID: agentId,
      principal: ownerLogin.principal,
      session_digest: createHash("sha256")
        .update(ownerLogin.accessToken)
        .digest("hex"),
      traceID: receipt.traceID,
      clientSpanID: receipt.clientSpanID,
      window: { start: start.observedAt, end: Date.now() },
      revocationTraceID: traceId,
      revocationStart: start,
    });
    await client.denied(session.sessionId, ["access_denied"]);
    await client.close();
    client = undefined;
    evidence.revocation = {
      mutation_trace_id: traceId,
      watch: receipt,
      denied_connection: await privateAccess.denyNewConnection(
        agentId,
        ownerLogin,
        ownerLogin.principal,
        { after: start.observedAt },
      ),
    };
    await waitFor(
      current,
      (value) =>
        value.activation_state === "disabled" &&
        !value.active_operation_request_id,
      "offboarding completion",
    );
  });
  await scenario("delete-and-retain-execution-audit", async () => {
    const before = await rpc("list-execution-audits", {
      agent_id: agentId,
      limit: 100,
    });
    assert.equal(before.items.length, 7);
    await lifecycle("delete");
    assert.equal((await current()).lifecycle_state, "deleted");
    const audits = await rpc("list-execution-audits", {
      agent_id: agentId,
      limit: 100,
    });
    assert.deepEqual(audits, before, "deletion changed execution history");
    evidence.retained_audits = audits.items;
    const containers = execFileSync(
      "docker",
      ["ps", "-aq", "--filter", `name=^/antnest-runtime-${agentId}$`],
      { encoding: "utf8", timeout: 10000 },
    );
    const volumes = execFileSync(
      "docker",
      ["volume", "ls", "-q", "--filter", `name=^antnest-workspace-${agentId}$`],
      { encoding: "utf8", timeout: 10000 },
    );
    assert.equal(
      containers.trim(),
      "",
      "deleted Agent retained a Runtime container",
    );
    assert.equal(
      volumes.trim(),
      "",
      "deleted Agent retained workspace storage",
    );
    const detail = await rpc("get-execution-audit", {
      run_id: audits.items[0].run_id,
    });
    assert(detail);
    const events = await rpc("list-execution-events", {
      run_id: audits.items[0].run_id,
      stream: "execution",
      limit: 100,
    });
    assert(events.items.length > 0);
    for (const [method, body] of [
      ["list-execution-audits", { agent_id: agentId }],
      ["get-execution-audit", { run_id: detail.run_id }],
      ["list-execution-events", { run_id: detail.run_id }],
    ]) {
      await rpc(
        method,
        body,
        { "x-antnest-fixture-authentication": "none" },
        401,
      );
      await rpc(
        method,
        body,
        {
          ...management,
          "x-antnest-user-id": owner.user.id,
          "x-antnest-membership-id": owner.membership.id,
          "x-antnest-system-role": "user",
          "x-antnest-organization-role": "member",
        },
        403,
      );
    }
  });
  const modelCalls = await modelState();
  evidence.audit = await verifyAdministrativeAudit({
    gateway: `http://127.0.0.1:${env("ANTNEST_EDGE_HOST_PORT")}`,
    identity,
    organizationId,
    principalId,
    owner,
    agentId,
    rpc,
    modelState,
    compose,
    secrets,
    sessions,
  });
  evidence.scenarios.push("authenticated-audit-consumer");
  const persisted = compose(
    "exec",
    "-T",
    "postgres",
    "pg_dump",
    "-U",
    "antnest_test_admin",
    "--data-only",
    "antnest_agent_acp",
  ).toString();
  assert(persisted.includes(agentId), "ACP persistence evidence is empty");
  assertNoCredentials(persisted, secrets);
  writeEvidenceFile(
    `artifacts/verification/stage2-boundary/${project}`,
    "acp-data.sql",
    persisted,
  );
  const logs = compose(
    "logs",
    "--no-color",
    "agent-controller",
    "agent-acp-service",
  ).toString();
  assert(logs.includes("service_started"), "ACP log evidence is empty");
  assertNoCredentials(logs, secrets);
  writeEvidenceFile(
    `artifacts/verification/stage2-boundary/${project}`,
    "service-logs.txt",
    logs,
  );
  for (const workflowId of evidence.workflows) {
    const history = JSON.parse(
      compose(
        "run",
        "--rm",
        "--no-deps",
        "--entrypoint",
        "temporal",
        "temporal-namespace",
        "--namespace",
        "antnest",
        "--output",
        "json",
        "--no-json-shorthand-payloads",
        "--command-timeout",
        "15s",
        "workflow",
        "show",
        "--workflow-id",
        workflowId,
      ).toString(),
    );
    writeEvidenceFile(
      `artifacts/verification/stage2-boundary/${project}`,
      `history-${evidence.workflows.indexOf(workflowId) + 1}.json`,
      JSON.stringify(history),
    );
    inspectTemporalHistory(history, agentId, secrets);
  }
  evidence.secret_checks = {
    acp_database: true,
    service_logs: true,
    decoded_temporal_histories: evidence.workflows.length,
  };
  console.log(
    JSON.stringify({
      scenario: "authenticated-audit-consumer",
      result: "passed",
      runs: evidence.audit.runs,
    }),
  );
  await privateAccess.closeAndWait();
  client = undefined;
  evidence.private = {
    connections: privateAccess.snapshots(),
    http: privateAccess.httpSnapshots(),
    states: privateAccess.stateReceipts(),
    watches: privateAccess.watchSnapshots(),
    authority: privateAccess.authoritySnapshots(),
  };
  evidence.model_calls = modelCalls;
  const idleStart = new Date().toISOString();
  const idleSamples = [];
  for (let sample = 0; sample < 3; sample++) {
    await delay(10000);
    const rows = ["agent-controller", "agent-acp-service"].flatMap((service) =>
      compose("stats", "--no-stream", "--format", "{{json .}}", service)
        .toString()
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    );
    assert.equal(rows.length, 2, "both services require idle resource samples");
    idleSamples.push(rows);
  }
  evidence.idle = {
    seconds: (Date.now() - Date.parse(idleStart)) / 1000,
    samples: idleSamples,
    log_lines: compose(
      "logs",
      "--since",
      idleStart,
      "--no-color",
      "agent-controller",
      "agent-acp-service",
    )
      .toString()
      .split("\n")
      .filter(Boolean).length,
  };
  console.log(
    JSON.stringify({ diagnostic: "idle-services", ...evidence.idle }),
  );
  await sdk.shutdown();
  telemetryStopped = true;
  await delay(6000);
  const jaeger = `http://127.0.0.1:${env("ANTNEST_JAEGER_UI_HOST_PORT")}`;
  const traceFailures = [];
  evidence.trace_reviews = [];
  let traceReadNumber = 0;
  const readTrace = async (id) => {
    assert(/^[a-f0-9]{32}$/u.test(id), "valid Trace ID required");
    const data = await waitForTraceParents(async (signal) => {
      const response = await fetch(`${jaeger}/api/traces/${id}`, { signal });
      if (response.status === 404) return null;
      assert.equal(response.status, 200, `Jaeger trace query failed: ${id}`);
      const payload = await response.json();
      if (payload.data?.length === 0) return null;
      assert.equal(payload.data?.length, 1);
      await writeFile(
        `${traceDirectory}/${id}-${++traceReadNumber}.json`,
        JSON.stringify(payload.data[0]),
        {
          mode: 0o600,
        },
      );
      assertStage2TraceCredentials(payload.data[0], { secrets, sessions });
      return payload.data[0];
    });
    const diagnostics = data.spans
      .filter((span) => span.warnings?.length)
      .map((span) => ({
        span_id: span.spanID,
        name: span.operationName,
        service: data.processes[span.processID]?.serviceName,
        warnings: span.warnings,
        references: span.references,
        start: span.startTime,
        duration: span.duration,
        parent: data.spans
          .filter((item) =>
            span.references?.some(
              (ref) => ref.refType === "CHILD_OF" && ref.spanID === item.spanID,
            ),
          )
          .map((item) => ({
            name: item.operationName,
            start: item.startTime,
            duration: item.duration,
          })),
      }));
    if (diagnostics.length)
      console.error(
        JSON.stringify({
          trace_id: id,
          warning_spans: diagnostics.length,
          warnings: [...new Set(diagnostics.flatMap((item) => item.warnings))],
        }),
      );
    try {
      evidence.trace_reviews.push(reviewStage2Trace(data));
    } catch (error) {
      traceFailures.push({ label: `strict:${id}`, message: error.message });
    }
    return data;
  };
  const auditTraces = evidence.audit.traces;
  evidence.audit.traces = [];
  const checkTrace = async (label, operation) => {
    try {
      await operation();
    } catch (error) {
      traceFailures.push({
        label,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
  for (const id of new Set(auditTraces))
    await checkTrace(`audit:${id}`, async () => {
      evidence.audit.traces.push(inspectAuditBoundary(await readTrace(id)));
    });
  evidence.execution = [];
  evidence.connections = [];
  for (const id of stage2CompletedTraceIDs(modelCalls, evidence.interrupted)) {
    await checkTrace(`run:${id}`, async () => {
      const run = await readTrace(id);
      const inspected = inspectExecutionBoundary({ source: run, run });
      const prompt = run.spans.find(
        (span) => span.spanID === inspected.prompt_span_id,
      );
      const candidates = [
        ...evidence.private.connections.flatMap((connection) =>
          connection.evidence.map((receipt) => ({ receipt })),
        ),
        ...evidence.private.http.flatMap((connection) =>
          connection.evidence.map((receipt) => ({
            receipt,
            http: connection.http,
          })),
        ),
      ].filter(
        ({ receipt }) =>
          receipt.method === "session/prompt" &&
          receipt.outcome === "succeeded" &&
          receipt.requestId === tag(prompt, "antnest.request.id") &&
          receipt.inputSessionID === inspected.session_id &&
          receipt.agentId === inspected.agent_id &&
          `v${receipt.protocolVersion}` ===
            tag(prompt, "antnest.protocol.version") &&
          (receipt.transport === "http"
            ? receipt.traceID === id
            : prompt.references.some(
                (link) =>
                  link.refType === "FOLLOWS_FROM" &&
                  link.traceID === receipt.connectionTraceID,
              )),
      );
      assert.equal(
        candidates.length,
        1,
        "completed Run needs one original private Prompt receipt",
      );
      const { receipt, http } = candidates[0];
      const connection =
        receipt.transport === "websocket"
          ? await readTrace(receipt.connectionTraceID)
          : undefined;
      const bound = inspectStage2PrivatePrompt(run, receipt, {
        connection,
        http,
        secrets,
      });
      assert.equal(bound.prompt_span_id, inspected.prompt_span_id);
      evidence.execution.push({ ...inspected, ...bound });
      if (connection)
        evidence.connections.push({
          trace_id: connection.traceID,
          request_id: receipt.requestId,
        });
    });
  }
  evidence.lifecycle = [];
  for (const source of evidence.management)
    await checkTrace(`lifecycle:${source.kind}`, async () => {
      evidence.lifecycle.push(
        inspectLifecycleBoundary(await readTrace(source.trace_id), source.kind),
      );
    });
  await checkTrace("complete-stage2-inventory", () => {
    evidence.inventory = assertStage2Inventory({
      agentId,
      audits: evidence.retained_audits,
      execution: evidence.execution,
      modelCalls,
      interrupted: evidence.interrupted,
      scenarios: evidence.scenarios,
      management: evidence.lifecycle,
      workflows: evidence.workflows,
      auditTraceCount: evidence.audit.traces.length,
    });
    assert.equal(
      evidence.execution.filter((row) => row.transport === "websocket").length,
      5,
    );
    assert.equal(
      evidence.execution.filter((row) => row.transport === "http").length,
      1,
    );
  });
  console.log(
    JSON.stringify({
      diagnostic: "trace-summary",
      audit_traces: evidence.audit.traces.length,
      execution_traces: evidence.execution.length,
      lifecycle_traces: evidence.lifecycle.length,
      private_connections: evidence.connections.length,
      strict_warning_failures: traceFailures.filter((item) =>
        item.label.startsWith("strict:"),
      ).length,
      clock_warning_traces: evidence.trace_reviews.filter(
        (item) => item.strict_trace === "failed",
      ).length,
      structural_failures: traceFailures.filter(
        (item) => !item.label.startsWith("strict:"),
      ),
      secret_checks: evidence.secret_checks,
    }),
  );
  if (traceFailures.length) {
    throw new Error(
      `${traceFailures.length} trace checks failed; business scenarios are not full acceptance`,
    );
  }
} catch (error) {
  failures.push(error);
} finally {
  for (const close of [
    () => privateAccess?.closeAndWait(),
    () => (telemetryStopped ? undefined : sdk.shutdown()),
  ]) {
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    writeEvidenceFile(
      `artifacts/verification/stage2-boundary/${project}`,
      "stage2-result.json",
      JSON.stringify({
        ...evidence,
        agent_id: agentId,
        result: failures.length ? "failed" : "passed",
        failures: [...new Set(failures)].map((error) =>
          inspect(error, { depth: 12 }),
        ),
      }),
    );
  } catch (error) {
    failures.push(error);
  }
}
if (failures.length) {
  console.error(
    JSON.stringify({
      result: "failed",
      completed_scenarios: evidence.scenarios,
      errors: [...new Set(failures)].map((error) =>
        inspect(error, { depth: 12 }),
      ),
    }),
  );
  if (new Set(failures).size === 1) throw failures[0];
  throw new AggregateError(
    [...new Set(failures)],
    "Stage2 business and cleanup failed",
  );
}
console.log(
  JSON.stringify({
    result: "passed",
    agent_id: agentId,
    inventory: evidence.inventory,
  }),
);
