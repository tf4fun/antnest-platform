import { readReliabilityEvents as eventsOf } from "./reliability-events.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  assertRuntimeStorage,
  waitForDeletedRuntimeResources,
} from "./failure.mjs";
import { journalReader, serviceContainer } from "./recovery-support.mjs";
import {
  assertCancellationEvidence,
  assertDeleteCleanupEvidence,
  assertFailedCreateEvidence,
  assertGCEvidence,
  assertGCProtectedAgent,
  cancelDeleteRequestID,
  gcDeleteRequestID,
} from "./reliability-evidence.mjs";

const OPERATION_BUDGET = 90000;
const POLL_INTERVAL = 250;
const PROXY_CONTROL_TIMEOUT = 10000;
const PROXY_INNER_TIMEOUT = 5;

async function waitFor(
  read,
  check,
  { signal, timeout = OPERATION_BUDGET } = {},
) {
  const deadline = AbortSignal.timeout(timeout);
  const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const endAt = Date.now() + timeout;
  let last;
  while (true) {
    bounded.throwIfAborted();
    last = await read({
      timeoutMs: Math.max(1, Math.min(15000, endAt - Date.now())),
    });
    bounded.throwIfAborted();
    if (check(last)) return last;
    await delay(POLL_INTERVAL, undefined, { signal: bounded });
  }
}

// Private controls reach the proxy through the owned Compose service — the
// Node runner is on the host and cannot resolve the private container DNS.
function proxyExec(config, docker, signal, expression) {
  return async () => {
    const id = (
      await docker(config.compose(["ps", "-aq", "reliability-proxy"]), false, {
        signal,
        timeoutMS: PROXY_CONTROL_TIMEOUT,
      })
    ).trim();
    assert(id, "reliability-proxy container must exist");
    const row = JSON.parse(
      await docker(["inspect", id], false, {
        signal,
        timeoutMS: PROXY_CONTROL_TIMEOUT,
      }),
    )[0];
    assert.equal(
      row?.Config?.Labels?.["com.docker.compose.project"],
      config.project,
      "reliability-proxy must belong to the owned project",
    );
    assert.equal(
      row?.Config?.Labels?.["com.docker.compose.service"],
      "reliability-proxy",
      "reliability-proxy must be the owned fixture service",
    );
    const script =
      `const c=new AbortController();` +
      `const t=setTimeout(()=>c.abort(),${PROXY_INNER_TIMEOUT * 1000});` +
      `try{const r=await fetch("http://127.0.0.1:8080${expression.path}",{method:${JSON.stringify(expression.method ?? "GET")},body:${JSON.stringify(expression.body)} ?? undefined,signal:c.signal});` +
      `if(r.status!==200){process.stderr.write("proxy control "+r.status);process.exit(1);}` +
      `process.stdout.write(await r.text());}` +
      `finally{clearTimeout(t);}`;
    const out = await docker(
      ["exec", id, "node", "-e", `(async()=>{${script}})()`],
      false,
      { signal, timeoutMS: PROXY_CONTROL_TIMEOUT },
    );
    return out.trim();
  };
}

async function proxyControl(config, docker, signal, pathname) {
  const run = proxyExec(config, docker, signal, {
    path: pathname,
    method: "POST",
    body: "{}",
  });
  const response = JSON.parse(await run());
  return response;
}

async function proxyStatus(config, docker, signal) {
  const run = proxyExec(config, docker, signal, {
    path: "/__test/status",
    method: "GET",
  });
  return JSON.parse(await run());
}

async function waitForHeld(config, docker, signal, agentID) {
  return waitFor(
    () => proxyStatus(config, docker, signal),
    (status) => status.held >= 1 && (!agentID || status.agent_id === agentID),
    { signal },
  );
}

async function operationAt(json, requestID, { timeoutMs } = {}) {
  return json(`/api/admin/operations/${encodeURIComponent(requestID)}`, {
    timeoutMs,
  });
}

// operationMaybe returns null for the not-yet-admitted deterministic child IDs
// without swallowing auth/conflict/transport failures.
async function operationMaybe(api, requestID, { timeoutMs } = {}) {
  const response = await api(
    `/api/admin/operations/${encodeURIComponent(requestID)}`,
    {
      status: [200, 404],
      timeoutMs,
    },
  );
  return response.status === 200 ? response.body : null;
}

async function admit(api, pathname, body, extra = {}) {
  const key = randomUUID();
  const response = await api(pathname, {
    body,
    status: 202,
    headers: { "Idempotency-Key": key },
    ...extra,
  });
  assert.equal(response.status, 202, `${pathname} must admit with 202`);
  return { body: response.body, key };
}

export async function runReliability({
  config,
  docker,
  signal,
  api,
  json,
  agentBody,
  resources,
  ready,
}) {
  const cases = [];
  const postgres = await serviceContainer(docker, config.project, "postgres");
  const journal = journalReader(docker, postgres.Id);
  const physical = (agentID) => resources(agentID);
  const egress = (agentID) => journal.egressClosed(agentID);

  // ---------------------------------------------------- case 1: rebuild retry
  let egressContainer;
  try {
    egressContainer = await serviceContainer(
      docker,
      config.project,
      "runtime-egress",
    );
    await docker(["stop", egressContainer.Id]);
    try {
      const create = await admit(api, "/api/admin/agents", agentBody);
      const created = create.body;
      const agentID = created.agent.agent_id;
      const createRequestID = created.operation.request_id;
      const failed = await waitFor(
        (budget) => operationAt(json, createRequestID, budget),
        (op) => op.state === "failed",
        { signal },
      );
      const agentNow = await json(
        `/api/admin/agents/${encodeURIComponent(agentID)}`,
      );
      assertFailedCreateEvidence(
        {
          operation: failed,
          agent: agentNow,
          events: await eventsOf(json, journal, agentID),
        },
        {
          agentID,
          requestID: createRequestID,
          phase: "network_ensure",
          errorCode: "phase_deadline_exceeded",
        },
      );
      cases.push({
        name: "failed-create-deadline",
        agent_id: agentID,
        request_id: createRequestID,
      });
      // Replay the exact original create (same body + Idempotency-Key): the
      // service must return the SAME failed Agent/request, never a fresh op.
      const replay = await api("/api/admin/agents", {
        body: agentBody,
        status: 202,
        headers: { "Idempotency-Key": create.key },
      });
      assert.equal(replay.status, 202);
      assert.equal(
        replay.body.agent.agent_id,
        agentID,
        "the failed-create replay must return the same Agent",
      );
      assert.equal(
        replay.body.operation.request_id,
        createRequestID,
        "the failed-create replay must return the same request",
      );
      assert.equal(replay.body.operation.state, "failed");
      assert.equal(replay.body.operation.error_code, "phase_deadline_exceeded");
      assert(!replay.body.agent.active_operation_request_id);
      assert(!replay.body.agent.executable_execution_revision);

      await docker(["start", egressContainer.Id]);
      await waitFor(
        () => serviceContainer(docker, config.project, "runtime-egress"),
        (container) =>
          container.State?.Running === true &&
          container.State?.Health?.Status === "healthy",
        { signal },
      );
      const rebuildAdmit = await admit(
        api,
        `/api/admin/agents/${encodeURIComponent(agentID)}/rebuild`,
        {
          template_id: agentBody.template_id,
          template_revision: agentBody.template_revision,
        },
      );
      const rebuild = rebuildAdmit.body;
      const completed = await waitFor(
        (budget) => operationAt(json, rebuild.request_id, budget),
        (op) => op.state === "completed",
        { signal },
      );
      assert.equal(completed.kind, "rebuild");
      const marker = await journal.ac(rebuild.request_id);
      assert.equal(
        marker.source_failed_create_request_id,
        createRequestID,
        "the rebuild must carry the failed-create retry marker",
      );
      const observed = await ready(agentID);
      assert.equal(
        observed.agent.agent_id,
        agentID,
        "rebuild must target the same Agent",
      );
      assert(observed.container?.Id, "rebuild must produce a real container");
      cases.push({
        name: "failed-create-rebuild-ready",
        agent_id: agentID,
        request_id: rebuild.request_id,
      });

      const deletedAdmit = await admit(
        api,
        `/api/admin/agents/${encodeURIComponent(agentID)}/delete`,
        {},
      );
      const deleted = deletedAdmit.body;
      await waitFor(
        (budget) => operationAt(json, deleted.request_id, budget),
        (op) => op.state === "completed",
        { signal },
      );
      await waitForDeletedRuntimeResources(() => physical(agentID), { signal });
      assertDeleteCleanupEvidence(
        {
          operation: await operationAt(json, deleted.request_id),
          events: await eventsOf(json, journal, agentID),
          physical: await physical(agentID),
          egress: await egress(agentID),
        },
        { agentID, requestID: deleted.request_id },
      );
      cases.push({ name: "recovered-delete-cleaned", agent_id: agentID });
    } finally {
      await docker(["start", egressContainer.Id]).catch(() => {});
    }
  } catch (error) {
    throw error;
  }

  // --------------------------------------------- case 2: held cancel + delete
  try {
    await proxyControl(config, docker, signal, "/__test/arm");
    const create = await admit(api, "/api/admin/agents", agentBody);
    const created = create.body;
    const agentID = created.agent.agent_id;
    const createRequestID = created.operation.request_id;
    await waitForHeld(config, docker, signal, agentID);
    const runtimeChild = await journal.ac(createRequestID);
    assert.equal(
      runtimeChild.phase,
      "runtime_initialize",
      "the held create must sit in runtime_initialize",
    );
    assert(
      runtimeChild.child_request_id,
      "the Runtime child request must exist before termination",
    );
    const physicalBefore = await physical(agentID);
    assertRuntimeStorage(physicalBefore, agentID);
    const cancel = await api(
      `/api/admin/agents/${encodeURIComponent(agentID)}/lifecycle-operation/cancel`,
      { body: { operation_request_id: createRequestID }, status: 202 },
    );
    assert.equal(cancel.status, 202);
    const childRequestID = cancelDeleteRequestID(createRequestID);
    const cancelled = await waitFor(
      (budget) => operationAt(json, createRequestID, budget),
      (op) => op.state === "failed",
      { signal },
    );
    await waitFor(
      (budget) => operationMaybe(api, childRequestID, budget),
      (op) => op && op.state === "completed",
      { signal },
    );
    await waitForDeletedRuntimeResources(() => physical(agentID), { signal });
    await waitFor(
      async () => (await proxyStatus(config, docker, signal)).records,
      (all) => all.some((record) => record.delivery === "caller_disconnected"),
      { signal },
    );
    const proxyState = await proxyStatus(config, docker, signal);
    const events = await eventsOf(json, journal, agentID);
    assertCancellationEvidence(
      { operation: cancelled, events, proxy: proxyState },
      {
        agentID,
        requestID: createRequestID,
        childRequestID,
        runtimeRequestID: runtimeChild.child_request_id,
      },
    );
    assertDeleteCleanupEvidence(
      {
        operation: await operationAt(json, childRequestID),
        events,
        physical: await physical(agentID),
        egress: await egress(agentID),
      },
      { agentID, requestID: childRequestID },
    );
    await proxyControl(config, docker, signal, "/__test/release");
    cases.push({
      name: "cancel-held-initialize",
      agent_id: agentID,
      request_id: createRequestID,
    });
  } catch (error) {
    await proxyControl(config, docker, signal, "/__test/release").catch(
      () => {},
    );
    throw error;
  }

  // --------------------------------------------------- case 3: GC + control
  let controlID;
  try {
    const controlAdmit = await admit(api, "/api/admin/agents", agentBody);
    const control = controlAdmit.body;
    controlID = control.agent.agent_id;
    const controlReady = await ready(controlID);
    const controlBefore = {
      agent: await json(`/api/admin/agents/${encodeURIComponent(controlID)}`),
      physical: await physical(controlID),
      events: await eventsOf(json, journal, controlID),
    };
    assert(controlReady.container?.Id, "control must have a real container");
    config.env.ANTNEST_RELIABILITY_FAILED_CREATE_TTL = "2s";
    await docker(
      config.compose([
        "up",
        "--no-deps",
        "--force-recreate",
        "--wait",
        "--wait-timeout",
        "180",
        "agent-controller",
      ]),
    );
    await proxyControl(config, docker, signal, "/__test/arm");
    const create = await admit(api, "/api/admin/agents", agentBody);
    const created = create.body;
    const agentID = created.agent.agent_id;
    const createRequestID = created.operation.request_id;
    await waitForHeld(config, docker, signal, agentID);
    const runtimeChild = await journal.ac(createRequestID);
    assert.equal(runtimeChild.phase, "runtime_initialize");
    const physicalBefore = await physical(agentID);
    assertRuntimeStorage(physicalBefore, agentID);
    const failedCreate = await waitFor(
      (budget) => operationAt(json, createRequestID, budget),
      (op) =>
        op.state === "failed" && op.error_code === "phase_deadline_exceeded",
      { signal },
    );
    const gcDeleteID = gcDeleteRequestID(createRequestID);
    const gcDelete = await waitFor(
      (budget) => operationMaybe(api, gcDeleteID, budget),
      (op) => op && op.state === "completed",
      { signal },
    );
    assert.equal(gcDelete.kind, "delete", "GC must schedule a normal delete");
    await waitForDeletedRuntimeResources(() => physical(agentID), { signal });
    const events = await eventsOf(json, journal, agentID);
    assertGCEvidence(
      { operation: failedCreate, events },
      { agentID, createRequestID },
    );
    assertDeleteCleanupEvidence(
      {
        operation: gcDelete,
        events,
        physical: await physical(agentID),
        egress: await egress(agentID),
      },
      { agentID, requestID: gcDeleteID },
    );
    const controlAfter = {
      agent: await json(`/api/admin/agents/${encodeURIComponent(controlID)}`),
      physical: await physical(controlID),
      events: await eventsOf(json, journal, controlID),
    };
    assertGCProtectedAgent(controlBefore, controlAfter);
    const controlDeleteAdmit = await admit(
      api,
      `/api/admin/agents/${encodeURIComponent(controlID)}/delete`,
      {},
    );
    const controlDelete = controlDeleteAdmit.body;
    await waitFor(
      (budget) => operationAt(json, controlDelete.request_id, budget),
      (op) => op.state === "completed",
      { signal },
    );
    await waitForDeletedRuntimeResources(() => physical(controlID), { signal });
    await proxyControl(config, docker, signal, "/__test/release");
    cases.push({
      name: "gc-held-deadline",
      agent_id: agentID,
      request_id: createRequestID,
    });
  } catch (error) {
    await proxyControl(config, docker, signal, "/__test/release").catch(
      () => {},
    );
    if (controlID) {
      await api(`/api/admin/agents/${encodeURIComponent(controlID)}/delete`, {
        body: {},
        status: 202,
      }).catch(() => {});
    }
    throw error;
  }

  return { profile: "lifecycle-reliability", cases, traces: [] };
}
