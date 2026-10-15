import assert from "node:assert/strict";
import { assertOutageAdmission } from "../../support/resolve-cache-admission.mjs";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { assertSecretFree } from "../identity-closeout/evidence.mjs";
import { gatewayOrigin } from "../../support/gateway-origin.mjs";
import { writeEvidenceFile } from "../../support/storage.mjs";
import { member } from "../workspace-closeout/c4-setup.mjs";
import { observedHeldRun } from "../workspace-closeout/browser-control.mjs";
import { waitForAgentReady } from "../../support/verification/agent-state.mjs";
import { groupAlive, processStat } from "../workspace-closeout/process.mjs";
import { cacheRuntimePhase } from "../workspace-closeout/cache-runtime-work.mjs";
import {
  createCacheRuntimeWork,
  pollOutageObservation,
} from "./resolve-cache-runtime-work.mjs";
import {
  bridgeRuntimeTurn,
  hasBridgeRuntimeOutput,
} from "./resolve-cache-bridge-outage.mjs";
import { observeWorkspaceStream } from "./resolve-cache-stream.mjs";
import { collectOutageTraceArchive } from "./resolve-cache-outage-collect.mjs";
import { shortenIdleSession } from "./resolve-cache-expiry-fixture.mjs";
import { createOutageRunSnapshotReader } from "./resolve-cache-run-snapshot.mjs";
import { prepareOutageAdmissions } from "./resolve-cache-outage-preparation.mjs";
import { verifyRecovery } from "./resolve-cache-recovery-flow.mjs";
import { rebuildRecoveryAgent } from "./resolve-cache-rebuild.mjs";
import { captureOutageACPClock } from "./resolve-cache-outage-clock.mjs";
import {
  inspectOutageWindow,
  inspectFreshConsumerWindow,
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
  requestTimeoutMS,
}) {
  assert.equal(settings.resolveTTLMS, 10000);
  assert.equal(settings.captureRpcContent, false);
  assert.equal(requestTimeoutMS, 2000);
  const agentID = fixture.agentID,
    base = `/api/app/workspace/v1/agents/${encodeURIComponent(agentID)}`;
  const evidence = {
    policy_revision: 4,
    transport: "http-sse",
    project: config.project,
    agent_id: agentID,
    settings,
    http: [],
    model_observations: [],
    identity: {},
    consumer_restarts: [],
    rejections: { request_timeout_ms: requestTimeoutMS },
    ...mark(),
  };
  const secrets = [member.password, admin.password, "stage3-model-secret"];
  // This opaque observation ID is assigned to the Cookie actually dispatched.
  // Never persist a Cookie, SID, hash, or a new production correlation header.
  const credentialScopes = new Map();
  const credentialScope = (cookie) => {
    if (!cookie) return null;
    if (!credentialScopes.has(cookie))
      credentialScopes.set(cookie, randomUUID());
    return credentialScopes.get(cookie);
  };
  let stream,
    runtimeWork,
    activeClient,
    activeSessionPath,
    identityID,
    stopped = false,
    rejectionWork,
    problem,
    result;
  const write = () => {
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
    const cookie = client.cookie;
    const started_at = performance.now();
    const response = await fetch(client.base + path, {
      method,
      redirect: "manual",
      signal: AbortSignal.any([requestSignal, AbortSignal.timeout(15000)]),
      headers: {
        "Content-Type": "application/json",
        Origin: gatewayOrigin(client.base),
        "X-Antnest-CSRF-Token": client.csrf,
        "Idempotency-Key": randomUUID(),
        ...headers,
        Cookie: cookie,
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
      credential_scope: credentialScope(cookie),
      method,
      path,
      started_at,
      ...mark(),
      status: response.status,
      trace_id: response.headers.get("x-antnest-trace-id"),
      server_date: response.headers.get("date"),
      cache_control: response.headers.get("cache-control"),
      set_cookie_count: response.headers.getSetCookie().length,
      body: text ? JSON.parse(text) : null,
    };
    assertSecretFree(JSON.stringify(row), secrets);
    evidence.http.push(row);
    assert(
      [status].flat().includes(row.status),
      `${label}: HTTP ${row.status}`,
    );
    assert.match(row.trace_id ?? "", /^[a-f0-9]{32}$/u);
    return row;
  };
  const login = async (credentials, label) => {
    const client = new GatewayClient(config.gateway);
    const response = await http(client, "/api/session/login", {
      body: credentials,
      label,
    });
    response.issued_credential_scope = credentialScope(client.cookie);
    secrets.push(client.cookie);
    return { client, response };
  };
  const poll = async (
    check,
    label,
    requestSignal = signal,
    timeoutMS = 15000,
    intervalMS = 25,
  ) =>
    pollOutageObservation(check, label, requestSignal, timeoutMS, intervalMS);
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
      host_name: row.Config.Hostname,
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
    const { client: prep, response: prepSession } = await login(
      member,
      "prep-login",
    );
    const created = await http(prep, `${base}/sessions`, {
      body: {},
      status: 201,
      label: "prep-session-create",
    });
    const sessionID = created.body.sessionId;
    assert(sessionID);
    evidence.session_id = sessionID;
    const sessionPath = `${base}/sessions/${encodeURIComponent(sessionID)}`;
    activeSessionPath = sessionPath;
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
    // Setup created this second Agent before Gateway's short outage budget.
    // Recheck it using the independent admin; the later warm member Cookie
    // never visits this Agent before the actual cold-scope rejection.
    const coldAgentID = fixture.coldAgentID;
    assert(typeof coldAgentID === "string" && coldAgentID.length > 0);
    assert.equal(fixture.coldAgentSetup?.agent_id, coldAgentID);
    assert.equal(fixture.coldAgentSetup.owner_user_id, fixture.ownerID);
    assert.equal(fixture.coldAgentSetup.request_timeout_ms, 150000);
    evidence.cold_agent_setup = fixture.coldAgentSetup;
    evidence.cold_agent = await waitForAgentReady(
      () =>
        fixture.json(`/api/admin/agents/${encodeURIComponent(coldAgentID)}`),
      signal,
    );
    assert.equal(evidence.cold_agent.agent_id, coldAgentID);
    assert.notEqual(coldAgentID, agentID);
    assert.equal(evidence.cold_agent.owner_user_id, fixture.ownerID);
    // These new tokens have never resolved a profile. Prepare them before
    // starting the consumer key-cache budget, and keep their cookies separate.
    const { client: coldConsole } = await login(admin, "cold-console-login");
    const { client: coldWorkspace } = await login(
      member,
      "cold-workspace-login",
    );
    const { client: shortSession, response: shortLogin } = await login(
      member,
      "short-idle-login",
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
      };
      if (service === "agent-acp-service")
        await captureOutageACPClock({
          before: row.before,
          inspectOwned,
          environment: config.env,
          signal,
          record: (probe) => {
            evidence.acp_clock_probe = probe;
          },
        });
      row.started_at = performance.now();
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
    const admission = await prepareOutageAdmissions({
      evidence,
      agentID,
      ownerCredentials: member,
      adminCredentials: admin,
      prepPrincipal: prepSession.body.principal,
      prepClient: prep,
      login,
      http,
      poll,
      docker,
      config,
      signal,
    });
    const { client, session, administrator, adminSession } = admission;
    runtimeWork = admission.runtimeWork;
    activeClient = client;
    const view = await http(client, `${sessionPath}/view`, {
      label: "warm-workspace-view",
    });
    stream = await observeWorkspaceStream(client, agentID, sessionID, signal, {
      credentialScope,
    });
    await stream.wait((value) => value.selectedView?.sessionId === sessionID);
    const intentID = randomUUID();
    evidence.intent_id = intentID;
    const promptBody = {
      intentId: intentID,
      expectedAppendVersion: view.body.appendVersion,
      prompt: [{ type: "text", text: cacheRuntimePhase }],
    };
    evidence.prompt = await http(client, `${sessionPath}/prompts`, {
      label: "outage-prompt",
      status: 202,
      headers: {
        "If-Match": view.body.historyToken,
        "Idempotency-Key": intentID,
      },
      body: promptBody,
    });
    evidence.prompt.request = promptBody;
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
        (row) => row.phase === cacheRuntimePhase,
      );
      return (
        rows.length === 1 &&
        rows[0].stage === "tool" &&
        !value.state.pending.includes(cacheRuntimePhase) &&
        value
      );
    }, "one model response dispatched real bash");
    evidence.runtime.started = await poll(async (samplingSignal) => {
      const value = await runtimeWork.observe({ signal: samplingSignal });
      return (
        value.work.pid &&
        value.work.stat &&
        value.work.effects === "started\n" &&
        processStat(value.work.stat).state !== "Z" &&
        groupAlive(value.work.processes, value.work.pgid) &&
        value
      );
    }, "actual held Runtime process group");
    const toolStarted = await stream.wait((value) => {
      const turn = bridgeRuntimeTurn(value, evidence);
      return (
        turn?.outcome === "running" &&
        turn.liveProcessDelta?.items.some(
          ({ item }) => item.kind === "tool" && item.status === "running",
        )
      );
    });
    const tools = bridgeRuntimeTurn(
      toolStarted.view,
      evidence,
    ).liveProcessDelta.items.filter(
      ({ item }) => item.kind === "tool" && item.status === "running",
    );
    assert.equal(tools.length, 1);
    evidence.runtime.tool_id = tools[0].item.id;
    const runSnapshot = await createOutageRunSnapshotReader({
      project: config.project,
      compose,
      docker,
      signal,
      scope: {
        run_id: heldRun.runId,
        session_id: sessionID,
        agent_id: agentID,
        principal_id: session.body.principal.user_id,
        organization_id: session.body.principal.organization_id,
        bridge_intent_id: intentID,
        execution_revision: evidence.runtime.execution_revision,
        runtime_revision: evidence.runtime.runtime_revision,
        runtime_execution_id: evidence.runtime.runtime_execution_id,
      },
    });
    evidence.run_storage = runSnapshot.evidence;
    const idleFixture = await shortenIdleSession({
      project: config.project,
      compose,
      docker,
      token: shortSession.accessToken,
      principal: shortLogin.body.principal,
      idleMS: 2000,
      secrets,
      protectedTokens: [client.accessToken, administrator.accessToken],
      otherMembership: adminSession.body.principal.membership_id,
    });
    evidence.rejections.expired_session = idleFixture.evidence;
    idleFixture.evidence.credential_scope = credentialScope(
      shortSession.cookie,
    );
    await http(shortSession, "/api/session", { label: "short-idle-warm" });
    await idleFixture.read("after-warm");
    await http(shortSession, "/api/session", { label: "short-idle-hit" });
    const shortIdle = await idleFixture.read("after-hit");
    assert(!shortIdle.expired && shortIdle.remaining_ms > 0);
    const auditPath = `/api/admin/execution-audits/${encodeURIComponent(heldRun.runId)}`;
    const prewarm = await http(administrator, auditPath, {
      label: "warm-console-audit",
    });
    assert.equal(prewarm.body.run_id, heldRun.runId);
    assert.equal(prewarm.body.state, "running");
    evidence.audit_before = prewarm;
    evidence.run_storage.before = await runSnapshot.read("before-stop");
    await http(client, `${sessionPath}/view`, { label: "warm-workspace-hit" });
    stream.assertOpen();
    console.log(JSON.stringify({ phase: "outage", check: "stop-identity" }));
    const stopMark = mark();
    evidence.identity.stop_started_at = stopMark.at;
    evidence.identity.stop_started_at_ms = stopMark.observed_at_ms;
    await docker(["stop", "--time", "1", identityID]);
    stopped = true;
    evidence.identity.stopped = await inspectIdentity();
    assert.equal(evidence.identity.stopped.running, false);
    const windowSignal = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
    const windowRemaining = () => {
      windowSignal.throwIfAborted();
      const remaining =
        5000 - (performance.now() - evidence.identity.stopped.at);
      assert(remaining > 0, "Identity outage business window timed out");
      return remaining;
    };
    const rejectionOptions = { status: 503, requestSignal: windowSignal };
    // Observe every branch immediately and join all of them, including on a
    // separate business failure. A fetch timeout never creates an HTTP row.
    rejectionWork = Promise.allSettled([
      http(coldConsole, "/api/admin/execution-synchronization", {
        ...rejectionOptions,
        label: "stopped-cold-console",
      }),
      http(coldWorkspace, `${sessionPath}/view`, {
        ...rejectionOptions,
        label: "stopped-cold-workspace",
      }),
      http(client, "/api/session", {
        ...rejectionOptions,
        label: "stopped-cold-profile",
      }),
      http(
        client,
        `/api/app/workspace/v1/agents/${encodeURIComponent(coldAgentID)}/sessions`,
        {
          ...rejectionOptions,
          label: "stopped-cold-agent",
        },
      ),
      http(new GatewayClient(config.gateway), "/api/session/login", {
        ...rejectionOptions,
        label: "stopped-new-login",
        body: member,
      }),
      (async () => {
        // The DB observation gives a conservative monotonic upper bound. Read
        // the DB again to prove expiry; no host/DB wall-clock comparison.
        await delay(
          Math.max(
            0,
            shortIdle.at + shortIdle.remaining_ms - performance.now(),
          ),
          undefined,
          { signal: windowSignal },
        );
        windowSignal.throwIfAborted();
        const expired = await idleFixture.read("expired", {
          signal: windowSignal,
          timeoutMS: windowRemaining(),
        });
        assert(expired.expired && expired.remaining_ms <= 0);
        return http(shortSession, "/api/session", {
          ...rejectionOptions,
          label: "stopped-expired-session",
        });
      })(),
    ]);
    const after = stream.records.length;
    await runtimeWork.emit({
      signal: windowSignal,
      timeoutMS: windowRemaining(),
    });
    await stream.wait((value) => hasBridgeRuntimeOutput(value, evidence), {
      after,
      timeoutMS: Math.max(
        1,
        5000 - (performance.now() - evidence.identity.stopped.at),
      ),
    });
    stream.assertOpen();
    evidence.runtime.before_cancel = await runtimeWork.observe({
      signal: windowSignal,
      timeoutMS: windowRemaining(),
    });
    assert(
      groupAlive(
        evidence.runtime.before_cancel.work.processes,
        evidence.runtime.started.work.pgid,
      ),
      "Runtime naturally finished before cancellation",
    );
    assert.equal(
      evidence.runtime.before_cancel.work.effects,
      "started\nemitted\n",
    );
    const cancelBody = { expectedRunId: heldRun.runId };
    evidence.cancel = await http(
      client,
      `${sessionPath}/operations/${encodeURIComponent(intentID)}/cancel`,
      {
        label: "outage-cancel",
        body: cancelBody,
        requestSignal: windowSignal,
      },
    );
    evidence.cancel.request = cancelBody;
    evidence.cancel_at = evidence.cancel.started_at;
    evidence.runtime.quiescent = await poll(
      async (samplingSignal) => {
        const value = await runtimeWork.observe({
          signal: samplingSignal,
          timeoutMS: windowRemaining(),
        });
        return (
          !groupAlive(
            value.work.processes,
            evidence.runtime.started.work.pgid,
          ) && value
        );
      },
      "cancelled Runtime whole process group exit",
      windowSignal,
      5000,
    );
    evidence.model_cancelled = await model(windowSignal);
    await stream.wait(
      (value) =>
        bridgeRuntimeTurn(value, evidence)?.outcome === "unknown" &&
        value.availability === "offline" &&
        value.activeSessionId === null,
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
          value.body.state === "unresolved" &&
          value.body.executor_state === "quiescent" &&
          value
        );
      },
      "durable cancelled Runtime audit",
      windowSignal,
      5000,
    );
    evidence.run_storage.after = await runSnapshot.read("after-cancel", {
      signal: windowSignal,
      timeoutMS: windowRemaining(),
    });
    const rejectionResults = await rejectionWork;
    const rejectionErrors = rejectionResults
      .filter((row) => row.status === "rejected")
      .map((row) => row.reason);
    if (rejectionErrors.length)
      throw new AggregateError(
        rejectionErrors,
        "actual outage HTTP rejection failed",
      );
    for (const { value } of rejectionResults)
      assert(
        value.at <= evidence.identity.stopped.at + 5000,
        "HTTP rejection exceeded original five-second window",
      );
    await delay(
      Math.max(0, evidence.identity.stopped.at + 5000 - performance.now()),
      undefined,
      { signal },
    );
    evidence.identity.stopped_end = await inspectIdentity();
    stream.assertOpen();
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
    await http(shortSession, "/api/session", {
      label: "recovered-expired-session",
      status: 401,
    });
    await rebuildRecoveryAgent({
      fixture,
      administrator,
      evidence,
      signal,
      http,
      readStoredRun: (label, options) => runSnapshot.read(label, options),
      observeRuntime: async (agent, options) => {
        const recovered = await createCacheRuntimeWork({
          docker,
          config,
          agent,
          principal: session.body.principal,
          readerPrincipal: adminSession.body.principal,
          signal: options.signal,
        });
        const observation = await recovered.observe(options);
        return { ...recovered.evidence, observation };
      },
    });
    write();
    evidence.recovery_window = await verifyRecovery({
      config,
      fixture,
      credentials: member,
      administrator,
      signal,
      evidence,
      secrets,
      http,
      login,
      model,
      credentialScope,
      poll: (check, label, requestSignal = signal, timeoutMS = 15000) =>
        poll(check, label, requestSignal, timeoutMS, 250),
    });
    result = {
      ...result,
      consumer_key_budget: evidence.consumer_key_budget,
      recovery: evidence.recovery_window,
    };
  } catch (error) {
    problem = error;
    evidence.failure = { message: error.message, stack: error.stack };
    throw error;
  } finally {
    const errors = [];
    if (rejectionWork) {
      const settled = await rejectionWork;
      evidence.rejections.settled = settled.map((row) => ({
        status: row.status,
        ...(row.status === "rejected"
          ? { message: row.reason.message }
          : { label: row.value.label }),
      }));
    }
    if (stream)
      try {
        await stream.closeAndWait();
      } catch (error) {
        errors.push(error);
      }
    // A failed observation cannot leave accepted real work detached. Attempt
    // the exact intent/Run cancellation and join its process group before UI
    // drain. The outer runner still removes all owned Runtime resources when
    // the global signal is aborted or this independent bounded cleanup fails.
    if (runtimeWork && evidence.run_id && !evidence.runtime.quiescent) {
      if (signal.aborted) evidence.runtime.cleanup_pending_outer_project = true;
      else
        try {
          const cleanupSignal = AbortSignal.timeout(15000);
          const cleanupDeadline = performance.now() + 15000;
          const cleanupBody = { expectedRunId: evidence.run_id };
          evidence.runtime.cleanup_cancel = await http(
            activeClient,
            `${activeSessionPath}/operations/${encodeURIComponent(evidence.intent_id)}/cancel`,
            {
              label: "cleanup-runtime-cancel",
              body: cleanupBody,
              requestSignal: cleanupSignal,
            },
          );
          evidence.runtime.cleanup_cancel.request = cleanupBody;
          evidence.runtime.cleanup_quiescent = await poll(
            async (samplingSignal) => {
              const value = await runtimeWork.observe({
                signal: samplingSignal,
                timeoutMS: Math.max(1, cleanupDeadline - performance.now()),
              });
              if (!evidence.runtime.started) return false;
              return (
                !groupAlive(
                  value.work.processes,
                  evidence.runtime.started.work.pgid,
                ) && value
              );
            },
            "failed outage Runtime cleanup",
            cleanupSignal,
            15000,
          );
        } catch (error) {
          evidence.runtime.cleanup_pending_outer_project = true;
          errors.push(error);
        }
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
  assertOutageAdmission(evidence.trace_evidence);
  return { ...result, pending: [], trace_evidence: evidence.trace_evidence };
}
