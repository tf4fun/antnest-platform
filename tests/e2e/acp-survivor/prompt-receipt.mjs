import assert from "node:assert/strict";

export async function readSurvivorPromptReceipt({
  response,
  page,
  agentId,
  phase,
  onPhase = async () => {},
}) {
  const rawBody = await response.text();
  assert.equal(
    response.status(),
    202,
    "Original browser Prompt was not accepted",
  );
  const request = response.request();
  assert.equal(request.frame(), page.mainFrame());
  assert.equal(request.redirectedFrom(), null);
  assert.equal(request.url(), response.url());
  const input = request.postDataJSON();
  assert(typeof input.intentId === "string" && input.intentId.length > 0);
  assert.deepEqual(input.prompt, [{ type: "text", text: phase }]);
  await onPhase("prompt-headers");
  // The idempotency key is an ordinary sent header. Security/transport extra
  // metadata is unrelated to this receipt and can still be pending indefinitely.
  const headers = request.headers();
  assert.equal(headers["idempotency-key"], input.intentId);
  assert.deepEqual(JSON.parse(rawBody), {
    operationId: input.intentId,
    acceptance: "bridge",
    phase: "dispatching",
  });
  const path = new URL(response.url()).pathname.match(
    /^\/api\/app\/workspace\/v1\/agents\/([^/]+)\/sessions\/([^/]+)\/prompts$/u,
  );
  assert(path);
  assert.equal(decodeURIComponent(path[1]), agentId);
  return {
    agentId,
    sessionId: decodeURIComponent(path[2]),
    phase,
    operationId: input.intentId,
  };
}
