import assert from "node:assert/strict";

const traceID = (value) => /^(?!0{32}$)[a-f0-9]{32}$/u.test(value ?? "");
const loginURL = (value, gateway, agentId, sessionId) => {
  const url = new URL(value);
  if (
    url.origin !== new URL(gateway).origin ||
    url.pathname !== "/" ||
    url.hash
  )
    return false;
  return (
    !url.search ||
    JSON.stringify([...url.searchParams]) ===
      JSON.stringify([
        [
          "return_to",
          `/workspace/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}`,
        ],
      ])
  );
};
function scopedResponse(row, gateway, agentId, sessionId) {
  const url = new URL(row.url);
  if (
    url.origin !== new URL(gateway).origin ||
    url.hash ||
    ![200, 401, 403].includes(row.status) ||
    row.method !== "GET" ||
    !row.mainFrame ||
    row.redirected ||
    row.requestURL !== row.url ||
    !traceID(row.traceID)
  )
    return false;
  if (url.pathname === "/api/app/workspace/v1/bootstrap") return !url.search;
  return (
    url.pathname ===
      `/api/app/workspace/v1/agents/${encodeURIComponent(agentId)}/view` &&
    JSON.stringify([...url.searchParams]) ===
      JSON.stringify([["sessionId", sessionId]])
  );
}
const unavailableDuringNavigation = (error) =>
  typeof error?.message === "string" &&
  error.message.includes("Network.getResponseBody") &&
  error.message.includes("No resource with given identifier found") &&
  error.message.includes("navigated away");

// This observes our E2E reader's coverage. It neither retries the SDK read nor
// turns an unread body into an audited payload. Business/Trace admission follows.
export function createC4BodyAudit({
  gateway,
  agentId,
  diagnostics,
  now = () => performance.now(),
}) {
  const pages = new Map(),
    pending = new Set();
  let armed;
  function track(page, scope) {
    assert(!pages.has(page), "C4 body page already tracked");
    const state = { pageId: pages.size + 1, generation: 0, manual: 0 };
    pages.set(page, state);
    const navigated = (frame) => {
      if (frame !== page.mainFrame()) return;
      const fromGeneration = state.generation++;
      if (
        armed?.page === page &&
        armed.generation === fromGeneration &&
        !state.manual &&
        loginURL(frame.url(), gateway, agentId, armed.sessionId)
      ) {
        armed.navigation = {
          pageId: state.pageId,
          fromGeneration,
          toGeneration: state.generation,
          url: frame.url(),
          atMono: now(),
        };
      }
    };
    page.on("framenavigated", navigated);
    scope.addObserver({
      async closeAndWait() {
        page.off("framenavigated", navigated);
      },
    });
  }
  function arm(page, { sessionId, startedMono }) {
    assert(!armed, "one original C4 revocation required");
    assert(
      typeof sessionId === "string" &&
        sessionId &&
        Number.isFinite(startedMono),
    );
    const state = pages.get(page);
    assert(state, "original C4 revocation page not tracked");
    armed = {
      page,
      sessionId,
      startedMono,
      generation: state.generation,
      navigation: null,
    };
    for (const record of pending)
      if (
        record.page === page &&
        record.snapshot.generation === armed.generation
      )
        record.target = armed;
  }
  async function read(page, response, lastCompletedCheck) {
    const state = pages.get(page);
    assert(state, "C4 response page not tracked");
    const request = response.request();
    // Freeze the original response identity before the first asynchronous read.
    const snapshot = Object.freeze({
      pageId: state.pageId,
      generation: state.generation,
      url: response.url(),
      requestURL: request.url(),
      method: request.method(),
      status: response.status(),
      traceID: response.headers()["x-antnest-trace-id"],
      mainFrame: request.frame() === page.mainFrame(),
      redirected: request.redirectedFrom() !== null,
      startedMono: now(),
      lastCompletedCheck,
    });
    const record = {
      page,
      snapshot,
      target:
        armed?.page === page && armed.generation === state.generation
          ? armed
          : null,
    };
    pending.add(record);
    try {
      return await response.text();
    } catch (error) {
      const failedMono = now(),
        target = record.target,
        navigation = target?.navigation;
      if (
        !unavailableDuringNavigation(error) ||
        !target ||
        !navigation ||
        state.manual ||
        state.generation !== navigation.toGeneration ||
        snapshot.generation !== navigation.fromGeneration ||
        !(
          snapshot.startedMono <= navigation.atMono &&
          target.startedMono <= navigation.atMono &&
          navigation.atMono <= failedMono
        ) ||
        !scopedResponse(snapshot, gateway, agentId, target.sessionId)
      )
        throw error;
      diagnostics.push({
        id: diagnostics.length + 1,
        ...snapshot,
        agentId,
        sessionId: target.sessionId,
        revocationStartedMono: target.startedMono,
        failedMono,
        loginNavigation: { ...navigation },
        body: "not_observed",
        raw_error: {
          name: error.name,
          message: error.message,
          stack: error.stack,
        },
      });
      return null;
    } finally {
      pending.delete(record);
    }
  }
  async function beforeChange(page, action) {
    const state = pages.get(page);
    state.manual++;
    try {
      return await action();
    } finally {
      state.manual--;
    }
  }
  function confirm(page, visible) {
    assert(armed?.page === page, "C4 login proof belongs to another page");
    assert.equal(visible.signInVisible, true);
    assert.equal(visible.composerCount, 0);
    assert.equal(visible.messageCount, 0);
    assert(
      loginURL(page.url(), gateway, agentId, armed.sessionId),
      "C4 login proof has another destination",
    );
    return {
      pageId: pages.get(page).pageId,
      sessionId: armed.sessionId,
      startedMono: armed.startedMono,
      loginURL: page.url(),
      loginNavigation: armed.navigation && { ...armed.navigation },
      confirmedMono: now(),
      ...visible,
    };
  }
  return { track, arm, read, beforeChange, confirm };
}

// Called only after all browser, execution and collected-source owning gates.
// Keep raw diagnostics pending until that independent evidence has passed.
export function assertC4BodyDiagnostics(report, { gateway }) {
  const rows = report.browser_body_diagnostics ?? [];
  assert(Array.isArray(rows));
  if (!rows.length)
    return { status: "not_needed", body_count: 0, body_ids: [] };
  assert.equal(
    report.business_completed,
    true,
    "C4 body diagnostic lacks completed business",
  );
  const revocation = report.browser_revocation,
    proof = revocation?.bodyObservation;
  assert(proof, "C4 body diagnostic lacks original login proof");
  assert.equal(revocation.cause.status, 200);
  assert(traceID(revocation.cause.traceID));
  assert.equal(proof.startedMono, revocation.cause.startedMono);
  assert.equal(proof.sessionId, revocation.selectedView.sessionId);
  assert.equal(proof.signInVisible, true);
  assert.equal(proof.composerCount, 0);
  assert.equal(proof.messageCount, 0);
  assert(
    loginURL(
      proof.loginURL,
      gateway,
      revocation.selectedView.agentId,
      proof.sessionId,
    ),
  );
  for (const [index, row] of rows.entries()) {
    assert.equal(row.id, index + 1);
    assert.equal(row.pageId, proof.pageId);
    assert.equal(row.agentId, revocation.selectedView.agentId);
    assert.equal(row.sessionId, proof.sessionId);
    assert.equal(row.revocationStartedMono, proof.startedMono);
    assert.deepEqual(row.loginNavigation, proof.loginNavigation);
    assert.equal(row.generation, row.loginNavigation.fromGeneration);
    assert.equal(row.loginNavigation.pageId, row.pageId);
    assert.equal(row.loginNavigation.toGeneration, row.generation + 1);
    assert(
      loginURL(row.loginNavigation.url, gateway, row.agentId, row.sessionId),
    );
    assert(
      row.startedMono <= row.loginNavigation.atMono &&
        proof.startedMono <= row.loginNavigation.atMono &&
        row.loginNavigation.atMono <= row.failedMono &&
        row.failedMono <= proof.confirmedMono,
    );
    assert(scopedResponse(row, gateway, row.agentId, row.sessionId));
    assert.equal(row.body, "not_observed");
    assert(unavailableDuringNavigation(row.raw_error));
  }
  return {
    status: "accepted_external_observation",
    body_count: rows.length,
    body_ids: rows.map((row) => row.id),
  };
}
