import assert from "node:assert/strict";
import { gatewaySessionCookies } from "../../support/gateway-session-cookies.mjs";
import { assertOrganizationSession } from "../identity-closeout/organization-session.mjs";
import { member } from "./c4-setup.mjs";

function parsed(read, message) {
  try {
    return read();
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // Native JSON diagnostics can quote passwords or tokens from the body.
    throw new Error(message);
  }
}

export async function captureC4Login(
  page,
  response,
  { gateway, ownerId, startedMono, startedAt },
) {
  assert(
    Number.isFinite(startedMono) && Number.isFinite(startedAt),
    "original C4 login trigger window required",
  );
  assert(response, "original C4 page login response required");
  assert(
    response.url() === new URL("/api/session/login", gateway).href,
    "C4 login response belongs to another endpoint",
  );
  const request = response.request();
  assert(
    request.frame() === page.mainFrame(),
    "C4 login belongs to another page",
  );
  assert.equal(request.method(), "POST");
  const sent = parsed(
    () => request.postDataJSON(),
    "C4 login request is not valid JSON",
  );
  assert(
    sent &&
      Object.keys(sent).length === Object.keys(member).length &&
      Object.entries(member).every(([field, value]) => sent[field] === value),
    "C4 page dispatched a different member login",
  );
  assert.equal(response.status(), 200);
  const rawBody = await response.text();
  const issued = parsed(
    () => JSON.parse(rawBody),
    "C4 login response is not valid JSON",
  );
  assert(
    issued?.principal?.organization_slug === "stage3" &&
      issued.principal.organization_name === "Stage 3",
    "C4 login belongs to another Organization",
  );
  const principal = assertOrganizationSession(issued, "login");
  assert(principal.user_id === ownerId, "C4 page logged in another owner");
  assert.equal(principal.active, true);
  assert.equal(principal.system_role, "user");
  assert.equal(principal.organization_role, "member");
  const headers = await response.headersArray();
  const values = (name) =>
    headers
      .filter((header) => header.name.toLowerCase() === name)
      .map((header) => header.value);
  const single = (name) => {
    const found = values(name);
    assert.equal(found.length, 1, `original C4 login ${name} required`);
    return found[0];
  };
  const traceID = single("x-antnest-trace-id"),
    serverDate = single("date");
  assert(
    /^(?!0{32}$)[a-f0-9]{32}$/u.test(traceID),
    "original C4 login Trace is invalid",
  );
  const date = Date.parse(serverDate),
    expires = Date.parse(issued.expires_at),
    idle = Date.parse(issued.idle_expires_at);
  assert(Number.isFinite(date) && new Date(date).toUTCString() === serverDate);
  assert(
    Number.isFinite(expires) &&
      Number.isFinite(idle) &&
      idle > date &&
      idle <= expires,
    "invalid original C4 login lifetime",
  );
  const setCookies = values("set-cookie");
  assert.equal(setCookies.length, 2, "original C4 login Cookie pair required");
  const expected = gatewaySessionCookies(setCookies);
  assert(
    expected.accessToken && expected.csrf,
    "complete original C4 login authority required",
  );
  const actual = gatewaySessionCookies(
    (await page.context().storageState()).cookies,
  );
  assert(
    Object.keys(expected).every((key) => actual[key] === expected[key]),
    "C4 browser authority differs from its original login",
  );
  const cookies = Object.freeze([
    Object.freeze({ name: expected.sessionName, value: expected.accessToken }),
    Object.freeze({ name: expected.csrfName, value: expected.csrf }),
  ]);
  Object.freeze(issued.principal);
  Object.freeze(issued);
  const completedMono = performance.now(),
    completedAt = Date.now();
  assert(completedMono >= startedMono && completedAt >= startedAt);
  return Object.freeze({
    issued,
    cookies,
    receipt: Object.freeze({
      method: "POST",
      path: "/api/session/login",
      status: 200,
      traceID,
      serverDate,
      rawBody,
      startedMono,
      startedAt,
      completedMono,
      completedAt,
    }),
  });
}
