import assert from "node:assert/strict";
import { inspect } from "node:util";

export function respondToJwks(request, response, authentication, failures) {
  const allowed =
    request.headers["antnest-service-authorization"] ===
      `Bearer ${authentication.outgoing}` &&
    request.headers["antnest-caller-context"] === undefined;
  if (!allowed) {
    // This runs in an HTTP event listener, outside the scenario's try/finally.
    // Preserve a failure without throwing past Docker resource cleanup.
    failures.push(
      new Error("Identity fixture received invalid private authority"),
    );
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: "fixture_authentication_failed" }));
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(authentication.jwks));
}

export function inspectLogs(logs, runtimeToken, privateValues = new Set()) {
  for (const secret of [runtimeToken, ...privateValues])
    assert(!logs.includes(secret), "ACP logs included private authority");
}

export function redactFailure(error, privateValues) {
  let publicText = inspect(error, {
    depth: 8,
    customInspect: false,
    getters: false,
    maxStringLength: null,
  });
  for (const secret of [...privateValues]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length))
    publicText = publicText.replaceAll(secret, "[REDACTED]");
  return new Error(publicText.slice(0, 16_384));
}
