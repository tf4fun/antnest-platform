import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lines } from "./docker.mjs";
import { applicationServices } from "./deployment.mjs";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { assertEmptySession } from "../identity-closeout/acp-session-evidence.mjs";
import { until } from "../workspace-closeout/state.mjs";
import { connectOwner } from "./acp.mjs";
import {
  assertStopped,
  assertRestarted,
  inspectShutdownTrace,
  assertReadyExecutionState,
  assertIdleMaintenance,
} from "./shutdown-evidence.mjs";
import { collectTrace } from "../managed-mcp/trace.mjs";
import { collectManagedTrace } from "../managed-mcp/request-trace.mjs";
import { inspectCommandTrace } from "../acp-commands/trace.mjs";
import { strictSessionEvidence } from "../identity-closeout/session-trace.mjs";
import { collectLifecycleEvidence } from "./foundation-evidence.mjs";
import {
  saveFoundationTrace,
  saveFoundationFailure,
} from "./foundation-trace.mjs";
import { physicalIdentity } from "./network-support.mjs";
import { openShutdownWatchSet } from "./shutdown-streams.mjs";

async function inventory(config, docker) {
  const ids = lines(
    await docker(
      config.compose([
        "ps",
        "-aq",
        ...applicationServices,
        "postgres",
        "temporal",
      ]),
    ),
  );
  assert.equal(
    ids.length,
    applicationServices.length + 2,
    "missing platform container",
  );
  const format =
    '{"id":{{json .Id}},"name":{{json (index .Config.Labels "com.docker.compose.service")}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"image":{{json .Image}},"health":{{with .State.Health}}{{json .Status}}{{else}}"none"{{end}},"running":{{.State.Running}},"exit":{{.State.ExitCode}},"oom":{{.State.OOMKilled}},"error":{{json .State.Error}},"started":{{json .State.StartedAt}},"finished":{{json .State.FinishedAt}}}';
  return (await docker(["inspect", "--format", format, ...ids]))
    .split("\n")
    .map(JSON.parse);
}
export async function runShutdown({
  config,
  docker,
  signal,
  json,
  agentBody,
  command,
  ready,
  resources,
  traceSecrets,
}) {
  const created = await command("create", undefined, agentBody);
  const agentID = created.agentID,
    initial = await ready(agentID);
  const auditPath = `/api/admin/execution-audits?agent_id=${agentID}`;
  const assertIdle = async () => {
    const response = await fetch(`${config.model}/status`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    });
    assert.equal(response.status, 200);
    assertIdleMaintenance(await json(auditPath), await response.json());
  };
  const historyPath = `/api/admin/agents/${agentID}/events?limit=100`;
  const history = await json(historyPath);
  assert(history.events.length < 100, "Agent history is truncated");
  const requests = [];
  const remember = (client, method, sessionId) => {
    const request = client.requests.filter((r) => r.method === method).at(-1);
    assert(request, "actual ACP request missing");
    requests.push({
      ...request,
      sessionId,
      agentId: agentID,
      agentID,
      requestID: request.requestId,
      transport: "websocket",
      kind: "request",
      connectionTraceID: client.connectionTraceID,
    });
  };
  const sentinel = randomUUID(),
    sentinelPath = "/workspace/.c5-stop-sentinel";
  await docker([
    "exec",
    "--user",
    "1000:1000",
    initial.container.Id,
    "sh",
    "-c",
    'printf "%s" "$1" > "$2"',
    "sh",
    sentinel,
    sentinelPath,
  ]);
  const admin = new GatewayClient(config.gateway),
    owner = new GatewayClient(config.gateway);
  for (const [client, email, password] of [
    [admin, "stage3-admin@example.com", "stage3-admin-password"],
    [owner, "lifecycle-owner@example.com", "lifecycle-owner-password"],
  ]) {
    await client.request("/api/session/login", {
      body: { organization_slug: "stage3", email, password },
    });
    traceSecrets.push(password, ...client.cookies.values());
  }
  const eventsPath = `/api/admin/agents/${agentID}/events/watch`;
  const statePath = `/api/app/agents/${agentID}/state/watch`;
  const watches = [],
    clients = [];
  const watchPair = async () => {
    const [eventWatch, stateWatch] = openShutdownWatchSet([
      [
        admin,
        eventsPath,
        "agent_event",
        (e) => assert.equal(e.agent_id, agentID),
        signal,
      ],
      [
        owner,
        statePath,
        "workspace_state",
        (s) => {
          assertReadyExecutionState(s, agentID);
        },
        signal,
      ],
    ]);
    watches.push(eventWatch, stateWatch);
    await eventWatch.ready();
    await stateWatch.ready();
    return [eventWatch, stateWatch];
  };
  try {
    const [eventWatch, stateWatch] = await watchPair();
    const acp = connectOwner(config.gateway, agentID, owner.cookie, signal);
    clients.push(acp);
    await acp.initialize();
    const { sessionId } = await acp.request("new", {
      cwd: "/workspace",
      mcpServers: [],
    });
    assertEmptySession(acp.updates, sessionId, 1, "new");
    remember(acp, "session/new", sessionId);
    await assertIdle();
    const before = await inventory(config, docker);
    eventWatch.assertOpen();
    stateWatch.assertOpen();
    assert.equal(acp.closeCode, undefined, "ACP closed before maintenance");
    // Host/VM wall clocks get one second of tolerance, not an unbounded window.
    const stopWindow = { start: Date.now() - 1000 };
    await docker(
      config.compose(["stop", "-t", "45", ...applicationServices]),
      true,
    );
    stopWindow.end = Date.now() + 1000;
    await eventWatch.waitClosed();
    await stateWatch.waitClosed();
    await until(
      () => acp.closeCode !== undefined,
      "remote ACP closure",
      signal,
    );
    assert.equal(acp.closeCode, 1001, "ACP did not close for normal shutdown");
    await docker(config.compose(["stop", "-t", "30", "temporal"]), true);
    await docker(config.compose(["stop", "-t", "30", "postgres"]), true);
    const stopped = assertStopped(
      config.project,
      before,
      await inventory(config, docker),
    );
    const expectations = [
      {
        traceID: eventWatch.traceID,
        route: "/api/admin/{path...}",
        console: true,
        controllerRoute: "/internal/agents/{agent_id}/events/watch",
        kind: "event_watch",
        agentID,
        stopWindow,
      },
      {
        traceID: stateWatch.traceID,
        route: "/api/app/agents/{agent_id}/state/watch",
        console: false,
        executionState: true,
        kind: "state_watch",
        agentID,
        stopWindow,
      },
    ];
    const traces = await collectLifecycleEvidence(
      expectations,
      (expected) =>
        collectTrace(
          config.jaeger,
          expected.traceID,
          (trace) => {
            saveFoundationTrace(config, trace);
            return inspectShutdownTrace(trace, expected, traceSecrets);
          },
          signal,
        ),
      (expected, error) => saveFoundationFailure(config, expected, error),
      signal,
    );
    // Start existing containers only: no one-shot migration jobs or replacements.
    for (const services of [["postgres"], ["temporal"], applicationServices])
      await docker(
        config.compose([
          "start",
          "--wait",
          "--wait-timeout",
          "180",
          ...services,
        ]),
        true,
      );
    const restarted = assertRestarted(
      config.project,
      before,
      await inventory(config, docker),
    );
    const current = await ready(agentID);
    assert.equal(
      current.container.Id,
      initial.container.Id,
      "Compose maintenance replaced dynamic Runtime",
    );
    assert.deepEqual(
      physicalIdentity(current),
      physicalIdentity(initial),
      "maintenance changed Runtime process, mounts or execution binding",
    );
    assert(
      (await docker([
        "exec",
        "--user",
        "1000:1000",
        current.container.Id,
        "cat",
        sentinelPath,
      ])) === sentinel,
      "maintenance changed workspace bytes",
    );
    const recovered = connectOwner(
      config.gateway,
      agentID,
      owner.cookie,
      signal,
    );
    clients.push(recovered);
    await recovered.initialize();
    await recovered.request("load", {
      sessionId,
      cwd: "/workspace",
      mcpServers: [],
    });
    assertEmptySession(recovered.updates, sessionId, 1, "replay");
    remember(recovered, "session/load", sessionId);
    const metadata = (client) =>
      client.updates.filter(
        (u) => u.update.sessionUpdate === "session_info_update",
      );
    assert.deepEqual(
      metadata(recovered),
      metadata(acp),
      "empty Session metadata changed during maintenance",
    );
    await assertIdle();
    assert.deepEqual(
      await json(historyPath),
      history,
      "maintenance changed Agent event journal",
    );
    const fresh = await watchPair();
    assert.deepEqual(fresh[1].events[0], stateWatch.events[0]);
    assert.deepEqual(fresh[0].events[0], eventWatch.events[0]);
    for (const watch of watches) watch.close();
    for (const client of clients) client.close();
    const requestTraces = await collectLifecycleEvidence(
      requests,
      (expected) =>
        collectManagedTrace(
          config.jaeger,
          expected,
          traceSecrets,
          [],
          (trace) => {
            expected.traceID = trace.traceID;
            saveFoundationTrace(config, trace);
          },
          (trace, expected, secrets, calls) =>
            strictSessionEvidence(
              inspectCommandTrace(trace, expected, secrets, calls),
              trace,
            ),
          signal,
        ),
      (expected, error) =>
        saveFoundationFailure(
          config,
          { traceID: expected.traceID ?? expected.connectionTraceID },
          error,
        ),
      signal,
    );
    await command("delete", agentID, {});
    assert.deepEqual(await resources(agentID), { containers: [], volumes: [] });
    assert.equal(
      (await json(`/api/admin/agents/${agentID}`)).lifecycle_state,
      "deleted",
    );
    return {
      profile: "shutdown",
      stopped,
      restarted,
      stop_window: stopWindow,
      watches_closed_by_server: 2,
      acp_close_code: acp.closeCode,
      same_session_recovered: true,
      workspace: "retained",
      runtime: "unchanged",
      watch_traces: traces,
      request_traces: requestTraces,
      execution_audits: 0,
      model_requests: 0,
      event_history_preserved: true,
      deleted_before_teardown: true,
    };
  } finally {
    for (const watch of watches) watch.close();
    for (const client of clients) client.close();
  }
}
