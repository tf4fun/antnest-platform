import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { assertSecretFree } from "../identity-closeout/evidence.mjs";
import { gatewayOrigin } from "../../support/gateway-origin.mjs";
import { writeEvidenceFile } from "../../support/storage.mjs";
import { member } from "../workspace-closeout/c4-setup.mjs";
import { observedHeldRun } from "../workspace-closeout/browser-control.mjs";
import { connectOwner } from "../lifecycle-closeout/acp.mjs";
import { observeWorkspaceStream } from "./resolve-cache-stream.mjs";
import { collectOutageTraceArchive } from "./resolve-cache-outage-collect.mjs";
import {
  inspectOutageWindow,
  inspectFreshConsumerWindow,
  outagePhase,
  outageDelivery,
  outageOutput,
  outageTerminal,
} from "./resolve-cache-outage.mjs";

const admin = {
  organization_slug: "stage3",
  email: "stage3-admin@example.com",
  password: "stage3-admin-password",
};
const mark = () => ({ at: performance.now(), observed_at_ms: Date.now() });

export async function verifyWarmOutage({
  config,
  fixture,
  settings,
  signal,
  output,
  docker,
  compose,
}) {
  assert.equal(settings.resolveTTLMS, 10000);
  assert.equal(settings.captureRpcContent, false);
  const agentID = fixture.agentID,
    base = `/api/app/workspace/v1/agents/${encodeURIComponent(agentID)}`;
  const evidence = {
    project: config.project,
    agent_id: agentID,
    settings,
    http: [],
    model_observations: [],
    identity: {},
    consumer_restarts: [],
    ...mark(),
  };
  const secrets = [member.password, admin.password, "stage3-model-secret"];
  const connections = [];
  let stream,
    owner,
    identityID,
    stopped = false,
    problem,
    result;
  const write = () => {
    if (owner) evidence.wire = owner.wire;
    if (stream)
      evidence.stream = {
        ...stream.evidence,
        records: stream.records,
        closure: stream.closure,
        revoked: stream.revoked,
      };
    const raw = JSON.stringify(evidence, null, 2);
    assertSecretFree(raw, secrets);
    writeEvidenceFile(output, "outage-window.private.json", raw);
  };
  // Keep a real response even when its expected status is wrong. No password,
  // Cookie, CSRF value or Set-Cookie contents enter the evidence object.
  const http = async (
    client,
    path,
    {
      body,
      method = body === undefined ? "GET" : "POST",
      status = 200,
      headers = {},
      requestSignal = signal,
      label = path,
    } = {},
  ) => {
    const started_at = performance.now();
    const response = await fetch(client.base + path, {
      method,
      redirect: "manual",
      signal: AbortSignal.any([requestSignal, AbortSignal.timeout(15000)]),
      headers: {
        "Content-Type": "application/json",
        Cookie: client.cookie,
        Origin: gatewayOrigin(client.base),
        "X-Antnest-CSRF-Token": client.csrf,
        "Idempotency-Key": randomUUID(),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    for (const raw of response.headers.getSetCookie()) {
      const pair = raw.split(";", 1)[0],
        at = pair.indexOf("="),
        name = pair.slice(0, at),
        value = pair.slice(at + 1);
      if (value) {
        client.cookies.set(name, value);
        secrets.push(value);
      } else client.cookies.delete(name);
    }
    const row = {
      label,
      method,
      path,
      started_at,
      ...mark(),
      status: response.status,
      trace_id: response.headers.get("x-antnest-trace-id"),
      server_date: response.headers.get("date"),
      set_cookie_count: response.headers.getSetCookie().length,
      body: text ? JSON.parse(text) : null,
    };
    assertSecretFree(JSON.stringify(row), secrets);
    evidence.http.push(row);
    assert.equal(row.status, status, `${label}: HTTP ${row.status}`);
    assert.match(row.trace_id ?? "", /^[a-f0-9]{32}$/u);
    return row;
  };
  const login = async (credentials, label) => {
    const client = new GatewayClient(config.gateway);
    const response = await http(client, "/api/session/login", {
      body: credentials,
      label,
    });
    secrets.push(client.cookie);
    return { client, response };
  };
  const poll = async (
    check,
    label,
    requestSignal = signal,
    timeoutMS = 15000,
  ) => {
    const deadline = performance.now() + timeoutMS;
    for (;;) {
      requestSignal.throwIfAborted();
      const value = await check();
      if (value) return value;
      assert(performance.now() < deadline, `${label}: timed out`);
      await delay(25, undefined, { signal: requestSignal });
    }
  };
  const model = async (requestSignal = signal) => {
    const response = await fetch(`${config.model}/status`, {
      signal: AbortSignal.any([requestSignal, AbortSignal.timeout(2000)]),
    });
    assert.equal(response.status, 200);
    const state = await response.json();
    const observation = { ...mark(), state };
    evidence.model_observations.push(observation);
    assert.deepEqual(
      state.errors,
      [],
      "model fixture rejected an actual request",
    );
    return observation;
  };
  const inspectOwned = async (id, service) => {
    const [row] = JSON.parse(await docker(["inspect", id]));
    assert.equal(row.Id, id);
    assert.equal(
      row.Config.Labels["com.docker.compose.project"],
      config.project,
    );
    assert.equal(row.Config.Labels["com.docker.compose.service"], service);
    return {
      id: row.Id,
      project: row.Config.Labels["com.docker.compose.project"],
      service: row.Config.Labels["com.docker.compose.service"],
      running: row.State.Running,
      restarting: row.State.Restarting,
      exit_code: row.State.ExitCode,
      oom_killed: row.State.OOMKilled,
      started_at: row.State.StartedAt,
      finished_at: row.State.FinishedAt,
      health: row.State.Health?.Status,
      ...mark(),
    };
  };
  const inspectIdentity = () => inspectOwned(identityID, "identity-service");
  try {
    identityID = await docker(compose(["ps", "-q", "identity-service"]));
    assert.match(identityID, /^[a-f0-9]{64}$/u);
    evidence.identity.before = await inspectIdentity();
    assert(evidence.identity.before.running);
    const { client: prep } = await login(member, "prep-login");
    const preparer = connectOwner(
      config.gateway,
      agentID,
      prep.cookie,
      signal,
      { captureWire: true, injectTraceParent: false },
    );
    connections.push(preparer);
    evidence.prep_wire = preparer.wire;
    await preparer.initialize();
    const sessionID = (
      await preparer.request("new", { cwd: "/workspace", mcpServers: [] })
    ).sessionId;
    assert(sessionID);
    evidence.session_id = sessionID;
    const prepared = await preparer.request(
      "prompt",
      {
        sessionId: sessionID,
        prompt: [{ type: "text", text: "c4-browser-write" }],
      },
      120000,
    );
    assert.equal(prepared.stopReason, "end_turn");
    await preparer.closeAndWait();
    evidence.prep_wire = preparer.wire;
    const sessionPath = `${base}/sessions/${encodeURIComponent(sessionID)}`;
    const initial = await http(prep, `${sessionPath}/view`, {
      label: "prep-view",
    });
    const configured = await http(prep, `${sessionPath}/configuration`, {
      label: "set-auto-mode",
      body: {
        configId: "mode",
        value: "auto",
        expectedConfigurationToken: initial.body.configurationToken,
      },
    });
    assert.equal(
      configured.body.configOptions.find((item) => item.id === "mode")
        ?.currentValue,
      "auto",
    );
    // New processes provide a conservative lower bound for their in-memory
    // key caches; subsequent successful admissions prove that keys were loaded.
    console.log(
      JSON.stringify({
        phase: "outage",
        check: "prepare-fresh-consumer-admissions",
      }),
    );
    for (const service of ["agent-acp-service", "agent-ui"]) {
      const id = await docker(compose(["ps", "-q", service]));
      assert.match(id, /^[a-f0-9]{64}$/u);
      const row = {
        service,
        before: await inspectOwned(id, service),
        started_at: performance.now(),
      };
      evidence.consumer_restarts.push(row);
      await docker(["restart", "--time", "1", id]);
      row.after = await poll(
        async () => {
          const state = await inspectOwned(id, service);
          return state.running && state.health === "healthy" && state;
        },
        `${service} new process ready`,
        signal,
        15000,
      );
    }
    const { client, response: session } = await login(member, "warm-login");
    const { client: administrator, response: adminSession } = await login(
      admin,
      "audit-login",
    );
    evidence.session_deadlines = {
      owner: session.body,
      admin: adminSession.body,
    };
    assert.equal(
      adminSession.body.principal.organization_id,
      session.body.principal.organization_id,
    );
    const acpStarted = evidence.consumer_restarts.find(
      (row) => row.service === "agent-acp-service",
    ).after.started_at;
    const synchronization = await poll(
      async () => {
        const row = await http(
          administrator,
          "/api/admin/execution-synchronization",
          {
            label: "fresh-configuration-acknowledgement",
          },
        );
        const value = row.body.synchronization;
        return (
          value &&
          value.revision === value.applied_revision &&
          Date.parse(value.applied_at) > Date.parse(acpStarted) &&
          row
        );
      },
      "new ACP process configuration acknowledgement",
      signal,
      10000,
    );
    const state = await http(
      client,
      `/api/app/agents/${encodeURIComponent(agentID)}/state`,
      {
        label: "fresh-consumer-agent-ready",
      },
    );
    evidence.consumer_configuration = { synchronization, state };
    assert.equal(state.body.agent_id, agentID);
    assert.equal(state.body.access_allowed, true);
    assert.equal(state.body.availability, "ready");
    assert.equal(state.body.active_session_id, null);
    assert.equal(state.body.unavailable_reason, null);
    assert.match(state.body.configuration_revision ?? "", /^[a-f0-9]{64}$/u);
    owner = connectOwner(config.gateway, agentID, client.cookie, signal, {
      captureWire: true,
      injectTraceParent: false,
    });
    connections.push(owner);
    const capabilities = { intentReceipt: 1, targetCancel: 1, deliveryMark: 1 };
    const initialized = await owner.initialize({
      "antnest.dev/bridge": capabilities,
    });
    for (const [key, value] of Object.entries(capabilities))
      assert.equal(
        initialized._meta?.["antnest.dev/bridge"]?.[key],
        value,
        `ACP capability ${key}`,
      );
    await owner.request("load", {
      sessionId: sessionID,
      cwd: "/workspace",
      mcpServers: [],
    });
    const view = await http(client, `${sessionPath}/view`, {
      label: "warm-workspace-view",
    });
    stream = await observeWorkspaceStream(client, agentID, sessionID, signal);
    await stream.wait((value) => value.selectedView?.sessionId === sessionID);
    const intentID = randomUUID();
    await http(client, `${sessionPath}/prompts`, {
      label: "outage-prompt",
      status: 202,
      headers: {
        "If-Match": view.body.historyToken,
        "Idempotency-Key": intentID,
      },
      body: {
        intentId: intentID,
        expectedAppendVersion: view.body.appendVersion,
        prompt: [{ type: "text", text: outagePhase }],
      },
    });
    const accepted = await stream.wait((value) =>
      value.operations.some(
        (operation) =>
          operation.operationId === intentID &&
          operation.acceptance === "acp" &&
          operation.runId &&
          ["accepted", "running"].includes(operation.phase),
      ),
    );
    const heldRun = observedHeldRun(accepted.view, agentID, sessionID);
    assert.equal(heldRun.operationId, intentID);
    evidence.run_id = heldRun.runId;
    evidence.model_started = await poll(async () => {
      const value = await model();
      const rows = value.state.requests.filter(
        (row) => row.phase === outagePhase,
      );
      return (
        rows.length === 1 &&
        rows[0].stage === "tool" &&
        value.state.pending.includes(outagePhase) &&
        value
      );
    }, "first model held");
    const auditPath = `/api/admin/execution-audits/${encodeURIComponent(heldRun.runId)}`;
    const prewarm = await http(administrator, auditPath, {
      label: "warm-console-audit",
    });
    assert.equal(prewarm.body.run_id, heldRun.runId);
    await owner.request("list", {});
    await http(client, `${sessionPath}/view`, { label: "warm-workspace-hit" });
    stream.assertOpen();
    assert.equal(owner.closeCode, undefined);
    evidence.identity.stop_started_at = performance.now();
    console.log(JSON.stringify({ phase: "outage", check: "stop-identity" }));
    await docker(["stop", "--time", "1", identityID]);
    stopped = true;
    evidence.identity.stopped = await inspectIdentity();
    assert.equal(evidence.identity.stopped.running, false);
    const windowSignal = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
    const after = stream.records.length;
    const started_at = performance.now();
    const response = await fetch(`${config.model}/release/${outagePhase}`, {
      method: "POST",
      signal: windowSignal,
    });
    await response.arrayBuffer();
    evidence.release = { started_at, ...mark(), status: response.status };
    assert.equal(response.status, 200);
    const delivered = await poll(
      () => outageDelivery(owner.wire, sessionID, heldRun.runId, started_at),
      "new WSS model output",
      windowSignal,
      5000,
    );
    await stream.wait(
      (value) =>
        outageOutput(
          value,
          agentID,
          sessionID,
          heldRun.runId,
          delivered.sequence,
        ),
      {
        after,
        timeoutMS: Math.max(
          1,
          5000 - (performance.now() - evidence.identity.stopped.at),
        ),
      },
    );
    stream.assertOpen();
    assert.equal(owner.closeCode, undefined);
    evidence.model_held = await poll(
      async () => {
        const value = await model(windowSignal);
        const rows = value.state.requests.filter(
          (row) => row.phase === outagePhase,
        );
        return (
          rows.length === 2 &&
          rows[1].stage === "reply" &&
          value.state.pending.includes(outagePhase) &&
          value
        );
      },
      "second model held after real read",
      windowSignal,
      5000,
    );
    evidence.cancel_at = performance.now();
    await owner.cancel(sessionID, heldRun.runId);
    evidence.model_cancelled = await poll(
      async () => {
        const value = await model(windowSignal);
        return (
          value.state.requests.find(
            (row) =>
              row.phase === outagePhase &&
              row.stage === "reply" &&
              row.disconnected === true,
          ) && value
        );
      },
      "second model cancelled",
      windowSignal,
      5000,
    );
    await stream.wait(
      (value) => outageTerminal(value, agentID, sessionID, heldRun.runId),
      {
        after,
        timeoutMS: Math.max(
          1,
          5000 - (performance.now() - evidence.identity.stopped.at),
        ),
      },
    );
    evidence.audit = await poll(
      async () => {
        const value = await http(administrator, auditPath, {
          label: "stopped-terminal-audit",
          requestSignal: windowSignal,
        });
        return (
          value.body.state === "cancelled" &&
          value.body.executor_state === "quiescent" &&
          value
        );
      },
      "durable cancelled audit",
      windowSignal,
      5000,
    );
    await delay(
      Math.max(0, evidence.identity.stopped.at + 5000 - performance.now()),
      undefined,
      { signal },
    );
    evidence.identity.stopped_end = await inspectIdentity();
    stream.assertOpen();
    assert.equal(owner.closeCode, undefined);
    evidence.identity.restart_started_at = performance.now();
    evidence.identity.restart_started_at_ms = Date.now();
    await docker(["start", identityID]);
    stopped = false;
    evidence.identity.after = await inspectIdentity();
    write();
    result = inspectOutageWindow(evidence);
    evidence.business_window = result;
    evidence.consumer_key_budget = inspectFreshConsumerWindow(evidence);
    console.log(
      JSON.stringify({
        phase: "outage",
        check: "same-run-business-window-passed",
        ...result,
      }),
    );
    await poll(
      async () => {
        const state = await inspectIdentity();
        evidence.identity.healthy = state;
        return state.running && state.health === "healthy";
      },
      "Identity recovery health",
      signal,
      30000,
    );
    await http(client, `${sessionPath}/view`, {
      label: "recovered-workspace-view",
    });
    result = {
      ...result,
      consumer_key_budget: evidence.consumer_key_budget,
      pending: [
        "cache-cct-feed-budget-traces",
        "cold-and-expired-http",
        "recovery-revocations",
        "strict-trace-admission",
      ],
    };
  } catch (error) {
    problem = error;
    evidence.failure = { message: error.message, stack: error.stack };
    throw error;
  } finally {
    const errors = [];
    if (stream)
      try {
        await stream.closeAndWait();
      } catch (error) {
        errors.push(error);
      }
    for (const connection of connections)
      try {
        const closed = await connection.closeAndWait();
        if (connection === owner) {
          evidence.wss_close = closed;
          if (evidence.identity.restart_started_at_ms)
            assert(
              closed.at >= evidence.identity.restart_started_at_ms,
              "WSS closed before restart",
            );
        }
      } catch (error) {
        errors.push(error);
      }
    if (stopped && !signal.aborted)
      try {
        evidence.identity.cleanup_restart = mark();
        await docker(["start", identityID]);
      } catch (error) {
        errors.push(error);
      }
    write();
    // Public observers do not own the Bridge's internal ACP HTTP watches.
    // Drain this batch's UI only after business/recovery observations finish,
    // so the real watch SERVER spans can end before raw closure collection.
    if (!signal.aborted && evidence.http.length)
      try {
        const id = await docker(compose(["ps", "-q", "agent-ui"]));
        assert.match(id, /^[a-f0-9]{64}$/u);
        evidence.ui_drain = {
          before: await inspectOwned(id, "agent-ui"),
          started_at: performance.now(),
        };
        if (evidence.identity.restart_started_at)
          assert(
            evidence.ui_drain.started_at > evidence.identity.restart_started_at,
          );
        await docker(["stop", "--time", "30", id]);
        const after = await inspectOwned(id, "agent-ui");
        evidence.ui_drain.after = after;
        assert.equal(after.started_at, evidence.ui_drain.before.started_at);
        assert.equal(after.running, false);
        assert.equal(after.restarting, false);
        assert.equal(after.oom_killed, false);
        assert.equal(
          after.exit_code,
          0,
          "Bridge did not finish graceful shutdown",
        );
      } catch (error) {
        errors.push(error);
      }
    write();
    if (!signal.aborted && evidence.http.length)
      try {
        console.log(
          JSON.stringify({ phase: "outage", check: "archive-outage-traces" }),
        );
        evidence.trace_evidence = await collectOutageTraceArchive(
          config.jaeger,
          evidence,
          secrets,
          { signal, directory: output },
        );
      } catch (error) {
        errors.push(error);
      }
    if (errors.length)
      evidence.finalization_errors = errors.map(
        (error) => error.stack ?? String(error),
      );
    write();
    if (errors.length && !problem)
      throw new AggregateError(errors, "outage evidence finalization failed");
  }
  return { ...result, trace_evidence: evidence.trace_evidence };
}
