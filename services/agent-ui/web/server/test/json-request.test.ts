import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import { HttpInputError, validateJsonRequest } from "../src/http/json-request.ts";
import { BodyTooLargeError, readBody } from "../src/http/command-routes.ts";
import { bindAuthenticatedRequest, verifiedRequestContext, type Delegation } from "../src/http/trusted-identity.ts";
import { testContext } from "./support/auth-fixture.ts";

const incoming = (body: string) => new Request("http://workspace.internal/api/app/workspace/v1/agents/a/sessions/s/prompts", {
  method: "POST", headers: { "content-type": "application/json" }, body,
});

test("validated JSON preserves authority and is consumed once by the owning route", async () => {
  const input = incoming('{"value":"body"}');
  const context = testContext({ agt: "a" });
  const delegation: Delegation = { token: context.token, claims: context.claims };
  bindAuthenticatedRequest(input, delegation);
  const request = await validateJsonRequest(input);
  assert.equal(verifiedRequestContext(request.headers), delegation);
  assert.deepEqual(await readBody(request), { value: "body" });
  assert.equal(request.bodyUsed, true);
  await assert.rejects(readBody(request));
});

test("a validated body still obeys a smaller route byte limit without Content-Length", async () => {
  const request = await validateJsonRequest(incoming('{"value":"' + "x".repeat(32) + '"}'));
  await assert.rejects(readBody(request, 16), BodyTooLargeError);
});

test("clones and direct route requests still reject invalid or duplicate JSON", { timeout: 5000 }, async () => {
  for (const body of ['{"a":1,"\\u0061":2}', '{"a":"\\x"}', '[]']) {
    await assert.rejects(validateJsonRequest(incoming(body)));
    await assert.rejects(readBody(incoming(body)));
  }
  const request = await validateJsonRequest(incoming('{"value":1}'));
  const clone = request.clone();
  assert.deepEqual(await readBody(request), { value: 1 });
  assert.deepEqual(await readBody(clone), { value: 1 });
});

test("an oversized clone rejects before its unread sibling is consumed", { timeout: 5000 }, async () => {
  const original = await validateJsonRequest(incoming('{"value":"' + "x".repeat(32) + '"}'));
  const clone = original.clone();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = readBody(clone, 16);
  try {
    await assert.rejects(Promise.race([
      read,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Oversized clone waited for its sibling")), 250); }),
    ]), BodyTooLargeError);
    assert.equal(clone.body!.locked, false);
  } finally {
    clearTimeout(timer);
    await original.body!.cancel();
    await read.catch(() => {});
  }
});

test("aborting validation releases its clone without waiting for an unread sibling", { timeout: 5000 }, async () => {
  const abort = new AbortController();
  const reason = new Error("cancel this validation");
  let sourceCancelled = false;
  const original = new Request("http://workspace.internal/input", {
    method: "POST", headers: { "content-type": "application/json" }, signal: abort.signal,
    body: new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Buffer.from('{"value":')); },
      cancel() { sourceCancelled = true; },
    }), duplex: "half",
  } as RequestInit & { duplex: "half" });
  const clone = original.clone();
  const validation = validateJsonRequest(clone);
  void validation.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await turn();
    abort.abort(reason);
    await assert.rejects(Promise.race([
      validation,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Aborted clone waited for its sibling")), 250); }),
    ]), (error: unknown) => error === reason);
    assert.equal(clone.body!.locked, false);
    assert.equal(sourceCancelled, false, "the unread sibling still owns its source");
  } finally {
    clearTimeout(timer);
    await original.body!.cancel();
    await validation.catch(() => {});
  }
  assert.equal(sourceCancelled, true);
});

test("validation rejects an oversized clone while its sibling remains unread", { timeout: 5000 }, async () => {
  const original = incoming('{"value":"' + "x".repeat(32) + '"}');
  const clone = original.clone();
  const validation = validateJsonRequest(clone, 16);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await assert.rejects(Promise.race([
      validation,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Validation waited for its oversized clone sibling")), 250); }),
    ]), (error: unknown) => error instanceof HttpInputError && error.status === 413 && error.code === "request_too_large");
    assert.equal(original.bodyUsed, false);
    assert.equal(clone.body!.locked, false);
  } finally {
    clearTimeout(timer);
    await original.body!.cancel();
    await validation.catch(() => {});
  }
});
