import assert from "node:assert/strict";
import { gatewaySessionCookies } from "../../support/gateway-session-cookies.mjs";

export function assertConsoleSessionPost(
  headers,
  { path, currentHint, issuedHints },
) {
  // These are the same request's original headers. A later Cookie injection or
  // Set-Cookie response cannot rewrite a request already dispatched by a page.
  const { csrf } = gatewaySessionCookies(headers.cookie ?? "");
  assert(csrf && issuedHints.has(csrf), "original issued CSRF Cookie required");
  assert.equal(
    headers["x-antnest-csrf-token"],
    csrf,
    "request Cookie/header mismatch",
  );
  const current = csrf === currentHint;
  if (path !== "/api/session/activity")
    assert(current, "stale mutation delivery");
  return current;
}
