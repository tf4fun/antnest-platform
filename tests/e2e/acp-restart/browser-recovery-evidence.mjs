import assert from "node:assert/strict";
import { gatewaySessionCookies } from "../../support/gateway-session-cookies.mjs";

export function assertBrowserRecoveryRequests(
  rows,
  expected,
  { beforeDispatch = false } = {},
) {
  assert(Array.isArray(rows));
  const endpoint = `/api/admin/agents/${encodeURIComponent(expected.agent_id)}/rebuild`;
  const query = `/api/admin/operations/${encodeURIComponent(expected.request_id)}`;
  const mutations = rows.filter(
    (row) =>
      !["GET", "HEAD"].includes(row.method) &&
      !(row.method === "POST" && row.path === "/api/session/activity"),
  );
  assert.equal(
    mutations.length,
    beforeDispatch ? 0 : 1,
    "unexpected browser business mutation",
  );
  if (beforeDispatch) return;
  const post = mutations[0];
  assert.equal(post.method, "POST");
  assert.equal(post.path, endpoint);
  assert.equal(post.headers["idempotency-key"], expected.request_id);
  const cookies = gatewaySessionCookies(post.headers.cookie ?? "");
  assert(
    cookies.accessToken && cookies.csrf,
    "original browser session pair required",
  );
  assert.equal(post.headers["x-antnest-csrf-token"], cookies.csrf);
  assert.deepEqual(post.body, expected.body);
  const prior = rows
    .slice(0, rows.indexOf(post))
    .filter((row) => row.method === "GET" && row.path === query);
  assert(
    prior.length > 0,
    "recovery must query the original request before dispatch",
  );
  for (const row of prior) {
    assert.equal(row.status, 404);
    assert.equal(row.responseBody?.code, "operation_not_found");
  }
  assert.equal(post.status, 202);
  const operation = post.responseBody;
  assert.equal(operation?.request_id, expected.request_id);
  assert.equal(operation.agent_id, expected.agent_id);
  assert.equal(operation.kind, "rebuild");
  assert(["running", "completed"].includes(operation.state));
  assert(typeof operation.phase === "string" && operation.phase.length > 0);
  return post;
}
