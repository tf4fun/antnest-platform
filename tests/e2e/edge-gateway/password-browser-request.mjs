import { randomUUID } from "node:crypto";

const networkFailures = new Set([
  "net::ERR_ABORTED",
  "net::ERR_CONNECTION_CLOSED",
  "net::ERR_CONNECTION_REFUSED",
  "net::ERR_CONNECTION_RESET",
  "net::ERR_EMPTY_RESPONSE",
  "net::ERR_FAILED",
  "net::ERR_HTTP2_PROTOCOL_ERROR",
  "net::ERR_INTERNET_DISCONNECTED",
  "net::ERR_NAME_NOT_RESOLVED",
  "net::ERR_NETWORK_CHANGED",
  "net::ERR_SSL_PROTOCOL_ERROR",
  "net::ERR_TIMED_OUT",
]);

function failureKind(error) {
  return error?.name === "TimeoutError"
    ? "timeout"
    : error?.name === "AbortError"
      ? "aborted"
      : error?.name === "TypeError"
        ? "type_error"
        : "transport_failed";
}

function traceID(value) {
  return typeof value === "string" &&
    /^[0-9a-f]{32}$/.test(value) &&
    value !== "0".repeat(32)
    ? value
    : null;
}

// Runs in the browser. Return bounded metadata even when fetching or reading
// the body fails; exception messages can contain credentials or response data.
async function browserFetch({ path, body, csrf, call_id }) {
  const receipt = {
    state: "rejected",
    http_status: null,
    trace_id: null,
    body_consumed: false,
  };
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Antnest-CSRF-Token": csrf,
        "Idempotency-Key": call_id,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25000),
    });
    receipt.http_status = response.status;
    const value = response.headers.get("x-antnest-trace-id");
    receipt.trace_id =
      typeof value === "string" &&
      /^[0-9a-f]{32}$/.test(value) &&
      value !== "0".repeat(32)
        ? value
        : null;
    await response.arrayBuffer();
    receipt.body_consumed = true;
    receipt.state = "fulfilled";
  } catch (error) {
    receipt.failure_kind =
      error?.name === "TimeoutError"
        ? "timeout"
        : error?.name === "AbortError"
          ? "aborted"
          : error?.name === "TypeError"
            ? "type_error"
            : "transport_failed";
  }
  return receipt;
}

export async function passwordBrowserRequest({
  page,
  gateway,
  path,
  body,
  csrf,
  record,
}) {
  const started = performance.now();
  const call_id = randomUUID();
  const expected = new URL(path, gateway).href;
  const receipt = {
    route: path,
    call_id,
    response_observer: { state: "pending" },
    browser_fetch: { state: "pending" },
    request_count: 0,
    request_failures: [],
    request_failure_count: 0,
    duration_ms: 0,
  };
  const checkpoint = () => {
    receipt.duration_ms = Math.max(0, Math.round(performance.now() - started));
    record(structuredClone(receipt));
  };
  const matches = (request) =>
    request.url() === expected &&
    request.method() === "POST" &&
    request.headers()["idempotency-key"] === call_id;
  const requested = (request) => {
    if (!matches(request)) return;
    receipt.request_count++;
    checkpoint();
  };
  const failed = (request) => {
    if (!matches(request)) return;
    receipt.request_failure_count++;
    if (receipt.request_failures.length < 4) {
      const kind = request.failure()?.errorText;
      receipt.request_failures.push({
        kind: networkFailures.has(kind) ? kind : "unrecognized",
        elapsed_ms: Math.max(0, Math.round(performance.now() - started)),
      });
    }
    checkpoint();
  };
  page.on("request", requested);
  page.on("requestfailed", failed);
  try {
    checkpoint();
    const observe = async () => {
      try {
        const response = await page.waitForResponse(
          (value) => matches(value.request()),
          { timeout: 30000 },
        );
        receipt.response_observer = {
          state: "fulfilled",
          http_status: response.status(),
          trace_id: traceID(await response.headerValue("x-antnest-trace-id")),
        };
        return response;
      } catch (error) {
        receipt.response_observer = {
          state: "rejected",
          failure_kind: failureKind(error),
        };
      } finally {
        checkpoint();
      }
    };
    const fetchOnce = async () => {
      try {
        receipt.browser_fetch = await page.evaluate(browserFetch, {
          path,
          body,
          csrf,
          call_id,
        });
      } catch (error) {
        receipt.browser_fetch = {
          state: "evaluation_rejected",
          http_status: null,
          trace_id: null,
          body_consumed: false,
          failure_kind: failureKind(error),
        };
      } finally {
        checkpoint();
      }
    };
    // Wait for both outcomes without losing the browser failure when the
    // response observer times out. There is still exactly one POST and neither
    // side can substitute for the other to make this assertion pass.
    const settled = await Promise.allSettled([observe(), fetchOnce()]);
    const observed = receipt.response_observer;
    const fetched = receipt.browser_fetch;
    if (
      settled.some((value) => value.status === "rejected") ||
      observed.state !== "fulfilled" ||
      fetched.state !== "fulfilled" ||
      !fetched.body_consumed ||
      fetched.http_status !== observed.http_status ||
      fetched.trace_id !== observed.trace_id
    ) {
      const error = new Error(
        "password browser request did not complete consistently on both sides",
      );
      if (observed.failure_kind === "timeout") error.name = "TimeoutError";
      throw error;
    }
    return settled[0].value;
  } finally {
    page.off("request", requested);
    page.off("requestfailed", failed);
    checkpoint();
  }
}
