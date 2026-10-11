import assert from "node:assert/strict";

export function createSessionCloseObserver(now = Date.now) {
  let event,
    localClose = false;
  const closed = Promise.withResolvers();
  return {
    markLocalClose() {
      localClose = true;
    },
    record(code, reason) {
      if (event) return;
      event = { code, reason: reason?.toString() ?? "", at: now(), localClose };
      closed.resolve(event);
    },
    async wait(timeoutMs = 30000) {
      assert(Number.isFinite(timeoutMs) && timeoutMs > 0);
      let timer;
      try {
        return await Promise.race([
          closed.promise,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("remote close wait timed out")),
              timeoutMs,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function sessionCloseCheckpoint(client, now = Date.now) {
  return { at: now(), requests: structuredClone(client.requests) };
}

export async function expectSilentSessionClose(
  client,
  checkpoint,
  reason,
  method,
  params,
) {
  const expected = {
    revoked: { code: 1008, reasons: ["session_rejected"] },
    expired: {
      code: 1008,
      reasons: ["caller_context_expired", "session_rejected"],
    },
    unavailable: { code: 1013, reasons: ["identity_unavailable"] },
  }[reason];
  assert(expected, "unknown session closure cause");
  const deadline = checkpoint.at + 30000;
  const event = await client.waitForClose(Math.max(1, deadline - Date.now()));
  assert.equal(
    event.localClose,
    false,
    "local shutdown cannot prove remote revocation",
  );
  assert.equal(event.code, expected.code, "wrong remote session close code");
  assert(
    expected.reasons.includes(event.reason),
    "wrong remote session close reason",
  );
  assert(
    Number.isFinite(event.at) &&
      event.at >= checkpoint.at &&
      event.at <= deadline,
    "session closed before the trigger or beyond its bound",
  );
  // The five-second fixture is shorter than the CCT lifetime and idle policy.
  // CCT exp is the issued absolute deadline rounded down to a whole second.
  const derivedCCTExpiresAt = Math.floor(checkpoint.expiresAt / 1000) * 1000;
  if (reason === "expired")
    assert(
      Number.isFinite(checkpoint.expiresAt) &&
        event.at >= derivedCCTExpiresAt - 1000 &&
        event.at <= derivedCCTExpiresAt,
      "closure does not match the issued expiry and closing grace",
    );
  assert.deepEqual(
    client.requests,
    checkpoint.requests,
    "silent probe sent an SDK request",
  );
  await assert.rejects(() => client.request(method, params));
  assert.deepEqual(
    client.requests,
    checkpoint.requests,
    "post-close probe sent an SDK request",
  );
  assert.match(
    client.traceID ?? "",
    /^[a-f0-9]{32}$/,
    "actual connection trace ID missing",
  );
  assert(
    [1, 2].includes(client.version),
    "connection protocol version missing",
  );
  return {
    connectionTraceID: client.traceID,
    agentId: client.agentId,
    version: client.version,
    transport: "websocket",
    reason,
    closeCode: event.code,
    closeReason: event.reason,
    startedAt: checkpoint.at,
    closedAt: event.at,
    requestCount: checkpoint.requests.length,
    postCloseRequestSent: false,
    localClose: false,
    ...(reason === "expired"
      ? { expiresAt: checkpoint.expiresAt, derivedCCTExpiresAt }
      : {}),
  };
}
