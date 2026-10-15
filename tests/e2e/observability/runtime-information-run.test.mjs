import assert from "node:assert/strict";
import test from "node:test";
import { inspectPlanTrace } from "../acp-plan/trace.mjs";
import { executionFixture } from "../acp-plan/trace-fixture.mjs";
import { inspectCommandTrace } from "../acp-commands/trace.mjs";
import { fixture as commandFixture } from "../acp-commands/trace-fixtures.mjs";
import { inspectFileTrace } from "../acp-files/trace.mjs";
import { execution as fileFixture } from "../acp-files/trace-fixtures.mjs";
import { privateBoundaryFixture } from "../acp-plan/private-boundary.fixture.mjs";
import { addPostPromptInformationRead } from "./runtime-information-run-fixtures.mjs";
import { setTag } from "./gateway-resolution-fixtures.mjs";
import { tag } from "./trace-tree.mjs";
import {
  addReadEndpointObservation,
  assertReadEndpointObservations,
  scaleReadFixtureTrace,
} from "./runtime-information-timing-fixture.mjs";

const consumers = [
  [
    "plan",
    (version = 1) => executionFixture(`v${version}-execute`),
    (f) => inspectPlanTrace(f.trace, f.requests, [], f.expected),
  ],
  [
    "commands",
    (version = 1) => {
      const f = commandFixture("ordinary");
      setTag(f.information.request, "antnest.protocol.version", `v${version}`);
      return f;
    },
    (f) => inspectCommandTrace(f.trace, f.expected, [], f.requests),
  ],
  [
    "files",
    (version = 1) => fileFixture(`v${version}-create`),
    (f) => inspectFileTrace(f.trace, f.requests),
  ],
];
const moveRead = (f, parent) => {
  f.information.read.references[0].spanID = parent.spanID;
  // Retain the old loose descendant evidence so this reproduces the original
  // admission gap instead of failing because all Runtime work disappeared.
  f.trace.spans.push({
    ...structuredClone(f.information.server),
    spanID: "legacy-runtime-descendant",
    references: [
      {
        refType: "CHILD_OF",
        traceID: f.trace.traceID,
        spanID: f.information.info.spanID,
      },
    ],
    logs: [],
  });
};
const removeReadReceipt = (f) => {
  for (const client of [f.information.handshake.client, f.information.client])
    client.references[0].spanID = f.information.info.spanID;
  f.trace.spans = f.trace.spans.filter((span) => span !== f.information.read);
};

for (const [name, fixture, inspect] of consumers) {
  test(`${name} accepts original Runtime tool HTTP status encoded as string 200`, () => {
    const f = fixture();
    const servers = f.trace.spans.filter(
      (span) =>
        f.trace.processes[span.processID].serviceName === "antnest-runtime" &&
        span.operationName === "HTTP POST /mcp",
    );
    assert(servers.length > 0);
    for (const server of servers)
      setTag(server, "http.response.status_code", "200");
    const before = structuredClone(f.trace);
    assert.equal(inspect(f).runtime_information_reads, 1);
    assert.deepEqual(f.trace, before);
  });
  for (const status of ["0200", "200 ", "503", 503])
    test(`${name} rejects Runtime tool HTTP status ${JSON.stringify(status)}`, () => {
      const f = fixture();
      const server = f.trace.spans.find(
        (span) =>
          f.trace.processes[span.processID].serviceName === "antnest-runtime" &&
          span.operationName === "HTTP POST /mcp" &&
          ["tools/list", "tools/call"].includes(tag(span, "rpc.method")),
      );
      assert(server);
      setTag(server, "http.response.status_code", status);
      assert.throws(() => inspect(f));
    });
  test(`${name} preserves independent Run and post-prompt endpoint observations`, () => {
    const f = fixture();
    const post = addPostPromptInformationRead(f.trace);
    scaleReadFixtureTrace(f.trace);
    const baseline = inspect(f);
    const first = addReadEndpointObservation(f.trace, f.information.read);
    const second = addReadEndpointObservation(f.trace, post.read);
    const raw = structuredClone(f.trace);
    assertReadEndpointObservations(inspect(f), [first, second], baseline);
    assert.deepEqual(f.trace, raw);
  });
  for (const version of [1, 2])
    test(`${name} v${version} admits the pinned Run read without requiring post-prompt refresh`, () => {
      const f = fixture(version),
        raw = structuredClone(f.trace);
      const result = inspect(f);
      assert.equal(result.runtime_information_reads, 1);
      assert.equal(result.post_prompt_information_reads, 0);
      assert.equal(result.gateway_ancestry, true);
      assert.deepEqual(f.trace, raw);
    });
  for (const runtimeOutcome of ["success", "canceled"])
    test(`${name} v1 keeps a separate post-prompt read and its owned ${runtimeOutcome} cleanup`, () => {
      const f = fixture();
      const post = addPostPromptInformationRead(f.trace, {
        runtimeOutcome,
        clientOutcome: "cancelled",
      });
      for (const span of f.trace.spans.filter(
        (span) =>
          span === post.read ||
          (tag(span, "antnest.runtime.execution.id") === "execution_test" &&
            span.startTime >= post.read.startTime),
      ))
        setTag(
          span,
          "antnest.runtime.execution.id",
          "current-directory-execution",
        );
      const raw = structuredClone(f.trace),
        result = inspect(f);
      assert.equal(result.runtime_information_reads, 2);
      assert.equal(result.post_prompt_information_reads, 1);
      assert.equal(
        result.neutral_diagnostics.length,
        runtimeOutcome === "canceled" ? 2 : 1,
      );
      assert.deepEqual(f.trace, raw);
    });
  for (const [label, mutate] of [
    [
      "legacy Runtime descendants without the parsed read receipt",
      removeReadReceipt,
    ],
    [
      "post-prompt read borrowed as Run preparation",
      (f) => {
        removeReadReceipt(f);
        addPostPromptInformationRead(f.trace);
      },
    ],
    [
      "Run Session differs from its request",
      (f) => setTag(f.information.run, "antnest.session.id", "another-session"),
    ],
    [
      "read execution differs from pinned Run",
      (f) =>
        setTag(
          f.information.run,
          "antnest.runtime.execution_id",
          "another-execution",
        ),
    ],
    [
      "read Agent differs from original prompt",
      (f) => setTag(f.information.request, "antnest.agent.id", "another-agent"),
    ],
    [
      "preparation belongs to another ACP process",
      (f) => {
        f.trace.processes.other = { serviceName: "agent-acp-service" };
        f.information.info.processID = "other";
      },
    ],
    ["read borrowed by tools/list", (f) => moveRead(f, f.information.list)],
    [
      "read borrowed by tools/call",
      (f) =>
        moveRead(
          f,
          f.trace.spans.find((span) => span.operationName === "mcp.tools.call"),
        ),
    ],
    [
      "missing parsed-result event",
      (f) => {
        f.information.read.logs = f.information.read.logs.filter(
          (event) => event !== f.information.validated,
        );
      },
    ],
    [
      "failed owned close",
      (f) =>
        setTag(
          f.information.read,
          "antnest.mcp.connection.close.outcome",
          "failed",
        ),
    ],
    [
      "caller cancellation",
      (f) => setTag(f.information.read, "antnest.mcp.caller_cancelled", true),
    ],
    [
      "tools listing before information close",
      (f) => {
        f.information.list.startTime = f.information.info.startTime;
      },
    ],
    [
      "orphan named Runtime CLIENT",
      (f) => {
        const span = structuredClone(f.information.handshake.client);
        span.spanID = "orphan-runtime-client";
        span.references[0].spanID = f.information.request.spanID;
        f.trace.spans.push(span);
      },
    ],
    [
      "orphan Runtime peer CLIENT",
      (f) => {
        const span = structuredClone(f.information.handshake.client);
        span.spanID = "orphan-peer-client";
        span.operationName = "HTTP GET runtime";
        span.references[0].spanID = f.information.request.spanID;
        f.trace.spans.push(span);
      },
    ],
    [
      "resources/read hidden in tools/list",
      (f) =>
        setTag(
          f.trace.spans.find((span) => span.spanID === "list-runtime"),
          "rpc.method",
          "resources/read",
        ),
    ],
    [
      "tool disconnect borrowing read cleanup",
      (f) => {
        const span = f.trace.spans.find(
          (span) =>
            span.operationName === "HTTP POST /mcp" &&
            tag(span, "rpc.method") === "tools/call",
        );
        setTag(span, "http.transport.outcome", "canceled");
      },
    ],
    [
      "third read",
      (f) => {
        addPostPromptInformationRead(f.trace);
        addPostPromptInformationRead(f.trace);
      },
    ],
    [
      "post-prompt read before Run completion",
      (f) => {
        const read = addPostPromptInformationRead(f.trace);
        const delta = read.read.startTime - f.information.run.startTime;
        for (const span of f.trace.spans.filter(
          (span) => span.startTime >= read.read.startTime,
        )) {
          span.startTime -= delta;
          for (const event of span.logs ?? []) event.timestamp -= delta;
        }
      },
    ],
  ])
    test(`${name} rejects ${label}`, () => {
      const f = fixture();
      mutate(f);
      assert.throws(() => inspect(f));
    });
  test(`${name} v2 rejects a direct post-prompt catalog read`, () => {
    const f = fixture(2);
    addPostPromptInformationRead(f.trace);
    assert.throws(() => inspect(f));
  });
}

for (const [name, fixture, inspect] of consumers.slice(0, 2))
  test(`${name} supports the same Run read proof on its actual private ACP boundary`, () => {
    const f = privateBoundaryFixture(fixture());
    const result = inspect(f);
    assert.equal(result.runtime_information_reads, 1);
    assert.equal(result.transport_boundary, "private-acp");
    assert.equal(result.gateway_ancestry, undefined);
  });

test("files cannot classify a malformed preparation read as a deliberate failed Tool", () => {
  const f = fileFixture("v2-failed-edit");
  moveRead(
    f,
    f.trace.spans.find((span) => span.operationName === "mcp.tools.call"),
  );
  setTag(f.information.read, "error", true);
  assert.throws(() => inspectFileTrace(f.trace, f.requests));
});

function closedAfterRefresh(causeTypes = "[]") {
  const f = commandFixture("ordinary");
  const post = addPostPromptInformationRead(f.trace);
  f.expected.closedBeforeResponse = true;
  const request = f.information.request;
  for (const [key, value] of Object.entries({
    error: true,
    "error.type": "Error",
    "otel.status_code": "ERROR",
    "antnest.outcome": "error",
    "antnest.operation.phase": "acp.dispatch",
  }))
    setTag(request, key, value);
  request.logs = [
    {
      timestamp: request.startTime + request.duration - 1,
      fields: Object.entries({
        event: "antnest.error",
        "antnest.error.stage": "acp.dispatch",
        "antnest.error.type": "Error",
        "antnest.error.message": "Error: unregistered message omitted",
        "antnest.error.cause_types": causeTypes,
        "antnest.error.causes": JSON.stringify([
          { type: "Error", message: "Error: unregistered message omitted" },
        ]),
        "antnest.operation.phase": "acp.dispatch",
      }).map(([key, value]) => ({ key, value })),
    },
  ];
  return { ...f, post };
}
for (const causeTypes of [[], "[]"])
  test(`completed v1 refresh retains the separately owned closed-socket response error (${typeof causeTypes})`, () => {
    const f = closedAfterRefresh(causeTypes),
      raw = structuredClone(f.trace);
    const result = inspectCommandTrace(f.trace, f.expected, [], f.requests);
    assert.equal(result.runtime_information_reads, 2);
    assert.equal(result.post_prompt_information_reads, 1);
    assert.deepEqual(f.trace, raw);
  });
for (const [name, mutate] of [
  [
    "no original closed-before-response observation",
    (f) => {
      delete f.expected.closedBeforeResponse;
    },
  ],
  [
    "error before the refresh joined",
    (f) => {
      f.information.request.logs[0].timestamp = f.post.read.startTime;
    },
  ],
  [
    "unrelated request error code",
    (f) =>
      setTag(f.information.request, "antnest.error.code", "dependency_failed"),
  ],
  [
    "borrowed error origin",
    (f) =>
      setTag(f.information.request, "antnest.error.origin_span_id", "foreign"),
  ],
  [
    "different boundary phase",
    (f) =>
      setTag(
        f.information.request,
        "antnest.operation.phase",
        "model.complete",
      ),
  ],
  [
    "extra unknown error event field",
    (f) =>
      f.information.request.logs[0].fields.push({
        key: "exception.message",
        value: "unknown",
      }),
  ],
  [
    "failed refresh close",
    (f) =>
      setTag(f.post.read, "antnest.mcp.connection.close.outcome", "failed"),
  ],
  [
    "failed tool while the response closes",
    (f) =>
      setTag(
        f.trace.spans.find((span) => span.operationName === "runtime.mcp.tool"),
        "error",
        true,
      ),
  ],
])
  test(`closed v1 refresh rejects ${name}`, () => {
    const f = closedAfterRefresh();
    mutate(f);
    assert.throws(() =>
      inspectCommandTrace(f.trace, f.expected, [], f.requests),
    );
  });
