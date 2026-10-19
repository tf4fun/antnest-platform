import assert from "node:assert/strict";
import test from "node:test";
import { privatePlanRequestFixture } from "../acp-plan/private-request.fixture.mjs";
import { privateHTTPFixture } from "../acp-commands/trace-fixtures.mjs";
const url = new URL("./stage2-private-trace.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
function fixture(kind) {
  const f =
    kind === "websocket"
      ? privatePlanRequestFixture({ version: 2, method: "session/prompt" })
      : privateHTTPFixture("command", { sameSpan: kind === "http-same" });
  if (kind === "websocket")
    f.request.tags.push(
      { key: "rpc.service", value: "acp" },
      { key: "rpc.system.name", value: "jsonrpc" },
    );
  const receipt = {
    ...f.expected,
    inputSessionID: "session",
    outcome: "succeeded",
    requestParams: {
      sessionId: "session",
      prompt: [{ type: "text", text: "Stage 2 acceptance evidence" }],
    },
    requestResult:
      kind === "websocket"
        ? { messageId: "original-input" }
        : { stopReason: "end_turn" },
  };
  f.request.logs = ["request", "response"].map((direction) => ({
    timestamp: f.request.startTime,
    fields: [
      { key: "event", value: "antnest." + direction },
      {
        key: "antnest.payload.json",
        value: JSON.stringify(
          direction === "request"
            ? kind === "websocket"
              ? receipt.requestParams
              : {
                  ...receipt.requestParams,
                  _meta: {
                    traceparent: `00-${f.trace.traceID}-${f.receiver.spanID}-01`,
                  },
                }
            : receipt.requestResult,
        ),
      },
    ],
  }));
  return {
    ...f,
    receipt,
    connection: f.expected.connectionTrace,
    http: f.expected.httpConnection,
  };
}
function inspect(f, secrets = []) {
  assert.equal(typeof implementation.inspectStage2PrivatePrompt, "function");
  return implementation.inspectStage2PrivatePrompt(f.trace, f.receipt, {
    connection: f.connection,
    http: f.http,
    secrets,
  });
}
function changeCapturedRequest(f, change) {
  const payload = f.request.logs[0].fields.find(
    (field) => field.key === "antnest.payload.json",
  );
  const params = JSON.parse(payload.value);
  change(params);
  payload.value = JSON.stringify(params);
}
for (const kind of ["http", "http-same"]) {
  for (const invalid of [[], "invalid", 1, true])
    test(`Stage2 ${kind} rejects non-object caller metadata ${JSON.stringify(invalid)}`, () => {
      const f = fixture(kind);
      f.receipt.requestParams._meta = invalid;
      assert.throws(() => inspect(f));
    });
  test(`Stage2 ${kind} accepts null caller metadata with the original receiver context`, () => {
    const f = fixture(kind);
    f.receipt.requestParams._meta = null;
    inspect(f);
  });
  test(`Stage2 ${kind} retains the SDK's cancelled empty 202 acknowledgement and completed RPC`, () => {
    const f = fixture(kind);
    f.post.bodyOutcome = "cancelled";
    f.set(f.client, "antnest.outcome", "cancelled");
    f.set(f.client, "antnest.http.body.outcome", "cancelled");
    const before = JSON.stringify(f);
    inspect(f);
    assert.equal(JSON.stringify(f), before);
  });
  test(`Stage2 ${kind} rejects a cancelled nonempty POST body`, () => {
    const f = fixture(kind);
    f.post.bodyOutcome = "cancelled";
    f.post.bytes = 1;
    f.set(f.client, "antnest.outcome", "cancelled");
    f.set(f.client, "antnest.http.body.outcome", "cancelled");
    f.set(f.client, "http.response.body.size", 1);
    assert.throws(() => inspect(f));
  });
  test(`Stage2 ${kind} preserves original caller metadata and binds replaced tracing metadata to the receiver`, () => {
    const f = fixture(kind);
    f.receipt.requestParams._meta = {
      application: "original-caller",
      traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
      tracestate: "caller=original",
    };
    changeCapturedRequest(f, (params) => {
      params._meta.application = "original-caller";
    });
    const before = JSON.stringify(f);
    inspect(f);
    assert.equal(JSON.stringify(f), before);
  });
  for (const [name, change] of [
    ["missing receiver metadata", (params) => delete params._meta],
    [
      "foreign trace",
      (params, f) => {
        params._meta.traceparent = `00-${"a".repeat(32)}-${f.receiver.spanID}-01`;
      },
    ],
    [
      "CLIENT span metadata",
      (params, f) => {
        params._meta.traceparent = `00-${f.trace.traceID}-${f.receipt.clientSpanID}-01`;
      },
    ],
    [
      "unsampled metadata",
      (params, f) => {
        params._meta.traceparent = `00-${f.trace.traceID}-${f.receiver.spanID}-00`;
      },
    ],
    [
      "unexpected metadata",
      (params) => {
        params._meta.foreign = true;
      },
    ],
    [
      "unexpected tracestate",
      (params) => {
        params._meta.tracestate = "foreign=value";
      },
    ],
  ])
    test(`Stage2 ${kind} rejects ${name}`, () => {
      const f = fixture(kind);
      changeCapturedRequest(f, (params) => change(params, f));
      assert.throws(() => inspect(f));
    });
}
test("Stage2 HTTP rejects dispatcher span metadata in place of the receiving HTTP span", () => {
  const f = fixture("http");
  changeCapturedRequest(f, (params) => {
    params._meta.traceparent = `00-${f.trace.traceID}-${f.request.spanID}-01`;
  });
  assert.throws(() => inspect(f));
});
for (const kind of ["websocket", "http", "http-same"]) {
  test(`Stage2 ${kind} binds the actual private request while preserving enabled RPC capture`, () => {
    const f = fixture(kind),
      before = JSON.stringify(f);
    const result = inspect(f);
    assert.equal(result.prompt_span_id, f.request.spanID);
    assert.equal(result.request_id, f.receipt.requestId);
    assert.equal(result.session_id, f.receipt.inputSessionID);
    assert.equal(result.agent_id, f.receipt.agentId);
    assert.equal(JSON.stringify(f), before);
  });
  for (const [name, mutate] of [
    [
      "request identity",
      (f) => {
        f.receipt.requestId = "foreign";
      },
    ],
    [
      "Agent",
      (f) => {
        f.receipt.agentId = "foreign";
      },
    ],
    [
      "Session",
      (f) => {
        f.receipt.inputSessionID = "foreign";
      },
    ],
    [
      "protocol",
      (f) => {
        f.receipt.protocolVersion = 3;
      },
    ],
    [
      "RPC service",
      (f) => {
        f.request.tags.find((row) => row.key === "rpc.service").value = "other";
      },
    ],
    [
      "RPC system",
      (f) => {
        f.request.tags.find((row) => row.key === "rpc.system.name").value =
          "other";
      },
    ],
    [
      "duplicate Agent",
      (f) => {
        f.request.tags.push({ key: "antnest.agent.id", value: "foreign" });
      },
    ],
    [
      "RPC error status",
      (f) => {
        f.request.tags.push({ key: "rpc.jsonrpc.error_code", value: -32603 });
      },
    ],
    [
      "JSON RPC error",
      (f) => {
        f.request.tags.push({ key: "jsonrpc.error_code", value: -32603 });
      },
    ],
    [
      "request payload",
      (f) => {
        f.receipt.requestParams.prompt[0].text = "changed";
      },
    ],
    [
      "response payload",
      (f) => {
        f.receipt.requestResult = {};
      },
    ],
    [
      "missing request capture",
      (f) => {
        f.request.logs.shift();
      },
    ],
    [
      "duplicate capture",
      (f) => {
        f.request.logs.push(structuredClone(f.request.logs[0]));
      },
    ],
    [
      "additional exported root",
      (f) => {
        f.trace.spans.push({
          ...structuredClone(f.request),
          spanID: "other-root",
          references: [],
        });
      },
    ],
  ])
    test(`Stage2 ${kind} rejects changed ${name}`, () => {
      const f = fixture(kind);
      mutate(f);
      assert.equal(
        typeof implementation.inspectStage2PrivatePrompt,
        "function",
      );
      assert.throws(() => inspect(f));
    });
  test(`Stage2 ${kind} rejects newly issued credentials inside captured data`, () => {
    const f = fixture(kind);
    f.trace.spans[0].logs ??= [];
    f.trace.spans[0].logs.push({
      fields: [
        {
          key: "antnest.payload.json",
          value: JSON.stringify({ secret: "issued-workspace-secret" }),
        },
      ],
    });
    assert.equal(typeof implementation.inspectStage2PrivatePrompt, "function");
    assert.throws(
      () => inspect(f, ["issued-workspace-secret"]),
      /credential|secret/iu,
    );
  });
}
for (const [name, mutate] of [
  [
    "Link",
    (f) => {
      f.request.references[0].spanID = f.receipt.clientSpanID;
    },
  ],
  [
    "upgrade parent",
    (f) => {
      f.connection.spans[1].references = [];
    },
  ],
  [
    "process",
    (f) => {
      f.connection.processes.acp.tags.find((row) => row.key === "process.pid")
        .value++;
    },
  ],
  [
    "Gateway proxy",
    (f) => {
      f.connection.processes.client.serviceName = "edge-gateway";
    },
  ],
  [
    "handshake",
    (f) => {
      f.connection.spans[1].tags.find(
        (row) => row.key === "http.response.status_code",
      ).value = 503;
    },
  ],
])
  test(`Stage2 WebSocket rejects foreign ${name}`, () => {
    const f = fixture("websocket");
    mutate(f);
    assert.equal(typeof implementation.inspectStage2PrivatePrompt, "function");
    assert.throws(() => inspect(f));
  });
for (const [name, mutate] of [
  [
    "unjoined HTTP",
    (f) => {
      f.http.streamJoined = false;
    },
  ],
  [
    "POST index",
    (f) => {
      f.receipt.httpRequestIndex = 1;
    },
  ],
  [
    "connection ID",
    (f) => {
      f.receipt.connectionID = "foreign";
    },
  ],
  [
    "DELETE",
    (f) => {
      f.http.requests.pop();
    },
  ],
  [
    "CLIENT",
    (f) => {
      f.receipt.clientSpanID = "f".repeat(16);
    },
  ],
  [
    "failed receiver",
    (f) => {
      f.receiver.tags.push({ key: "error", value: true });
    },
  ],
  [
    "cancelled CLIENT",
    (f) => {
      f.trace.spans
        .find((span) => span.spanID === f.receipt.clientSpanID)
        .tags.find((row) => row.key === "antnest.outcome").value = "cancelled";
    },
  ],
  [
    "dispatcher name",
    (f) => {
      f.request.operationName = "unrelated";
    },
  ],
])
  test(`Stage2 HTTP rejects foreign ${name}`, () => {
    const f = fixture("http");
    mutate(f);
    assert.equal(typeof implementation.inspectStage2PrivatePrompt, "function");
    assert.throws(() => inspect(f));
  });
