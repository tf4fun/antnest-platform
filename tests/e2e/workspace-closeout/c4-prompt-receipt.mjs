import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { gatewaySessionCookies } from "../../support/gateway-session-cookies.mjs";

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("C4 Prompt receipt is not valid JSON");
  }
}

export async function captureC4PromptReceipt(
  page,
  response,
  { gateway, agentId, cookies },
  evidence,
) {
  const request = response.request(),
    url = new URL(response.url());
  assert(
    request.frame() === page.mainFrame(),
    "C4 Prompt belongs to another page",
  );
  assert(
    url.origin === new URL(gateway).origin,
    "C4 Prompt belongs to another Gateway",
  );
  assert(
    request.url() === url.href && request.redirectedFrom() === null,
    "C4 Prompt was redirected",
  );
  const path = url.pathname.match(
    /^\/api\/app\/workspace\/v1\/agents\/([^/]+)\/sessions\/([^/]+)\/prompts$/u,
  );
  assert(path && !url.search && !url.hash, "original C4 Prompt path required");
  assert(
    decodeURIComponent(path[1]) === agentId,
    "C4 Prompt belongs to another Agent",
  );
  assert.equal(request.method(), "POST");
  const sent = await request.allHeaders(),
    expected = gatewaySessionCookies(cookies),
    actual = gatewaySessionCookies(sent.cookie ?? "");
  assert(
    expected.accessToken && expected.csrf,
    "original C4 page authority required",
  );
  assert(
    isDeepStrictEqual(actual, expected) &&
      sent["x-antnest-csrf-token"] === expected.csrf,
    "C4 Prompt uses another browser authority",
  );
  const rawRequest = request.postData(),
    body = parse(rawRequest);
  assert(
    typeof body.intentId === "string" &&
      body.intentId &&
      body.intentId === sent["idempotency-key"] &&
      typeof sent["if-match"] === "string" &&
      sent["if-match"].length > 0 &&
      Number.isSafeInteger(body.expectedAppendVersion) &&
      body.expectedAppendVersion >= 0 &&
      Array.isArray(body.prompt) &&
      body.prompt[0]?.type === "text" &&
      typeof body.prompt[0].text === "string" &&
      body.prompt[0].text.length > 0,
    "original C4 Prompt admission required",
  );
  Object.assign(evidence, {
    method: "POST",
    path: url.pathname,
    agentId,
    sessionId: decodeURIComponent(path[2]),
    phase: body.prompt[0].text,
    original_browser_authority: true,
    request: { rawBody: rawRequest, body, historyToken: sent["if-match"] },
    status: response.status(),
  });
  const headers = await response.headersArray(),
    values = (name) =>
      headers
        .filter((header) => header.name.toLowerCase() === name)
        .map((header) => header.value);
  const traces = values("x-antnest-trace-id"),
    dates = values("date");
  // Preserve an unambiguous original Trace before body reads or contract
  // assertions can fail, so that failure still gets an independent archive.
  if (traces.length === 1 && /^(?!0{32}$)[a-f0-9]{32}$/u.test(traces[0]))
    evidence.traceID = traces[0];
  if (dates.length === 1 && Number.isFinite(Date.parse(dates[0])))
    evidence.serverDate = dates[0];
  evidence.rawBody = await response.text();
  evidence.body = parse(evidence.rawBody);
  evidence.receivedAt = Date.now();
  assert.equal(evidence.status, 202, "C4 page Prompt was not accepted");
  assert(
    traces.length === 1 && /^(?!0{32}$)[a-f0-9]{32}$/u.test(traces[0]),
    "original C4 Prompt Trace required",
  );
  assert(
    dates.length === 1 && Number.isFinite(Date.parse(dates[0])),
    "original C4 Prompt HTTP Date required",
  );
  assert.equal(
    values("set-cookie").length,
    0,
    "C4 Prompt replaced browser authority",
  );
  assert(
    isDeepStrictEqual(evidence.body, {
      operationId: body.intentId,
      acceptance: "bridge",
      phase: "dispatching",
    }),
    "C4 accepted another operation",
  );
  return evidence;
}
