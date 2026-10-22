import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { until } from "../workspace-closeout/c4-setup.mjs";
import { rpcMessages } from "./acp-gate-responses.mjs";
import { assertPromptInventory } from "./prompt-dispatch-inventory.mjs";

const peerPhase = "c4-browser-hold-peer";
const refusedPhase = "c4-browser-window-00";
const nextPhase = "c4-browser-window-01";
const uncertainHint =
  "Message status is uncertain. Refresh this conversation to check the original operation.";
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const identity = (value) =>
  typeof value === "string" && value.length > 0 && value.length <= 200;

function busyDefinition() {
  const catalog = JSON.parse(
    readFileSync(
      new URL("../../../contracts/agent-acp/errors.json", import.meta.url),
      "utf8",
    ),
  );
  check(
    catalog.schema_version === 1 &&
      catalog.capability?.name === "antnest.dev/errors" &&
      catalog.capability.version === 1 &&
      object(catalog.errors) &&
      Object.hasOwn(catalog.errors, "agent_busy"),
    "Canonical ACP error catalog is unavailable",
  );
  const definition = catalog.errors.agent_busy;
  check(
    definition.surfaces.includes("admission") &&
      Number.isInteger(definition.json_rpc_code) &&
      definition.retryable === true &&
      definition.recovery === "backoff" &&
      Number.isInteger(definition.retry_after_ms) &&
      typeof definition.message === "string",
    "Canonical busy admission definition is invalid",
  );
  return definition;
}

function promptRequest(request, gateway, base) {
  const url = new URL(request.url());
  if (
    url.origin !== gateway ||
    request.method() !== "POST" ||
    !url.pathname.startsWith(base + "/sessions/") ||
    !url.pathname.endsWith("/prompts")
  )
    return null;
  const encoded = url.pathname.slice(
    (base + "/sessions/").length,
    -"/prompts".length,
  );
  check(encoded.length > 0 && !encoded.includes("/"), "Unexpected Prompt path");
  const sessionId = decodeURIComponent(encoded);
  const rawBody = request.postData();
  check(typeof rawBody === "string", "Original browser Prompt body is absent");
  const body = JSON.parse(rawBody);
  check(
    object(body) && identity(body.intentId) && identity(sessionId),
    "Original browser Prompt identity is invalid",
  );
  return {
    method: request.method(),
    path: url.pathname,
    sessionId,
    rawBody,
    body,
  };
}

function gatePrompt(state, intentId, sessionId) {
  const matches = state.records.flatMap((record, index) => {
    if (record.method !== "POST" || typeof record.body !== "string") return [];
    let message;
    try {
      message = JSON.parse(record.body);
    } catch {
      return [];
    }
    return message.method === "session/prompt" &&
      message.params?.sessionId === sessionId &&
      message.params?._meta?.["antnest.dev/intent"]?.intentId === intentId
      ? [{ recordIndex: index, record, message }]
      : [];
  });
  check(
    matches.length === 1,
    "Original intent was missing or dispatched again",
  );
  return matches[0];
}

function canonicalBusy(error, definition) {
  check(
    object(error) &&
      isDeepStrictEqual(Object.keys(error).sort(), [
        "code",
        "data",
        "message",
      ]) &&
      error.code === definition.json_rpc_code &&
      error.message === definition.message &&
      object(error.data),
    "Actual ACP rejection is not the canonical busy error",
  );
  const data = { ...error.data };
  if (Object.hasOwn(data, "details")) {
    check(
      object(data.details) && Object.keys(data.details).length === 0,
      "Actual ACP rejection contains unapproved details",
    );
    delete data.details;
  }
  check(
    isDeepStrictEqual(data, {
      code: "agent_busy",
      retryable: definition.retryable,
      retry_after_ms: definition.retry_after_ms,
    }),
    "Actual ACP busy recovery fields changed",
  );
}

function uncertainOperation(operation, original, definition) {
  check(
    operation?.operationId === original.body.intentId &&
      operation.sessionId === original.sessionId &&
      operation.phase === "uncertain" &&
      operation.acceptance === "unknown" &&
      operation.runId === undefined &&
      object(operation.error),
    "UI did not retain the original uncertain Prompt",
  );
  const error = operation.error;
  check(
    isDeepStrictEqual(Object.keys(error).sort(), [
      "code",
      "message",
      "operationId",
      "recovery",
      "requestId",
      "retryable",
    ]) &&
      error.code === "agent_busy" &&
      error.message === definition.message &&
      identity(error.requestId) &&
      error.operationId === original.body.intentId &&
      error.retryable === false &&
      error.recovery === "query_operation",
    "UI changed the safe original-intent recovery envelope",
  );
}

// This function is serialized into the existing, independently owned Docker
// exec. Every SDK result below comes from the production compiled adapter.
async function peerMain(expected) {
  const report = {
    status: "failed",
    updates: [],
    closed: { bridge: false, security: false },
  };
  const failures = [];
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Independent ACP peer deadline exceeded")),
    60_000,
  );
  let bridge, security, abortClose;
  const requireFact = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const retain = (error, depth = 0) => {
    if (depth >= 8) return { truncated: true };
    if (!(error instanceof Error))
      return { name: "NonError", message: String(error) };
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      ...(error.cause === undefined
        ? {}
        : { cause: retain(error.cause, depth + 1) }),
      ...(error instanceof AggregateError
        ? { errors: error.errors.map((value) => retain(value, depth + 1)) }
        : {}),
    };
  };
  const onAbort = () => {
    if (bridge) {
      abortClose = bridge.close();
      abortClose.catch(() => {});
    }
  };
  controller.signal.addEventListener("abort", onAbort, { once: true });
  try {
    const { AcpHttpBridge } =
      await import("file:///app/server/dist/adapters/acp-http.js");
    const { ServiceAuthentication } =
      await import("file:///app/server/dist/adapters/service-authentication.js");
    const { CallerContextVerifier } =
      await import("file:///app/server/dist/adapters/caller-context.js");
    const { bindScopeContext } =
      await import("file:///app/server/dist/http/trusted-identity.js");
    const { randomUUID } = await import("node:crypto");
    const identityOrigin = "http://identity-service:8080";
    const acpOrigin = "http://agent-acp-workspace:8080";
    requireFact(
      process.env.RECEIPT_ACCESS_TOKEN &&
        process.env.RECEIPT_GATEWAY_IDENTITY_TOKEN,
      "Independent peer authentication environment is absent",
    );
    const issued = await fetch(
      identityOrigin + "/rpc/identity/resolve-access-token",
      {
        method: "POST",
        headers: {
          "Antnest-Service-Authorization":
            "Bearer " + process.env.RECEIPT_GATEWAY_IDENTITY_TOKEN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          access_token: process.env.RECEIPT_ACCESS_TOKEN,
          profile: "workspace",
          agent_id: expected.agentId,
        }),
        redirect: "error",
        signal: controller.signal,
      },
    );
    const issuedText = await issued.text();
    requireFact(
      issued.status === 200,
      "Independent peer caller-context admission failed",
    );
    const { caller_context: token } = JSON.parse(issuedText);
    security = new ServiceAuthentication(process.env);
    const verifier = new CallerContextVerifier(
      identityOrigin,
      security.fetchFor("identity-service", identityOrigin),
    );
    const claims = await verifier.verify(token, { agent: expected.agentId });
    requireFact(
      claims.sub === expected.ownerId,
      "Independent peer principal changed",
    );
    const scope = {
      organizationId: claims.org,
      principalId: claims.sub,
      agentId: expected.agentId,
    };
    bindScopeContext(scope, { token, claims });
    report.scope = scope;
    bridge = await AcpHttpBridge.open({
      baseUrl: new URL(acpOrigin),
      scope,
      fetchImpl: security.fetchFor("agent-acp-service", acpOrigin),
      callbacks: {
        update: (value) => report.updates.push(structuredClone(value)),
        requestPermission: () => {
          throw new Error("Independent peer unexpectedly requested permission");
        },
      },
      signal: controller.signal,
      closeTimeoutMs: 5000,
    });
    controller.signal.throwIfAborted();
    report.newSession = await bridge.createSession();
    report.load = await bridge.load(report.newSession.sessionId);
    report.promptRequest = {
      sessionId: report.newSession.sessionId,
      prompt: [{ type: "text", text: expected.phase }],
      intentId: randomUUID(),
      expectedAppendVersion: report.load.cut.appendVersion,
    };
    report.promptResult = await bridge.prompt(report.promptRequest);
    report.intentObservation = await bridge.readIntent(
      report.promptRequest.sessionId,
      report.promptRequest.intentId,
      controller.signal,
    );
    report.execution = await bridge.readExecution(
      report.promptRequest.sessionId,
    );
    controller.signal.throwIfAborted();
  } catch (error) {
    failures.push(error);
  } finally {
    // Abort in-flight work at the business deadline, then join the original SDK
    // and HTTP owners. No Promise.race is used to abandon a pending operation.
    if (abortClose) {
      try {
        await abortClose;
      } catch (error) {
        failures.push(error);
      }
    }
    if (bridge) {
      try {
        await bridge.close();
        report.closed.bridge = true;
      } catch (error) {
        failures.push(error);
      }
    }
    if (security) {
      try {
        await security.close();
        report.closed.security = true;
      } catch (error) {
        failures.push(error);
      }
    }
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", onAbort);
  }
  report.status = failures.length === 0 ? "passed" : "failed";
  if (failures.length) report.failures = failures.map((error) => retain(error));
  // stdout is the private exec receipt, never a public success declaration.
  process.stdout.write(JSON.stringify(report));
}

export async function verifyBrowserPromptBusy({
  page,
  client,
  config,
  fixture,
  gateControl,
  execPeer,
  signal,
  preserve,
}) {
  check(
    typeof execPeer === "function" &&
      typeof gateControl === "function" &&
      typeof preserve === "function" &&
      typeof fixture.request === "function",
    "Busy integration requires owned peer execution and private preservation",
  );
  const definition = busyDefinition();
  const gateway = new URL(config.gateway).origin;
  const base =
    "/api/app/workspace/v1/agents/" + encodeURIComponent(fixture.agentID);
  const pattern =
    "**/api/app/workspace/v1/agents/" +
    encodeURIComponent(fixture.agentID) +
    "/sessions/*/prompts";
  const evidence = {
    version: 1,
    browserPrompts: [],
    gate: {},
    models: {},
    audits: { http: [], runs: [] },
    cleanup: [],
  };
  const failures = [];
  const remember = (error) => {
    if (!failures.includes(error)) failures.push(error);
  };
  const tasks = new Set();
  let routeInstalled = false,
    requestInstalled = false,
    routeFailure;
  let peer,
    peerOutcome,
    peerSettled = false,
    result;
  const requestJson = async (url, { body, cleanup = false } = {}) => {
    const response = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
      redirect: "error",
      signal: AbortSignal.any([
        ...(cleanup || !signal ? [] : [signal]),
        AbortSignal.timeout(5000),
      ]),
    });
    const rawBody = await response.text();
    return { status: response.status, rawBody, body: JSON.parse(rawBody) };
  };
  const fault = (path, options) => gateControl(path, options);
  const gateState = async (cleanup = false) => {
    const response = await fault("state", { cleanup });
    check(response.status === 200, "Gate state read failed");
    return response.body;
  };
  const model = async (cleanup = false) => {
    const response = await requestJson(new URL("/status", config.model), {
      cleanup,
    });
    check(
      response.status === 200 &&
        Array.isArray(response.body.requests) &&
        Array.isArray(response.body.pending) &&
        Array.isArray(response.body.errors) &&
        response.body.errors.length === 0,
      "Controlled model inventory is invalid",
    );
    return response.body;
  };
  const releaseModel = (cleanup = false) =>
    requestJson(new URL("/release/" + peerPhase, config.model), {
      body: {},
      cleanup,
    });
  const auditRead = async (path) => {
    signal?.throwIfAborted();
    const original = { method: "GET", path, status: null, rawBody: null };
    evidence.audits.http.push(original);
    const response = await fixture.request(path, {
      onResponse: (row) => {
        original.status = row.status;
        original.rawBody = row.text;
      },
    });
    signal?.throwIfAborted();
    check(
      response.status === 200 &&
        original.status === 200 &&
        typeof original.rawBody === "string" &&
        isDeepStrictEqual(JSON.parse(original.rawBody), response.body),
      "Original Admin Run audit response is absent or inconsistent",
    );
    return response.body;
  };
  const auditRuns = async () => {
    const page = await auditRead(
      "/api/admin/execution-audits?agent_id=" +
        encodeURIComponent(fixture.agentID) +
        "&limit=100",
    );
    check(
      Array.isArray(page?.items) &&
        page.next_cursor === null &&
        page.items.every(
          (run) =>
            identity(run.run_id) &&
            identity(run.session_id) &&
            run.agent_id === fixture.agentID &&
            run.principal_id === fixture.ownerID,
        ) &&
        new Set(page.items.map((run) => run.run_id)).size === page.items.length,
      "Admin Run inventory is truncated, duplicated or outside the original scope",
    );
    return page;
  };
  const addedRuns = (page) => {
    const before = new Map(
      evidence.audits.before.items.map((run) => [run.run_id, run]),
    );
    check(
      [...before].every(([id, run]) =>
        isDeepStrictEqual(
          page.items.find((row) => row.run_id === id),
          run,
        ),
      ) &&
        page.items.every(
          (run) => run.session_id !== evidence.originalARequest.sessionId,
        ),
      "Original Run history changed or the rejected Session created a Run",
    );
    return page.items.filter((run) => !before.has(run.run_id));
  };
  const promptInventory = (state, expected) =>
    assertPromptInventory({
      browserPrompts: evidence.browserPrompts,
      gateBefore: evidence.gate.before,
      gateAfter: state,
      expected,
    });
  const observeRequest = (request) => {
    try {
      const value = promptRequest(request, gateway, base);
      if (value) evidence.browserPrompts.push(value);
    } catch (error) {
      routeFailure ??= error;
    }
  };
  const route = async (heldRoute) => {
    const task = (async () => {
      const original = promptRequest(heldRoute.request(), gateway, base);
      if (!original || evidence.originalARequest) {
        await heldRoute.continue();
        return;
      }
      check(
        isDeepStrictEqual(original.body.prompt, [
          { type: "text", text: refusedPhase },
        ]),
        "Unexpected original busy probe",
      );
      evidence.originalARequest = original;
      evidence.gate.arm = await fault("arm", {
        body: { intentId: original.body.intentId },
      });
      check(
        evidence.gate.arm.status === 200 &&
          evidence.gate.arm.body.armedIntent === original.body.intentId,
        "Gate did not arm for the browser's original intent",
      );
      await heldRoute.continue();
    })();
    tasks.add(task);
    try {
      await task;
    } catch (error) {
      routeFailure ??= error;
      try {
        await heldRoute.abort();
      } catch (cleanup) {
        remember(cleanup);
      }
    } finally {
      tasks.delete(task);
    }
  };
  const composer = page.getByRole("combobox", { name: "Message", exact: true });
  const send = async (phase) => {
    await composer.fill(phase);
    const pending = page.waitForResponse(
      (response) => {
        const request = promptRequest(response.request(), gateway, base);
        return request?.body.prompt?.[0]?.text === phase;
      },
      { timeout: 30_000 },
    );
    // Install the rejection handler before pressing Enter, including failures
    // in the browser action. Both original Playwright operations are joined.
    const observed = pending.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    let pressError;
    try {
      await composer.press("Enter");
    } catch (error) {
      pressError = error;
    }
    const response = await observed;
    if (pressError && response.error)
      throw new AggregateError(
        [pressError, response.error],
        "Prompt browser actions failed",
      );
    if (pressError || response.error) throw pressError ?? response.error;
    const rawBody = await response.value.text();
    const receipt = {
      request: promptRequest(response.value.request(), gateway, base),
      status: response.value.status(),
      rawBody,
      body: JSON.parse(rawBody),
    };
    check(
      receipt.status === 202 &&
        receipt.body.operationId === receipt.request.body.intentId &&
        receipt.body.acceptance === "bridge" &&
        receipt.body.phase === "dispatching",
      "Actual UI Prompt admission changed",
    );
    return receipt;
  };
  const view = async (sessionId) => {
    const response = await client.request(
      base + "/view?sessionId=" + encodeURIComponent(sessionId),
    );
    check(response.status === 200, "Actual Workspace view read failed");
    return response;
  };
  const poll = async (read, label) =>
    until(
      async () => {
        if (routeFailure) throw routeFailure;
        return read();
      },
      label,
      signal,
      30_000,
    );
  const parsePeer = (stdout) => {
    check(typeof stdout === "string", "Independent peer stdout is absent");
    evidence.peerStdout = stdout;
    const report = JSON.parse(stdout);
    evidence.peerB = report;
    check(
      report.status === "passed" &&
        report.closed?.bridge === true &&
        report.closed?.security === true,
      "Independent ACP peer did not complete and close",
    );
    const original = report.promptRequest;
    const observation = report.intentObservation;
    check(
      report.scope?.agentId === fixture.agentID &&
        report.scope?.principalId === fixture.ownerID &&
        original?.sessionId === report.newSession?.sessionId &&
        original.expectedAppendVersion === report.load?.cut?.appendVersion &&
        isDeepStrictEqual(original.prompt, [
          { type: "text", text: peerPhase },
        ]) &&
        report.promptResult?.stopReason === "end_turn" &&
        observation?.kind === "receipt" &&
        observation.receipt.intentId === original.intentId &&
        observation.receipt.sessionId === original.sessionId &&
        identity(observation.receipt.runId) &&
        observation.receipt.phase === "completed" &&
        observation.receipt.stopReason === "end_turn" &&
        observation.receipt.errorClass === null &&
        report.execution?.sessionId === original.sessionId &&
        report.execution.activeRunId === null &&
        report.execution.recentReceipts.some((receipt) =>
          isDeepStrictEqual(receipt, observation.receipt),
        ),
      "Independent peer receipts do not prove its original completed Run",
    );
    return report;
  };
  try {
    evidence.gate.before = await gateState();
    evidence.models.before = await model();
    check(
      !evidence.models.before.requests.some((row) =>
        [peerPhase, refusedPhase, nextPhase].includes(row.phase),
      ),
      "Busy probe phases have already been consumed",
    );
    evidence.audits.before = await auditRuns();
    page.on("request", observeRequest);
    requestInstalled = true;
    await page.route(pattern, route);
    routeInstalled = true;
    await page
      .getByRole("button", { name: "New conversation", exact: true })
      .click();
    await poll(() => composer.isEnabled(), "Busy probe composer");
    evidence.acceptedA = await send(refusedPhase);
    evidence.gate.held = await poll(async () => {
      const state = await gateState();
      return state.heldIntent === evidence.originalARequest.body.intentId &&
        state.heldRequests === 1
        ? state
        : false;
    }, "Original UI intent held before ACP");
    promptInventory(evidence.gate.held, [
      { request: evidence.originalARequest, forwarded: 0 },
    ]);
    const script =
      "await (" +
      peerMain.toString() +
      ")(" +
      JSON.stringify({
        agentId: fixture.agentID,
        ownerId: fixture.ownerID,
        phase: peerPhase,
      }) +
      ");";
    peer = Promise.resolve().then(() => execPeer(script));
    peerOutcome = peer.then(
      (stdout) => {
        peerSettled = true;
        return { stdout };
      },
      (error) => {
        peerSettled = true;
        return { error };
      },
    );
    evidence.models.held = await poll(async () => {
      if (peerSettled)
        throw new Error("Independent peer ended before holding its Run");
      const state = await model();
      return state.pending.includes(peerPhase) ? state : false;
    }, "Independent peer owns a real held Run");
    check(
      evidence.models.held.requests.filter((row) => row.phase === peerPhase)
        .length === 1,
      "Independent peer repeated model inference",
    );
    evidence.gate.release = await fault("release", {
      body: { intentId: evidence.originalARequest.body.intentId },
    });
    check(
      evidence.gate.release.status === 200 &&
        evidence.gate.release.body.released === 1,
      "Original held Prompt was not released once",
    );
    evidence.gate.rejected = await poll(async () => {
      const state = await gateState();
      const original = gatePrompt(
        state,
        evidence.originalARequest.body.intentId,
        evidence.originalARequest.sessionId,
      );
      const errors = rpcMessages(state, evidence.gate.before).filter(
        ({ message }) =>
          isDeepStrictEqual(message.id, original.message.id) &&
          object(message.error),
      );
      check(errors.length <= 1, "Ambiguous original ACP error response");
      if (!errors.length) return false;
      canonicalBusy(errors[0].message.error, definition);
      evidence.actualAcpRejection = { request: original, response: errors[0] };
      return state;
    }, "Actual canonical ACP busy rejection");
    const original = evidence.originalARequest;
    evidence.viewUncertain = await poll(async () => {
      const current = await view(original.sessionId);
      const operation = current.body.operations?.find(
        (entry) =>
          entry.operationId === original.body.intentId &&
          entry.phase === "uncertain",
      );
      if (!operation) return false;
      uncertainOperation(operation, original, definition);
      return current;
    }, "UI original intent remains uncertain");
    const alert = page
      .getByRole("alert")
      .filter({ hasText: definition.message });
    await poll(
      async () => (await alert.count()) === 1 && (await alert.isVisible()),
      "Safe busy message is rendered",
    );
    check(
      (await alert.innerText()).includes(uncertainHint),
      "UI lost the original-intent query guidance",
    );
    check(
      await composer.isEnabled(),
      "Uncertain Session lost editable command input",
    );
    const blockedDraft = `${refusedPhase} blocked retry`;
    evidence.blockedSubmission = {
      draft: blockedDraft,
      enterPressed: false,
    };
    await composer.fill(blockedDraft);
    const sendMessage = page.getByRole("button", {
      name: "Send message",
      exact: true,
    });
    const sendMessageCount = await sendMessage.count();
    evidence.blockedSubmission.sendMessageCount = sendMessageCount;
    check(sendMessageCount <= 1, "Ambiguous ordinary Send control");
    if (sendMessageCount === 1) {
      const disabled = await sendMessage.isDisabled();
      evidence.blockedSubmission.sendMessageDisabled = disabled;
      check(disabled, "Uncertain original Session enabled ordinary sending");
    } else {
      const stop = page.getByRole("button", {
        name: "Stop operation",
        exact: true,
      });
      const stopVisible =
        (await stop.count()) === 1 && (await stop.isVisible());
      evidence.blockedSubmission.stopVisible = stopVisible;
      check(stopVisible, "Uncertain Session lost its sending control");
    }
    await composer.press("Enter");
    evidence.blockedSubmission.enterPressed = true;
    evidence.blockedSubmission.draftAfterEnter = await composer.inputValue();
    check(
      evidence.blockedSubmission.draftAfterEnter === blockedDraft,
      "Blocked ordinary submission changed the unsent draft",
    );
    evidence.gate.afterBlockedSubmission = await gateState();
    promptInventory(evidence.gate.afterBlockedSubmission, [
      { request: original, forwarded: 1 },
    ]);
    evidence.operationQuery = await client.request(
      base +
        "/sessions/" +
        encodeURIComponent(original.sessionId) +
        "/operations/" +
        encodeURIComponent(original.body.intentId),
    );
    check(
      evidence.operationQuery.status === 200,
      "Original operation lookup failed",
    );
    uncertainOperation(evidence.operationQuery.body, original, definition);
    evidence.gate.afterQuery = await gateState();
    promptInventory(evidence.gate.afterQuery, [
      { request: original, forwarded: 1 },
    ]);
    evidence.models.rejected = await model();
    check(
      evidence.models.rejected.requests.every(
        (row) => row.phase !== refusedPhase,
      ),
      "Rejected original Prompt reached model inference",
    );
    evidence.audits.whileBusy = await auditRuns();
    const heldRuns = addedRuns(evidence.audits.whileBusy);
    check(
      heldRuns.length === 1 && heldRuns[0].state === "running",
      "The busy window created more than the independent peer Run",
    );
    evidence.models.release = await releaseModel();
    check(evidence.models.release.status === 200, "Held model did not release");
    const outcome = await peerOutcome;
    if (outcome.error) throw outcome.error;
    const completedPeer = parsePeer(outcome.stdout);
    check(
      heldRuns[0].run_id === completedPeer.intentObservation.receipt.runId &&
        heldRuns[0].session_id === completedPeer.promptRequest.sessionId,
      "The held Admin Run is not the independent peer's original Run",
    );
    evidence.viewReady = await poll(async () => {
      const current = await view(original.sessionId);
      return current.body.availability === "ready" ? current : false;
    }, "Agent ready after independent peer completion");
    uncertainOperation(
      evidence.viewReady.body.operations.find(
        (entry) => entry.operationId === original.body.intentId,
      ),
      original,
      definition,
    );
    evidence.gate.afterPeer = await gateState();
    promptInventory(evidence.gate.afterPeer, [
      { request: original, forwarded: 1 },
    ]);
    await page
      .getByRole("button", { name: "New conversation", exact: true })
      .click();
    await poll(() => composer.isEnabled(), "Explicit new-intent composer");
    evidence.acceptedNext = await send(nextPhase);
    check(
      evidence.acceptedNext.request.sessionId !== original.sessionId &&
        evidence.acceptedNext.body.operationId !== original.body.intentId &&
        evidence.acceptedNext.body.operationId !==
          completedPeer.promptRequest.intentId,
      "Explicit next Prompt reused an uncertain intent or Session",
    );
    evidence.viewCompleted = await poll(async () => {
      const current = await view(evidence.acceptedNext.request.sessionId);
      const operation = current.body.operations?.find(
        (entry) =>
          entry.operationId === evidence.acceptedNext.body.operationId &&
          entry.phase === "completed" &&
          entry.acceptance === "acp",
      );
      if (!operation) return false;
      check(
        identity(operation.runId) &&
          operation.runId !== completedPeer.intentObservation.receipt.runId,
        "Explicit next intent did not produce its own Run",
      );
      return current;
    }, "Explicit new intent completed");
    evidence.gate.completed = await poll(async () => {
      const state = await gateState();
      const originalNext = gatePrompt(
        state,
        evidence.acceptedNext.body.operationId,
        evidence.acceptedNext.request.sessionId,
      );
      const responses = rpcMessages(state, evidence.gate.afterPeer).filter(
        ({ message }) =>
          isDeepStrictEqual(message.id, originalNext.message.id) &&
          object(message.result),
      );
      check(responses.length <= 1, "Ambiguous next Prompt response");
      if (!responses.length) return false;
      check(
        responses[0].message.result.stopReason === "end_turn",
        "Explicit next Prompt did not complete on the actual ACP wire",
      );
      evidence.actualNextAcpResponse = {
        request: originalNext,
        response: responses[0],
      };
      return state;
    }, "Explicit next intent has a real ACP response");
    const expectedPrompts = [
      { request: original, forwarded: 1 },
      { request: evidence.acceptedNext.request, forwarded: 1 },
    ];
    promptInventory(evidence.gate.completed, expectedPrompts);
    evidence.models.completed = await model();
    const peerRequests = evidence.models.completed.requests.filter(
      (row) => row.phase === peerPhase,
    );
    const nextRequests = evidence.models.completed.requests.filter(
      (row) => row.phase === nextPhase,
    );
    check(
      peerRequests.length === 1 &&
        nextRequests.length === 1 &&
        !peerRequests[0].disconnected &&
        !nextRequests[0].disconnected &&
        !evidence.models.completed.pending.includes(peerPhase) &&
        evidence.models.completed.requests.every(
          (row) => row.phase !== refusedPhase,
        ),
      "Busy recovery repeated or lost actual model work",
    );
    evidence.audits.completed = await auditRuns();
    const completedRuns = addedRuns(evidence.audits.completed);
    const nextOperation = evidence.viewCompleted.body.operations.find(
      (operation) =>
        operation.operationId === evidence.acceptedNext.body.operationId,
    );
    const expectedRuns = [
      {
        runId: completedPeer.intentObservation.receipt.runId,
        sessionId: completedPeer.promptRequest.sessionId,
        prompt: completedPeer.promptRequest.prompt,
      },
      {
        runId: nextOperation.runId,
        sessionId: evidence.acceptedNext.request.sessionId,
        prompt: evidence.acceptedNext.request.body.prompt,
      },
    ];
    check(
      completedRuns.length === 2 &&
        new Set(expectedRuns.map((run) => run.runId)).size === 2 &&
        expectedRuns.every((run) =>
          completedRuns.some((row) => row.run_id === run.runId),
        ),
      "The final Admin inventory contains an extra or missing Run",
    );
    const summaryFields = [
      "run_id",
      "session_id",
      "agent_id",
      "principal_id",
      "state",
      "created_at",
      "updated_at",
    ];
    const eventIds = new Set();
    for (const expected of expectedRuns) {
      const audit = { run: null, events: null };
      evidence.audits.runs.push(audit);
      const path =
        "/api/admin/execution-audits/" + encodeURIComponent(expected.runId);
      audit.run = await auditRead(path);
      audit.events = await auditRead(
        path + "/events?stream=execution&limit=100",
      );
      const run = audit.run;
      const summary = completedRuns.find(
        (row) => row.run_id === expected.runId,
      );
      check(
        summaryFields.every((field) =>
          isDeepStrictEqual(run?.[field], summary[field]),
        ) &&
          run.run_id === expected.runId &&
          run.agent_id === fixture.agentID &&
          run.principal_id === fixture.ownerID &&
          run.session_id === expected.sessionId &&
          isDeepStrictEqual(run.input, expected.prompt) &&
          run.state === "completed" &&
          run.terminal_class === "completed" &&
          run.executor_state === "quiescent" &&
          run.tool_effect_state === "none" &&
          (run.unknown_effect_source === null ||
            run.unknown_effect_source === undefined) &&
          run.stop_reason === "end_turn" &&
          run.error_class === null,
        "The original peer or explicit-next Run was not durably completed",
      );
      const events = audit.events;
      check(
        events?.stream === "execution" &&
          Array.isArray(events.items) &&
          events.next_cursor === null,
        "Persisted execution events are absent or truncated",
      );
      let sequence = 0;
      for (const event of events.items) {
        check(
          identity(event.id) &&
            !eventIds.has(event.id) &&
            Number.isSafeInteger(event.sequence) &&
            event.sequence > sequence &&
            typeof event.kind === "string" &&
            !event.kind.startsWith("tool") &&
            (event.kind !== "agent_message" ||
              event.payload?.toolCalls === undefined ||
              (Array.isArray(event.payload.toolCalls) &&
                event.payload.toolCalls.length === 0)),
          "Persisted execution events are duplicated, reordered or contain unexpected Tool work",
        );
        eventIds.add(event.id);
        sequence = event.sequence;
      }
      const users = events.items.filter(
        (event) => event.kind === "user_message",
      );
      const replies = events.items.filter(
        (event) => event.kind === "agent_message",
      );
      check(
        users.length === 1 &&
          users[0].visible === true &&
          users[0].payload?.kind === "user_message" &&
          users[0].payload.messageId === users[0].id &&
          isDeepStrictEqual(users[0].payload.content, expected.prompt) &&
          replies.length > 0 &&
          replies.every(
            (event) =>
              event.visible === true &&
              event.payload?.kind === "agent_message" &&
              event.payload.messageId === event.id &&
              Array.isArray(event.payload.content),
          ) &&
          replies.some((event) =>
            event.payload.content.some(
              (block) =>
                block.type === "text" &&
                typeof block.text === "string" &&
                block.text.length > 0,
            ),
          ),
        "Persisted execution messages do not bind the original input and visible reply",
      );
    }
    evidence.gate.afterAudits = await gateState();
    const inventoryCounts = promptInventory(
      evidence.gate.afterAudits,
      expectedPrompts,
    );
    const originalDispatches =
      (evidence.gate.afterAudits.forwardedByIntent[original.body.intentId] ??
        0) -
      (evidence.gate.before.forwardedByIntent[original.body.intentId] ?? 0);
    result = {
      checks: [
        "real-peer-agent-busy",
        "canonical-busy-wire",
        "original-intent-query-without-replay",
        "explicit-new-intent-after-peer",
        "persisted-run-inventory-without-extra-runs",
        "complete-browser-and-acp-prompt-inventory",
        "independent-peer-closed",
      ],
      busy_rejections: 1,
      original_prompt_dispatches: originalDispatches,
      browser_prompts: inventoryCounts.browserPrompts,
      gate_prompts: inventoryCounts.gatePrompts,
      forwarded_prompts: inventoryCounts.forwardedPrompts,
      peer_model_requests: peerRequests.length,
      explicit_new_model_requests: nextRequests.length,
      audited_new_runs: completedRuns.length,
      peer_closed: true,
    };
  } catch (error) {
    remember(error);
  } finally {
    if (routeInstalled) {
      try {
        await page.unroute(pattern, route);
      } catch (error) {
        remember(error);
      }
    }
    if (requestInstalled) page.off("request", observeRequest);
    for (const task of [...tasks]) {
      try {
        await task;
      } catch (error) {
        remember(error);
      }
    }
    if (routeFailure) remember(routeFailure);
    if (evidence.originalARequest) {
      try {
        const released = await fault("release", {
          body: { intentId: evidence.originalARequest.body.intentId },
          cleanup: true,
        });
        evidence.cleanup.push({ gateRelease: released });
        check([200, 409].includes(released.status), "Gate cleanup failed");
      } catch (error) {
        remember(error);
      }
    }
    // The peer can reach its held model after host cancellation. Keep releasing
    // that exact phase until the independently bounded exec has really settled.
    if (peer) {
      do {
        try {
          const current = await model(true);
          evidence.cleanup.push({ model: current });
          if (current.pending.includes(peerPhase)) {
            const released = await releaseModel(true);
            evidence.cleanup.push({ modelRelease: released });
            check(
              [200, 404].includes(released.status),
              "Peer model cleanup failed",
            );
          }
        } catch (error) {
          remember(error);
        }
        if (!peerSettled) await delay(100);
      } while (!peerSettled);
      try {
        const stdout = await peer;
        if (!evidence.peerB) parsePeer(stdout);
      } catch (error) {
        remember(error);
      }
    }
    try {
      evidence.gate.final = await gateState(true);
      if (result)
        promptInventory(evidence.gate.final, [
          { request: evidence.originalARequest, forwarded: 1 },
          { request: evidence.acceptedNext.request, forwarded: 1 },
        ]);
    } catch (error) {
      remember(error);
    }
  }
  const failure =
    failures.length === 0
      ? undefined
      : failures.length === 1
        ? failures[0]
        : new AggregateError(
            failures,
            "Busy integration and owned cleanup failed",
          );
  try {
    await preserve(evidence, failure);
  } catch (archiveError) {
    if (failure)
      throw new AggregateError(
        [failure, archiveError],
        "Busy integration and private archive failed",
      );
    throw archiveError;
  }
  if (failure) throw failure;
  return result;
}
