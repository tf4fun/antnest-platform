import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { rpcMessages } from "./acp-gate-responses.mjs";

export function assertCanonicalBusy(error, definition) {
  assert.ok(error && typeof error === "object");
  assert.deepEqual(Object.keys(error).sort(), ["code", "data", "message"]);
  assert.equal(error.code, definition.json_rpc_code);
  assert.equal(error.message, definition.message);
  const data = { ...error.data };
  if (Object.hasOwn(data, "details")) {
    assert.deepEqual(data.details, {});
    delete data.details;
  }
  assert.deepEqual(data, {
    code: "agent_busy",
    retryable: definition.retryable,
    retry_after_ms: definition.retry_after_ms,
  });
}

// This validates complete raw evidence. Request ordering proves that each
// lookup started between attempts; the service tests separately prove that
// the actual lookup settles before dispatch, without clock/Trace assumptions.
export function assertOriginalAdmissionRetry({
  state,
  baseline,
  original,
  definition,
}) {
  const messages = rpcMessages(state, baseline);
  const attempts = state.records.flatMap((record, recordIndex) => {
    if (recordIndex < baseline.records.length || record.method !== "POST")
      return [];
    const message = JSON.parse(record.body);
    if (
      message.method !== "session/prompt" ||
      message.params?._meta?.["antnest.dev/intent"]?.intentId !==
        original.body.intentId
    )
      return [];
    return [{ recordIndex, record, message }];
  });
  assert.ok(
    attempts.length >= 2 && attempts.length <= 4,
    "Original Prompt must retry within four total dispatches",
  );
  const ids = new Set();
  const rejections = [],
    unknownQueries = [];
  for (const [index, attempt] of attempts.entries()) {
    const { message, record, recordIndex } = attempt;
    assert.equal(record.forwarded, true);
    assert.ok(
      !ids.has(JSON.stringify(message.id)),
      "Duplicate original Prompt RPC id",
    );
    ids.add(JSON.stringify(message.id));
    assert.deepEqual(
      {
        sessionId: message.params.sessionId,
        prompt: message.params.prompt,
        intent: message.params._meta["antnest.dev/intent"],
      },
      {
        sessionId: original.sessionId,
        prompt: original.body.prompt,
        intent: {
          intentId: original.body.intentId,
          expectedAppendVersion: original.body.expectedAppendVersion,
        },
      },
    );
    const responses = messages.filter(
      (row) =>
        isDeepStrictEqual(row.message.id, message.id) &&
        (Object.hasOwn(row.message, "result") ||
          Object.hasOwn(row.message, "error")),
    );
    assert.equal(
      responses.length,
      1,
      "Each original Prompt needs one complete actual ACP response",
    );
    const response = responses[0];
    if (index === attempts.length - 1) {
      assert.equal(response.message.error, undefined);
      assert.equal(response.message.result?.stopReason, "end_turn");
    } else {
      assertCanonicalBusy(response.message.error, definition);
      rejections.push(response);
    }
    if (index === 0) continue;
    const path = `/rpc/agent-acp/workspace/sessions/${encodeURIComponent(original.sessionId)}/intents/${encodeURIComponent(original.body.intentId)}`;
    const queries = state.records.flatMap((candidate, queryIndex) => {
      if (
        queryIndex <= attempts[index - 1].recordIndex ||
        queryIndex >= recordIndex ||
        candidate.method !== "GET" ||
        candidate.path !== path ||
        candidate.forwarded !== true
      )
        return [];
      const captured = candidate.response;
      if (
        captured?.statusCode !== 404 ||
        captured.complete !== true ||
        !captured.contentType?.startsWith("application/json")
      )
        return [];
      assert.ok(
        Array.isArray(captured.chunks) &&
          captured.chunks.every((chunk) => typeof chunk === "string"),
      );
      const body = JSON.parse(
        Buffer.concat(
          captured.chunks.map((chunk) => Buffer.from(chunk, "base64")),
        ).toString("utf8"),
      );
      return body?.code === "intent_unknown"
        ? [{ recordIndex: queryIndex, body, record: candidate }]
        : [];
    });
    assert.ok(
      queries.length > 0,
      "Automatic retry needs a complete typed unknown lookup of its original intent",
    );
    unknownQueries.push(...queries);
  }
  return { attempts, rejections, unknownQueries };
}
