import { gatewayOrigin } from "../../support/gateway-origin.mjs";
import assert from "node:assert/strict";
import { registerFixturePrincipal } from "./stage2-transport.mjs";

export async function gatewayLogin(origin, organizationSlug, email, password) {
  const response = await fetch(`${origin}/api/session/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: gatewayOrigin(origin),
    },
    body: JSON.stringify({
      organization_slug: organizationSlug,
      email,
      password,
    }),
    signal: AbortSignal.timeout(20000),
  });
  assert.equal(response.status, 200, "Gateway login failed");
  const payload = await response.json();
  registerFixturePrincipal(payload.principal);
  const pairs = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0]);
  assert(
    pairs.some(
      (pair) =>
        pair.startsWith("antnest_session=") &&
        pair.length > "antnest_session=".length,
    ),
  );
  const csrf = pairs
    .find((pair) => pair.startsWith("antnest_csrf="))
    ?.slice("antnest_csrf=".length);
  assert(csrf, "Gateway CSRF cookie missing");
  return { cookie: pairs.join("; "), csrf, principal: payload.principal };
}

export async function gatewayCommand(origin, login, path, body, requestId) {
  const response = await fetch(origin + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: gatewayOrigin(origin),
      cookie: login.cookie,
      "x-antnest-csrf-token": login.csrf,
      "idempotency-key": requestId,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const payload = await response.json();
  assert.equal(
    response.status,
    202,
    `Gateway ${path}: ${JSON.stringify(payload)}`,
  );
  const traceId = response.headers.get("x-antnest-trace-id");
  assert.match(traceId ?? "", /^[0-9a-f]{32}$/u);
  return { payload, traceId };
}
