import assert from "node:assert/strict";
import test from "node:test";
import { assertOriginalAdmissionRetry } from "./prompt-admission-retry-evidence.mjs";

function fixture() {
  const original = {
    sessionId: "session-A",
    body: {
      intentId: "intent-A",
      expectedAppendVersion: 2,
      prompt: [{ type: "text", text: "Original 原件" }],
    },
  };
  const definition = {
    json_rpc_code: -32030,
    message: "Agent is busy",
    retryable: true,
    retry_after_ms: 1000,
  };
  const response = (body, statusCode = 200) => ({
    statusCode,
    contentType: "application/json",
    complete: true,
    chunks: [Buffer.from(JSON.stringify(body)).toString("base64")],
  });
  const prompt = (id, reply) => ({
    method: "POST",
    path: "/v2/acp",
    forwarded: true,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "session/prompt",
      params: {
        sessionId: original.sessionId,
        prompt: original.body.prompt,
        _meta: {
          "antnest.dev/intent": {
            intentId: original.body.intentId,
            expectedAppendVersion: 2,
          },
        },
      },
    }),
    response: response({ jsonrpc: "2.0", id, ...reply }),
  });
  const busy = {
    error: {
      code: -32030,
      message: definition.message,
      data: { code: "agent_busy", retryable: true, retry_after_ms: 1000 },
    },
  };
  const unknown = {
    method: "GET",
    path: "/rpc/agent-acp/workspace/sessions/session-A/intents/intent-A",
    forwarded: true,
    body: null,
    response: response({ code: "intent_unknown" }, 404),
  };
  return {
    original,
    definition,
    baseline: { records: [], captureErrors: [] },
    state: {
      records: [
        prompt(1, busy),
        unknown,
        prompt(2, { result: { stopReason: "end_turn" } }),
      ],
      captureErrors: [],
    },
  };
}

test("original admission retry binds busy, typed unknown and final success to the same input", () => {
  const input = fixture();
  const result = assertOriginalAdmissionRetry(input);
  assert.equal(result.attempts.length, 2);
  assert.equal(result.rejections.length, 1);
  assert.equal(result.unknownQueries.length, 1);
});

for (const [name, change] of [
  ["missing unknown query", (x) => x.state.records.splice(1, 1)],
  [
    "untyped 404",
    (x) => {
      x.state.records[1].response.chunks = [
        Buffer.from("{}").toString("base64"),
      ];
    },
  ],
  [
    "200 unknown receipt",
    (x) => {
      x.state.records[1].response.statusCode = 200;
    },
  ],
  [
    "incomplete unknown body",
    (x) => {
      x.state.records[1].response.complete = false;
    },
  ],
  [
    "wrong query scope",
    (x) => {
      x.state.records[1].path += "-other";
    },
  ],
  [
    "query before rejection",
    (x) => {
      [x.state.records[0], x.state.records[1]] = [
        x.state.records[1],
        x.state.records[0],
      ];
    },
  ],
  [
    "changed original CAS",
    (x) => {
      const m = JSON.parse(x.state.records[2].body);
      m.params._meta["antnest.dev/intent"].expectedAppendVersion++;
      x.state.records[2].body = JSON.stringify(m);
    },
  ],
  [
    "changed original content",
    (x) => {
      const m = JSON.parse(x.state.records[2].body);
      m.params.prompt[0].text = "Other";
      x.state.records[2].body = JSON.stringify(m);
    },
  ],
  [
    "noncanonical rejection",
    (x) => {
      const r = JSON.parse(
        Buffer.from(x.state.records[0].response.chunks[0], "base64"),
      );
      r.error.data.retryable = false;
      x.state.records[0].response.chunks = [
        Buffer.from(JSON.stringify(r)).toString("base64"),
      ];
    },
  ],
  [
    "no successful original retry",
    (x) => {
      x.state.records.pop();
    },
  ],
  [
    "failed final response",
    (x) => {
      x.state.records[2].response = x.state.records[0].response;
    },
  ],
  [
    "capture loss",
    (x) => {
      x.state.captureErrors.push("lost bytes");
    },
  ],
])
  test(`original admission retry rejects ${name}`, () => {
    const input = fixture();
    change(input);
    assert.throws(() => assertOriginalAdmissionRetry(input));
  });

test("original admission retry rejects a fifth dispatch even with complete typed unknowns", () => {
  const input = fixture();
  const [first, query, last] = input.state.records;
  input.state.records = [
    first,
    query,
    structuredClone(first),
    structuredClone(query),
    structuredClone(first),
    structuredClone(query),
    structuredClone(first),
    structuredClone(query),
    last,
  ];
  assert.throws(() => assertOriginalAdmissionRetry(input));
});
