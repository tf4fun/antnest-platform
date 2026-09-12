import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { composeArgs, lines } from "./docker.mjs";
import { applicationServices } from "./deployment.mjs";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { assertSecretFree } from "../identity-closeout/evidence.mjs";
import { assertEmptySession } from "../identity-closeout/acp-session-evidence.mjs";
import { assertState } from "../workspace-closeout/evidence.mjs";
import { until } from "../workspace-closeout/state.mjs";
import { connectOwner } from "./acp.mjs";
import {
  assertStopped,
  assertRestarted,
  inspectShutdownTrace,
} from "./shutdown-evidence.mjs";
import { openShutdownWatchSet } from "./shutdown-streams.mjs";

async function inventory(config, docker) {
  const ids = lines(
    await docker(
      composeArgs(config.project, [
        "ps",
        "-aq",
        ...applicationServices,
        "postgres",
      ]),
    ),
  );
  assert.equal(
    ids.length,
    applicationServices.length + 1,
    "missing platform container",
  );
  const format =
    '{"id":{{json .Id}},"name":{{json (index .Config.Labels "com.docker.compose.service")}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"image":{{json .Image}},"running":{{.State.Running}},"exit":{{.State.ExitCode}},"oom":{{.State.OOMKilled}},"error":{{json .State.Error}},"started":{{json .State.StartedAt}},"finished":{{json .State.FinishedAt}}}';
  return (await docker(["inspect", "--format", format, ...ids]))
    .split("\n")
    .map(JSON.parse);
}
async function collectTrace(config, expected, secrets, signal) {
  let result;
  await until(
    async () => {
      const response = await fetch(
        `${config.jaeger}/api/traces/${expected.traceID}`,
        { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) },
      );
      assert.equal(response.status, 200);
      const body = await response.text();
      assertSecretFree(body, secrets);
      let trace;
      try {
        trace = JSON.parse(body).data?.[0];
      } catch {
        throw new Error("invalid Jaeger shutdown response");
      }
      if (!trace) return false;
      // Wait only for export visibility; complete evidence must satisfy the oracle.
      const serverCount = trace.spans.filter((s) =>
        s.tags?.some((t) => t.key === "span.kind" && t.value === "server"),
      ).length;
      if (serverCount < (expected.console ? 4 : 3)) return false;
      result = inspectShutdownTrace(trace, expected, secrets);
      return true;
    },
    "shutdown trace export",
    signal,
    45000,
  );
  return result;
}
export async function runShutdown({
  config,
  docker,
  signal,
  json,
  agentBody,
  command,
  ready,
  traceSecrets,
}) {
  const created = await command("create", undefined, agentBody);
  const agentID = created.agentID,
    initial = await ready(agentID);
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
          assertState(s, agentID);
          assert.equal(s.availability, "ready");
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
    const before = await inventory(config, docker);
    eventWatch.assertOpen();
    stateWatch.assertOpen();
    assert.equal(acp.closeCode, undefined, "ACP closed before maintenance");
    // Host/VM wall clocks get one second of tolerance, not an unbounded window.
    const stopWindow = { start: Date.now() - 1000 };
    await docker(
      composeArgs(config.project, ["stop", "-t", "45", ...applicationServices]),
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
    await docker(
      composeArgs(config.project, ["stop", "-t", "30", "postgres"]),
      true,
    );
    const stopped = assertStopped(
      config.project,
      before,
      await inventory(config, docker),
    );
    const traces = [];
    for (const expected of [
      {
        traceID: eventWatch.traceID,
        route: "/api/admin/{path...}",
        console: true,
        controllerRoute: "/internal/agents/{agent_id}/events/watch",
      },
      {
        traceID: stateWatch.traceID,
        route: "/api/app/agents/{agent_id}/state/watch",
        console: false,
        controllerRoute: "/internal/workspace/agents/{agent_id}/state/watch",
      },
    ])
      traces.push(
        await collectTrace(
          config,
          { ...expected, stopWindow },
          traceSecrets,
          signal,
        ),
      );
    await docker(
      composeArgs(config.project, [
        "up",
        "-d",
        "--wait",
        "--wait-timeout",
        "180",
        "--no-build",
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
    assert.equal(current.volume, initial.volume);
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
    const fresh = await watchPair();
    assert.deepEqual(fresh[1].events[0], stateWatch.events[0]);
    assert.deepEqual(fresh[0].events[0], eventWatch.events[0]);
    for (const watch of watches) watch.close();
    for (const client of clients) client.close();
    await command("delete", agentID, {});
    assert.equal(
      (await json(`/api/admin/agents/${agentID}`)).lifecycle_state,
      "deleted",
    );
    return {
      profile: "shutdown",
      stopped,
      restarted,
      watches_closed_by_server: 2,
      acp_close_code: acp.closeCode,
      same_session_recovered: true,
      workspace: "retained",
      runtime: "unchanged",
      traces,
    };
  } finally {
    for (const watch of watches) watch.close();
    for (const client of clients) client.close();
  }
}
