import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lines } from "./docker.mjs";
import { applicationServices } from "./deployment.mjs";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { assertEmptySession } from "../identity-closeout/acp-session-evidence.mjs";
import {
  assertStopped,
  assertRestarted,
  collectShutdownTrace,
} from "./shutdown-evidence.mjs";
import { collectLifecycleEvidence } from "./foundation-evidence.mjs";
import { saveFoundationFailure } from "./foundation-trace.mjs";
import { physicalIdentity } from "./network-support.mjs";
import { inspectSingleNodeMembership } from "./temporal-membership.mjs";
import { runPrivateShutdown } from "./shutdown-private-flow.mjs";

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
    '{"id":{{json .Id}},"name":{{json (index .Config.Labels "com.docker.compose.service")}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"image":{{json .Image}},"hostname":{{json .Config.Hostname}},"health":{{with .State.Health}}{{json .Status}}{{else}}"none"{{end}},"running":{{.State.Running}},"exit":{{.State.ExitCode}},"oom":{{.State.OOMKilled}},"error":{{json .State.Error}},"started":{{json .State.StartedAt}},"finished":{{json .State.FinishedAt}}}';
  const rows = (await docker(["inspect", "--format", format, ...ids]))
    .split("\n")
    .map(JSON.parse);
  for (const row of rows)
    if (row.name === "agent-acp-service" && row.running) {
      row.process = JSON.parse(
        await docker([
          "exec",
          row.id,
          "node",
          "-e",
          'process.stdout.write(JSON.stringify({pid:1,hostname:require("node:os").hostname(),argv:require("node:fs").readFileSync("/proc/1/cmdline","utf8").split("\\0").filter(Boolean)}))',
        ]),
      );
      assert.deepEqual(row.process, {
        pid: 1,
        hostname: row.hostname,
        argv: ["node", "dist/main.js"],
      });
    }
  return rows;
}
export async function collectShutdownWatchTraces(
  config,
  expectations,
  secrets,
  signal,
  options = {},
) {
  return collectLifecycleEvidence(
    expectations,
    (expected) =>
      collectShutdownTrace(config.jaeger, expected, secrets, {
        ...options,
        directory: `${config.evidence}/traces`,
        signal,
      }),
    (expected, error) => saveFoundationFailure(config, expected, error),
    signal,
  );
}
export function runShutdown(input) {
  return runPrivateShutdown(input, runShutdownScenario);
}
export async function runShutdownScenario(
  {
    config,
    docker,
    signal,
    json,
    agentBody,
    command,
    ready,
    resources,
    traceSecrets,
  },
  adapter,
) {
  const created = await command("create", undefined, agentBody);
  const agentID = created.agentID,
    initial = await ready(agentID);
  const auditPath = `/api/admin/execution-audits?agent_id=${agentID}`;
  const assertIdle = async () => {
    const response = await fetch(`${config.model}/status`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    });
    assert.equal(response.status, 200);
    adapter.idle(await json(auditPath), await response.json());
  };
  const historyPath = `/api/admin/agents/${agentID}/events?limit=100`;
  const history = adapter.history(await json(historyPath));
  assert(history.events.length < 100, "Agent history is truncated");
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
  let ownerPrincipal;
  for (const [client, email, password] of [
    [admin, "stage3-admin@example.com", "stage3-admin-password"],
    [owner, "lifecycle-owner@example.com", "lifecycle-owner-password"],
  ]) {
    const login = await client.request("/api/session/login", {
      body: { organization_slug: "stage3", email, password },
    });
    if (client === owner) ownerPrincipal = adapter.login(owner, login);
    traceSecrets.push(password, ...client.cookies.values());
  }
  const clients = [];
  const membership = async (phase, rows) => {
    const temporal = rows.find((row) => row.name === "temporal");
    assert(temporal?.running);
    const raw = await docker([
      "logs",
      "--since",
      temporal.started,
      temporal.id,
    ]);
    adapter.membership(phase, raw);
    return inspectSingleNodeMembership(raw);
  };
  const watchPair = () =>
    adapter.watchPair(admin, owner, ownerPrincipal, agentID);
  const [eventWatch, stateWatch] = await watchPair();
  const acp = await adapter.open(agentID, owner, ownerPrincipal);
  clients.push(acp);
  const { sessionId } = await acp.request("new", {
    cwd: "/workspace",
    mcpServers: [],
  });
  assertEmptySession(acp.updates, sessionId, 1, "new");
  await assertIdle();
  const before = await inventory(config, docker);
  adapter.inventory("initial", before);
  const initialMembership = await membership("initial", before);
  await adapter.beforeStop();
  eventWatch.assertOpen();
  stateWatch.assertOpen();
  assert.equal(acp.closeCode, undefined, "ACP closed before maintenance");
  const liveAt = Date.now();
  // Host/VM wall clocks get one second of tolerance, not an unbounded window.
  const stopStartedAt = Date.now();
  const stopWindow = { start: stopStartedAt - 1000 };
  await docker(
    config.compose(["stop", "-t", "45", ...applicationServices]),
    true,
  );
  const stopCompletedAt = Date.now();
  stopWindow.end = stopCompletedAt + 1000;
  await eventWatch.waitClosed();
  await stateWatch.waitClosed();
  const remoteClose = await acp.waitForClose(15000);
  adapter.remoteClosed(remoteClose);
  assert.equal(remoteClose.code, 1001, "ACP did not close for normal shutdown");
  assert.equal(
    remoteClose.localClose,
    false,
    "test close cannot prove maintenance",
  );
  assert(
    Number.isSafeInteger(remoteClose.at) &&
      remoteClose.at >= stopStartedAt &&
      remoteClose.at <= stopWindow.end,
  );
  await eventWatch.closeAndWait();
  await stateWatch.closeAndWait();
  await adapter.close(acp);
  await docker(config.compose(["stop", "-t", "30", "temporal"]), true);
  await docker(config.compose(["stop", "-t", "30", "postgres"]), true);
  const after = await inventory(config, docker);
  adapter.inventory("stopped", after);
  const stopped = assertStopped(config.project, before, after);
  const stop = {
    liveAt,
    startedAt: stopStartedAt,
    completedAt: stopCompletedAt,
    project: config.project,
    before,
    after,
  };
  adapter.stopped(stop, stopWindow, remoteClose);
  await adapter.collectStoppedWatches();
  signal.throwIfAborted();
  // Start existing containers only: no one-shot migration jobs or replacements.
  for (const services of [["postgres"], ["temporal"], applicationServices]) {
    console.error(`Lifecycle restart: ${services.join(", ")}`);
    await docker(
      config.compose(["start", "--wait", "--wait-timeout", "180", ...services]),
      true,
    );
  }
  const restartedRows = await inventory(config, docker);
  adapter.inventory("restarted", restartedRows);
  const restarted = assertRestarted(config.project, before, restartedRows);
  await adapter.afterRestart();
  const restartedMembership = await membership("restarted", restartedRows);
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
  const recoveredSentinel = await docker([
    "exec",
    "--user",
    "1000:1000",
    current.container.Id,
    "cat",
    sentinelPath,
  ]);
  adapter.workspace(sentinel, recoveredSentinel, sentinelPath);
  assert.equal(
    recoveredSentinel,
    sentinel,
    "maintenance changed workspace bytes",
  );
  const recovered = await adapter.open(agentID, owner, ownerPrincipal);
  clients.push(recovered);
  await recovered.request("load", {
    sessionId,
    cwd: "/workspace",
    mcpServers: [],
  });
  assertEmptySession(recovered.updates, sessionId, 1, "replay");
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
    adapter.history(await json(historyPath)),
    history,
    "maintenance changed Agent event journal",
  );
  const fresh = await watchPair();
  assert.deepEqual(fresh[1].events[0], stateWatch.events[0]);
  assert.deepEqual(fresh[0].events[0], eventWatch.events[0]);
  await adapter.closeWatches();
  for (const client of clients) await adapter.close(client);
  await command("delete", agentID, {});
  const removed = await resources(agentID),
    deleted = await json(`/api/admin/agents/${agentID}`);
  adapter.deleted(removed, deleted);
  assert.deepEqual(removed, { containers: [], volumes: [] });
  assert.equal(deleted.lifecycle_state, "deleted");
  return {
    profile: "shutdown",
    stopped,
    restarted,
    temporal_membership: {
      initial: initialMembership,
      restarted: restartedMembership,
    },
    stop_window: stopWindow,
    stop_observation: stop,
    restarted_inventory: restartedRows,
    acp_remote_close: remoteClose,
    watch_closures: [eventWatch.closure, stateWatch.closure],
    watches_closed_by_server: 2,
    acp_close_code: acp.closeCode,
    same_session_recovered: true,
    workspace: "retained",
    runtime: "unchanged",
    execution_audits: 0,
    model_requests: 0,
    event_history_preserved: true,
    deleted_before_teardown: true,
  };
}
