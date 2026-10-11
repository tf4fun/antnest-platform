import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { until } from "../workspace-closeout/c4-setup.mjs";

// Reuse the real Gateway/Identity/Node/ACP/Runtime stack and held model. During
// the quiet Run this probe never reads a Workspace API itself: only the browser
// may renew its observer, so polling cannot hide expired owner delegation.
export async function verifyBrowserStreamRenewal({
  page,
  config,
  fixture,
  signal,
}) {
  const phase = "c4-browser-hold-offline";
  const base = `/api/app/workspace/v1/agents/${fixture.agentID}`;
  const requests = [];
  const responses = [];
  const deliveries = new Set();
  const requestRecords = new WeakMap();
  const record = (request) => {
    const url = new URL(request.url());
    if (url.origin === config.gateway && url.pathname.startsWith("/api/")) {
      const entry = {
        path: url.pathname,
        sessionId: url.searchParams.get("sessionId"),
        method: request.method(),
        at: performance.now(),
      };
      requests.push(entry);
      requestRecords.set(request, entry);
    }
  };
  const delivered = (response) => {
    const request = requestRecords.get(response.request());
    if (!request) return;
    const entry = {
      request,
      status: response.status(),
      contentType: response.headers()["content-type"] ?? "",
      at: performance.now(),
      validActivity: false,
    };
    responses.push(entry);
    if (request.path !== "/api/session/activity" || entry.status !== 200)
      return;
    const deadline = new AbortController();
    const delivery = Promise.race([
      response.json(),
      delay(5000, null, { signal: AbortSignal.any([signal, deadline.signal]) }),
    ])
      .then((value) => {
        const expires = Date.parse(value.expires_at);
        const idle = Date.parse(value.idle_expires_at);
        entry.validActivity =
          Object.keys(value).sort().join(",") ===
            "activity_interval_ms,expires_at,idle_expires_at" &&
          Number.isFinite(expires) &&
          Number.isFinite(idle) &&
          idle <= expires &&
          Number.isInteger(value.activity_interval_ms) &&
          value.activity_interval_ms >= 1 &&
          value.activity_interval_ms <= 30_000;
      })
      .catch(() => {})
      .finally(() => {
        deadline.abort();
        deliveries.delete(delivery);
      });
    deliveries.add(delivery);
  };
  const model = async () => {
    const response = await fetch(`${config.model}/status`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    });
    assert.equal(response.status, 200);
    const value = await response.json();
    assert(
      Array.isArray(value.errors) && value.errors.length === 0,
      "controlled model reported a validation error",
    );
    return value;
  };
  page.on("request", record);
  page.on("response", delivered);
  try {
    await page
      .getByRole("button", { name: "New conversation", exact: true })
      .click();
    const composer = page.getByRole("combobox", {
      name: "Message",
      exact: true,
    });
    await until(
      () => composer.isEnabled(),
      "New conversation composer",
      signal,
    );
    await composer.fill(phase);
    const [accepted] = await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname.endsWith("/prompts") &&
          response.request().method() === "POST",
      ),
      composer.press("Enter"),
    ]);
    assert.equal(accepted.status(), 202);
    const promptPath = new URL(accepted.url()).pathname;
    assert(promptPath.startsWith(`${base}/sessions/`));
    const sessionId = decodeURIComponent(
      promptPath.slice(`${base}/sessions/`.length, -"/prompts".length),
    );
    assert(sessionId && !sessionId.includes("/"));
    const admission = await accepted.json();
    assert(admission.operationId);
    await until(
      async () => (await model()).pending.includes(phase),
      "Silent accepted Run",
      signal,
    );
    await until(
      () => composer.isDisabled(),
      "Busy composer before lease renewal",
      signal,
    );
    const isObserver = (response) =>
      response.request.path === `${base}/events` &&
      response.request.sessionId === sessionId &&
      response.request.method === "GET" &&
      response.status === 200 &&
      response.contentType.startsWith("text/event-stream");
    const initialObserver = await until(
      () => responses.find(isObserver),
      "Successful initial observer for the accepted Session",
      signal,
    );
    // Anchor the quiet interval to an admitted observer of this exact Session,
    // then exceed the producer's 60s CCT plus the 30s downstream clock allowance.
    const startedAt = performance.now();
    const first = requests.length;
    while (performance.now() - startedAt < 95_000) {
      const step = Math.floor((performance.now() - startedAt) / 400);
      await page.mouse.move(100 + (step % 20), 100);
      await delay(400, undefined, { signal });
    }
    const held = await model();
    assert(
      held.pending.includes(phase),
      "observer expiry must not cancel accepted model work",
    );
    assert.equal(
      held.requests.filter((request) => request.phase === phase).length,
      1,
    );
    assert(
      !held.requests.find((request) => request.phase === phase).disconnected,
    );
    const release = await fetch(`${config.model}/release/${phase}`, {
      method: "POST",
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    });
    assert.equal(release.status, 200);
    const releasedAt = performance.now();
    await page
      .locator(".message-assistant .message-content")
      .filter({ hasText: `${phase} completed` })
      .waitFor({ timeout: 20_000 });
    await until(
      () => composer.isEnabled(),
      "Terminal state after CCT renewal",
      signal,
      20_000,
    );
    const elapsedMs = Math.round(performance.now() - releasedAt);
    const final = await model();
    assert.equal(
      final.requests.filter((request) => request.phase === phase).length,
      1,
      "reconnection must not repeat model inference",
    );
    assert(
      !final.requests.find((request) => request.phase === phase).disconnected,
    );
    const observed = requests
      .slice(first)
      .filter((request) => request.at < releasedAt);
    const reads = observed.filter((request) => request.path.startsWith(base));
    assert(
      reads.every(
        (request) =>
          request.method === "GET" &&
          [base + "/view", base + "/events"].includes(request.path) &&
          request.sessionId === sessionId,
      ),
      "quiet Run must not be refreshed by unrelated Workspace reads or writes",
    );
    const renewed = responses.filter(
      (response) =>
        isObserver(response) &&
        response !== initialObserver &&
        response.request.at - startedAt >= 30_000 &&
        response.at < releasedAt,
    );
    assert(
      renewed.length > 0,
      "the browser must renew the original short-lived delegation before the five-minute Gateway lease",
    );
    assert(
      releasedAt - initialObserver.at > 90_000,
      "terminal delivery must follow the original CCT acceptance window",
    );
    await Promise.allSettled([...deliveries]);
    const activity = responses.filter(
      (response) =>
        response.request.method === "POST" &&
        response.validActivity &&
        response.request.at >= startedAt &&
        response.at < releasedAt,
    );
    assert(
      activity.length >= 2,
      "genuine input must continue reporting browser activity independently of observer renewal",
    );
    assert.equal(
      requests.filter(
        (request) =>
          request.path.endsWith("/prompts") && request.method === "POST",
      ).length,
      1,
    );
    return {
      heldMs: Math.round(releasedAt - startedAt),
      terminalAfterReleaseMs: elapsedMs,
      observerRenewals: renewed.length,
      genuineActivityReports: activity.length,
      modelRequests: 1,
      promptRequests: 1,
    };
  } finally {
    page.off("request", record);
    page.off("response", delivered);
    await Promise.allSettled([...deliveries]);
  }
}
