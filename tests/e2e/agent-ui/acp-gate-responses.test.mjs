import assert from "node:assert/strict";
import { test } from "node:test";
import { rpcMessages } from "./acp-gate-responses.mjs";

const previous = {
  jsonrpc: "2.0",
  id: 10,
  result: { stopReason: "end_turn" },
};
const busy = {
  jsonrpc: "2.0",
  id: 11,
  error: {
    code: -32030,
    message: "Agent already has an active Run",
    data: { code: "agent_busy", retryable: true, retry_after_ms: 1000 },
  },
};
const completed = {
  jsonrpc: "2.0",
  id: 12,
  result: { stopReason: "end_turn" },
};
const empty = () => ({ records: [], captureErrors: [] });
const state = (...records) => ({ records, captureErrors: [] });
const frame = (message, newline = "\n") =>
  Buffer.from("data: " + JSON.stringify(message) + newline + newline);

function record(chunks, { type = "text/event-stream", complete = false } = {}) {
  const json = type.startsWith("application/json");
  return {
    method: json ? "POST" : "GET",
    path: "/v1/acp",
    body: json
      ? JSON.stringify({
          jsonrpc: "2.0",
          id: 12,
          method: "session/prompt",
          params: {
            sessionId: "session-1",
            prompt: [{ type: "text", text: "explicit next intent" }],
          },
        })
      : null,
    forwarded: true,
    response: {
      statusCode: 200,
      contentType: type,
      chunks: (Array.isArray(chunks) ? chunks : [chunks]).map((chunk) =>
        chunk.toString("base64"),
      ),
      complete,
      closed: complete,
    },
  };
}

test("a complete old SSE frame is excluded while a complete new busy frame is returned", () => {
  const old = frame(previous);
  const baseline = state(record(old));
  const current = state(record(Buffer.concat([old, frame(busy)])));
  const original = structuredClone({ baseline, current });

  assert.deepEqual(rpcMessages(current, baseline), [
    { recordIndex: 0, message: busy },
  ]);
  assert.deepEqual({ baseline, current }, original);
});

for (const [name, newline, offset] of [
  ["inside LF/LF", "\n", 1],
  ["inside the first CRLF", "\r\n", 1],
  ["between CRLF and CRLF", "\r\n", 2],
  ["inside the second CRLF", "\r\n", 3],
]) {
  test(`a baseline ${name} preserves the following complete RPC frame`, () => {
    const old = frame(previous, newline);
    const cut = old.length - Buffer.byteLength(newline + newline) + offset;
    const baseline = state(record(old.subarray(0, cut)));
    const current = state(
      record([old.subarray(0, cut), old.subarray(cut), frame(busy, newline)]),
    );

    assert.deepEqual(rpcMessages(current, baseline), [
      { recordIndex: 0, message: busy },
    ]);
  });
}

test("finishing a frame that began before the baseline is not a new response", () => {
  const old = frame(previous);
  const baseline = state(record(old.subarray(0, 20)));

  assert.deepEqual(rpcMessages(state(record(old)), baseline), []);
});

test("an old partial frame cannot hide or substitute for the next busy response", () => {
  const old = frame(previous);
  const baseline = state(record(old.subarray(0, 20)));
  const current = state(record(Buffer.concat([old, frame(busy)])));

  assert.deepEqual(rpcMessages(current, baseline), [
    { recordIndex: 0, message: busy },
  ]);
});

test("UTF-8 split across capture chunks and an old partial frame remains byte-exact", () => {
  const update = (text) => ({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    },
  });
  const old = frame(update("先前消息"));
  const next = update("完成 🐜");
  const nextBytes = frame(next);
  const oldCut = old.indexOf(Buffer.from("先")) + 1;
  const nextCut = nextBytes.indexOf(Buffer.from("完")) + 1;
  const emojiCut = nextBytes.indexOf(Buffer.from("🐜")) + 2;
  const baseline = state(record(old.subarray(0, oldCut)));
  const current = state(
    record([
      old.subarray(0, oldCut),
      old.subarray(oldCut),
      nextBytes.subarray(0, nextCut),
      nextBytes.subarray(nextCut, emojiCut),
      nextBytes.subarray(emojiCut),
    ]),
  );

  assert.deepEqual(rpcMessages(current, baseline), [
    { recordIndex: 0, message: next },
  ]);
});

test("successive polls wait for an appended complete frame without consuming shared evidence", () => {
  const old = frame(previous);
  const next = frame(busy);
  const baseline = state(record(old));
  const partial = state(record(Buffer.concat([old, next.subarray(0, -1)])));
  const current = state(record(Buffer.concat([old, next])));

  assert.deepEqual(rpcMessages(baseline, baseline), []);
  assert.deepEqual(rpcMessages(partial, baseline), []);
  const expected = [{ recordIndex: 0, message: busy }];
  assert.deepEqual(rpcMessages(current, baseline), expected);
  assert.deepEqual(rpcMessages(current, baseline), expected);
  assert.deepEqual(rpcMessages(current, current), []);
  assert.deepEqual(rpcMessages(partial, baseline), []);
});

test("newly appended HTTP records retain their original record indices", () => {
  const old = frame(previous);
  const baseline = state(record(old));
  const current = state(
    record(Buffer.concat([old, frame(busy)])),
    record(Buffer.from(JSON.stringify(completed)), {
      type: "application/json; charset=utf-8",
      complete: true,
    }),
  );

  assert.deepEqual(rpcMessages(current, baseline), [
    { recordIndex: 0, message: busy },
    { recordIndex: 1, message: completed },
  ]);
});

test("JSON response bytes cannot prove an RPC response before HTTP completion", () => {
  const bytes = Buffer.from(JSON.stringify(completed));
  const partial = state(
    record(bytes.subarray(0, -1), {
      type: "application/json",
    }),
  );
  const headersHeld = state(record(bytes, { type: "application/json" }));
  const finished = state(
    record(bytes, {
      type: "application/json",
      complete: true,
    }),
  );

  assert.deepEqual(rpcMessages(partial, empty()), []);
  assert.deepEqual(rpcMessages(headersHeld, empty()), []);
  assert.deepEqual(rpcMessages(finished, empty()), [
    { recordIndex: 0, message: completed },
  ]);
});

test("a changed previously captured prefix is rejected", () => {
  const old = frame(previous);
  const changed = Buffer.from(old);
  changed[0] = "x".charCodeAt(0);

  assert.throws(
    () =>
      rpcMessages(
        state(record(Buffer.concat([changed, frame(busy)]))),
        state(record(old)),
      ),
    /Gate changed an earlier wire capture/u,
  );
});

test("a shortened previously captured prefix is rejected", () => {
  const old = frame(previous);

  assert.throws(
    () => rpcMessages(state(record(old.subarray(0, -1))), state(record(old))),
    /Gate changed an earlier wire capture/u,
  );
});

test("capture errors reject otherwise valid complete RPC evidence", () => {
  const current = state(record(frame(busy)));
  current.captureErrors.push("ACP wire capture byte budget exceeded");

  assert.throws(
    () => rpcMessages(current, empty()),
    /Gate did not retain complete bounded wire capture/u,
  );
});

test("SSE comments and non-RPC event data cannot prove an RPC response", () => {
  const current = state(
    record(
      Buffer.from(
        ': keepalive\n\nevent: state\ndata: {"availability":"ready"}\n\n',
      ),
    ),
  );

  assert.deepEqual(rpcMessages(current, empty()), []);
});
