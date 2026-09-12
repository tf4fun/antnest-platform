import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import * as evidence from "./agent-access-evidence.mjs";
import {
  authorizeCompletion,
  createAccessModel,
} from "./agent-access-model.mjs";
import {
  assertUnchanged,
  inspectAccessTrace,
  assertPrivateReplay,
  assertReplayIsolation,
} from "./agent-access-evidence.mjs";

const payload = {
  model: "scope-a",
  messages: [
    { role: "system", content: "Private organization a guidance" },
    { role: "user", content: "v1-a" },
  ],
};
test("fresh offboarding Runs require the correct organization model credential", () => {
  for (const phase of [
    "offboard-global-a",
    "offboard-global-b",
    "offboard-scim-before-b",
    "offboard-scim-peer-a",
    "offboard-scim-restored-b",
  ]) {
    const organization = phase.at(-1);
    const body = {
      model: `scope-${organization}`,
      messages: [
        {
          role: "system",
          content: `Private organization ${organization} guidance`,
        },
        { role: "user", content: phase },
      ],
    };
    assert.equal(
      authorizeCompletion(body, `Bearer scope-credential-${organization}`).text,
      `Private history ${phase}`,
    );
    assert.throws(() => authorizeCompletion(body, "Bearer revoked-credential"));
  }
});
test("model evidence binds the actual credential, model, prompt and organization context", () => {
  assert.equal(
    authorizeCompletion(payload, "Bearer scope-credential-a").phase,
    "v1-a",
  );
  for (const [body, credential] of [
    [payload, "Bearer scope-credential-b"],
    [{ ...payload, model: "scope-b" }, "Bearer scope-credential-a"],
    [
      {
        ...payload,
        messages: [
          ...payload.messages,
          { role: "user", content: "foreign-prompt" },
        ],
      },
      "Bearer scope-credential-a",
    ],
    [
      {
        ...payload,
        messages: [
          { role: "system", content: "Private organization b guidance" },
          payload.messages[1],
        ],
      },
      "Bearer scope-credential-a",
    ],
    [
      {
        ...payload,
        messages: [
          {
            role: "system",
            content:
              "Private organization a guidance Private organization b guidance",
          },
          payload.messages[1],
        ],
      },
      "Bearer scope-credential-a",
    ],
  ])
    assert.throws(() => authorizeCompletion(body, credential));
  assert.throws(() =>
    authorizeCompletion(
      {
        ...payload,
        messages: [
          ...payload.messages,
          { role: "assistant", content: "Private history v1-b" },
        ],
      },
      "Bearer scope-credential-a",
    ),
  );
});

for (const version of [1, 2])
  test(`v${version} replay must retain its wire shape and exclude foreign history`, () => {
    const phase = `v${version}-a`;
    const history = ["user_message", "agent_message"].map((kind, index) => ({
      session_id: "own",
      sequence: String(index + 1),
      visible: true,
      kind,
      payload: {
        kind,
        messageId: index === 0 ? "input" : "answer",
        content: [
          {
            type: "text",
            text: index === 0 ? phase : `Private history ${phase}`,
          },
        ],
      },
    }));
    const updates = history.map(({ payload }) => ({
      sessionId: "own",
      update: {
        sessionUpdate: version === 1 ? `${payload.kind}_chunk` : payload.kind,
        messageId: payload.messageId,
        content: version === 1 ? payload.content[0] : payload.content,
      },
    }));
    updates.push({
      sessionId: "own",
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "help", description: "Also /帮助" }],
      },
    });
    assertPrivateReplay(updates, "own", phase, version, history);
    assert.throws(() =>
      assertPrivateReplay(
        updates,
        "own",
        phase,
        version === 1 ? 2 : 1,
        history,
      ),
    );
    for (const mutate of [
      (items) => {
        items.pop();
      },
      (items) => {
        items[0].sessionId = "foreign";
      },
      (items) => {
        items.shift();
      },
      (items) => {
        items[0].update.messageId = "foreign";
      },
      (items) => {
        items.reverse();
      },
      (items) => {
        items.splice(1, 0, structuredClone(items[0]));
      },
      (items) => {
        items[0].update.content =
          version === 1
            ? { type: "text", text: `v${version}-b` }
            : [{ type: "text", text: `v${version}-b` }];
      },
      (items) => {
        items[1].update.content =
          version === 1
            ? { type: "text", text: `Private history v${version}-b` }
            : [{ type: "text", text: `Private history v${version}-b` }];
      },
    ]) {
      const invalid = structuredClone(updates);
      mutate(invalid);
      assert.throws(() =>
        assertPrivateReplay(invalid, "own", phase, version, history),
      );
    }
  });

test("Session denial cannot smuggle history in its error or notifications", () => {
  const error = {
    code: -32020,
    message: "Session belongs to another Agent",
    data: { code: "session_access_denied", retryable: false },
  };
  evidence.assertDeniedSessionError(error);
  for (const invalid of [
    { ...error, message: "Private history v1-b" },
    { ...error, data: { ...error.data, history: "Private history v1-b" } },
    { ...error, code: -32603 },
  ])
    assert.throws(() => evidence.assertDeniedSessionError(invalid));
  const updates = [{ sessionId: "old" }];
  evidence.assertNoNotifications(updates, 1);
  assert.throws(() =>
    evidence.assertNoNotifications(
      [
        ...updates,
        { sessionId: "foreign", update: { content: "Private history v1-b" } },
      ],
      1,
    ),
  );
});

test("resume replaces exactly one target MCP revision without touching foreign data", () => {
  const before = {
    acp_sessions: [
      {
        id: "own",
        state: "active",
        updated_at: "old",
        client_mcp_revision_id: "mcp-1",
      },
      { id: "foreign", state: "active", updated_at: "old" },
    ],
    runs: [],
    context_checkpoints: [
      { id: "old", session_id: "foreign", summary: "private" },
    ],
    client_mcp_revisions: [
      { id: "mcp-1", session_id: "own", revision: "1", nonce: "old" },
    ],
  };
  const after = structuredClone(before);
  after.acp_sessions[0].updated_at = "new";
  after.acp_sessions[0].client_mcp_revision_id = "mcp-2";
  after.client_mcp_revisions.push({
    id: "mcp-2",
    session_id: "own",
    revision: "2",
    nonce: "new",
  });
  assertReplayIsolation(before, after, "own");
  for (const mutate of [
    (s) => {
      s.acp_sessions[1].updated_at = "changed";
    },
    (s) => {
      s.acp_sessions[0].state = "closed";
    },
    (s) => {
      s.acp_sessions.pop();
    },
    (s) => {
      s.runs.push({ id: "unexpected" });
    },
    (s) => {
      s.client_mcp_revisions[0].nonce = "changed";
    },
    (s) => {
      s.client_mcp_revisions[1].session_id = "foreign";
    },
    (s) => {
      s.client_mcp_revisions[1].revision = "10";
    },
    (s) => {
      s.client_mcp_revisions.push({
        id: "extra",
        session_id: "own",
        revision: "3",
      });
    },
    (s) => {
      s.acp_sessions[0].client_mcp_revision_id = "foreign";
    },
    (s) => {
      s.client_mcp_revisions.pop();
    },
    (s) => {
      s.context_checkpoints[0].summary = "changed";
    },
    (s) => {
      s.context_checkpoints.pop();
    },
    (s) => {
      s.context_checkpoints.push({
        id: "unexpected",
        session_id: "own",
        summary: "invented",
      });
    },
  ]) {
    const invalid = structuredClone(after);
    mutate(invalid);
    assert.throws(() => assertReplayIsolation(before, invalid, "own"));
  }
});

test("negative-effect evidence rejects changed projections or model activity", () => {
  const before = { agents: [{ id: "a", revision: 1 }], events: [], model: [] };
  assertUnchanged(before, structuredClone(before));
  assert.throws(() =>
    assertUnchanged(before, { ...before, events: [{ id: "denied" }] }),
  );
  assert.throws(() =>
    assertUnchanged(before, { ...before, model: ["unexpected-call"] }),
  );
});

test("HTTP model fixture records the execution trace once and rejects repeated execution", async (t) => {
  const server = createAccessModel().listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const base = `http://127.0.0.1:${server.address().port}`;
  const options = {
    method: "POST",
    signal: AbortSignal.timeout(3000),
    headers: {
      "content-type": "application/json",
      authorization: "Bearer scope-credential-a",
      traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
    },
    body: JSON.stringify(payload),
  };
  const response = await fetch(`${base}/v1/chat/completions`, options);
  assert.equal(response.status, 200);
  assert.equal(
    (await response.json()).choices[0].message.content,
    "Private history v1-a",
  );
  assert.equal(
    (await fetch(`${base}/v1/chat/completions`, options)).status,
    400,
  );
  const state = await (
    await fetch(`${base}/status`, { signal: AbortSignal.timeout(3000) })
  ).json();
  assert.deepEqual(state.requests, [
    { phase: "v1-a", trace_id: "a".repeat(32), model_span_id: "b".repeat(16) },
  ]);
  assert.deepEqual(state.errors, ["fixture request rejected"]);
});

function traceFixture() {
  return {
    traceID: "a".repeat(32),
    processes: Object.fromEntries(
      ["edge-gateway", "admin-console", "agent-controller"].map((s) => [
        s,
        { serviceName: s },
      ]),
    ),
    spans: [
      {
        spanID: "1",
        traceID: "a".repeat(32),
        processID: "edge-gateway",
        operationName: "HTTP GET",
        references: [],
      },
      {
        spanID: "2",
        traceID: "a".repeat(32),
        processID: "admin-console",
        operationName: "HTTP GET",
        tags: [
          { key: "span.kind", value: "client" },
          { key: "http.request.method", value: "GET" },
        ],
        references: [
          { refType: "CHILD_OF", traceID: "a".repeat(32), spanID: "1" },
        ],
      },
      {
        spanID: "3",
        traceID: "a".repeat(32),
        processID: "agent-controller",
        operationName: "HTTP GET /internal/agents/{agent_id}",
        tags: [
          { key: "span.kind", value: "server" },
          { key: "http.request.method", value: "GET" },
          { key: "http.route", value: "/internal/agents/{agent_id}" },
          { key: "rpc.method", value: "GET /internal/agents/{agent_id}" },
        ],
        references: [
          { refType: "CHILD_OF", traceID: "a".repeat(32), spanID: "2" },
        ],
      },
      {
        spanID: "db",
        traceID: "a".repeat(32),
        processID: "agent-controller",
        operationName: "SELECT",
        duration: 1,
        references: [
          { refType: "CHILD_OF", traceID: "a".repeat(32), spanID: "3" },
        ],
        tags: [
          { key: "span.kind", value: "client" },
          { key: "db.system.name", value: "postgresql" },
          { key: "db.query.text", value: "SELECT $1" },
          { key: "db.operation.name", value: "SELECT" },
        ],
      },
    ],
  };
}
const expectation = {
  traceID: "a".repeat(32),
  service: "agent-controller",
  method: "GET",
  route: "/internal/agents/{agent_id}",
  rpcMethod: "GET /internal/agents/{agent_id}",
  via: ["admin-console"],
};
test("access expectations sharing a trace do not poll Jaeger repeatedly", async () => {
  const events = [];
  const results = await evidence.verifyAccessTraces(
    "http://jaeger",
    [expectation, expectation],
    [],
    {
      wait: async (ms) => {
        events.push(ms);
      },
      request: async (url) => {
        events.push(url);
        return Response.json({ data: [traceFixture()] });
      },
    },
  );
  assert.equal(results.length, 2);
  assert.deepEqual(events, [
    6000,
    `http://jaeger/api/traces/${expectation.traceID}`,
  ]);
});
test("access traces require same-trace causal ownership, not only service presence", () => {
  assert.equal(
    inspectAccessTrace(traceFixture(), expectation, []).gateway_ancestry,
    true,
  );
  for (const mutate of [
    (t) => {
      t.traceID = "b".repeat(32);
    },
    (t) => {
      t.spans[2].references = [];
    },
    (t) => {
      t.spans[2].references[0].traceID = "b".repeat(32);
    },
    (t) => {
      t.spans[2].references[0].spanID = "1";
    },
    (t) => {
      t.spans[2].processID = "admin-console";
    },
    (t) => {
      t.spans[2].tags = [{ key: "cookie", value: "scope%2Fcookie" }];
    },
  ]) {
    const trace = traceFixture();
    mutate(trace);
    assert.throws(() =>
      inspectAccessTrace(trace, expectation, ["scope/cookie"]),
    );
  }
});
