import assert from "node:assert/strict";
const value = (input) =>
  input.arrayValue
    ? (input.arrayValue.values ?? []).map(value)
    : (input.stringValue ??
      input.boolValue ??
      Number(input.intValue ?? input.doubleValue));
const attrs = (values = []) => {
  assert.equal(
    new Set(values.map(({ key }) => key)).size,
    values.length,
    "duplicate attribute key",
  );
  return Object.fromEntries(
    values.map(({ key, value: item }) => [key, value(item)]),
  );
};
function allowed(values, keys) {
  const attributes = attrs(values);
  assert(
    Object.keys(attributes).every((key) => keys.includes(key)),
    "unowned diagnostic or content attribute",
  );
  return attributes;
}
export function expectedOutcome(method, mode) {
  if (mode === "success" || mode === "tool-error")
    return method === "list"
      ? { status: "resolved", count: 1 }
      : {
          status: "resolved",
          isError: mode === "tool-error",
          toolEffectState: mode === "tool-error" ? "none" : "settled",
          runtimeCallStopped: true,
        };
  const original =
    mode === "http-error"
      ? { name: "SdkHttpError", code: "CLIENT_HTTP_NOT_IMPLEMENTED" }
      : { name: "SdkError", code: "REQUEST_TIMEOUT" };
  return {
    status: "rejected",
    error:
      method === "list"
        ? original
        : {
            name: "McpToolCallError",
            effectState: "unknown",
            runtimeCallStopped: false,
            cause: original,
          },
  };
}
export const spansOf = (bodies) =>
  bodies
    .flatMap((body) => body.resourceSpans ?? [])
    .flatMap((group) => group.scopeSpans.flatMap((scope) => scope.spans));
const sequence = [
  "antnest.mcp.discovery.ready",
  "antnest.mcp.tool.dispatch.started",
  "antnest.mcp.tool.result.parsed",
  "antnest.mcp.connection.close.started",
  "antnest.mcp.connection.close.completed",
];

export function verify(receipts, bodies, expectedInstance) {
  const timeObservations = [];
  const groups = bodies.flatMap((body) => body.resourceSpans ?? []);
  assert(groups.length > 0);
  for (const group of groups) {
    const resource = attrs(group.resource.attributes);
    assert.equal(typeof resource["host.name"], "string");
    assert(
      Number.isSafeInteger(resource["process.pid"]) &&
        resource["process.pid"] > 0,
    );
    assert.equal(
      `${resource["host.name"]}:${resource["process.pid"]}`,
      expectedInstance,
    );
    assert.equal(
      attrs(group.resource.attributes)["service.name"],
      "agent-acp-service",
    );
    assert.equal(
      attrs(group.resource.attributes)["service.instance.id"],
      expectedInstance,
    );
  }
  const spans = spansOf(bodies);
  assert.equal(spans.length, receipts.length * 3);
  assert.equal(
    new Set(spans.map((span) => `${span.traceId}:${span.spanId}`)).size,
    spans.length,
  );
  assert(!JSON.stringify(bodies).includes("PRIVATE"));
  for (const span of spans) {
    attrs(span.attributes);
    assert.equal((span.links ?? []).length, 0);
    const start = BigInt(span.startTimeUnixNano),
      end = BigInt(span.endTimeUnixNano);
    assert(start <= end);
    for (const field of [
      "droppedAttributesCount",
      "droppedEventsCount",
      "droppedLinksCount",
    ])
      assert.equal(Number(span[field] ?? 0), 0);
    let previous = start;
    for (const event of span.events ?? []) {
      const at = BigInt(event.timeUnixNano);
      assert(
        previous <= at && at <= end,
        "event outside its own span or order",
      );
      previous = at;
      assert.equal(Number(event.droppedAttributesCount ?? 0), 0);
      assert.equal(
        new Set((event.attributes ?? []).map(({ key }) => key)).size,
        (event.attributes ?? []).length,
      );
    }
  }
  for (const receipt of receipts) {
    const { method, mode, executionId, requests, order } = receipt;
    assert(["list", "call"].includes(method));
    assert(
      ["success", "tool-error", "http-error", "caller-abort"].includes(mode),
    );
    assert(mode !== "tool-error" || method === "call");
    assert.deepEqual(receipt.actual, expectedOutcome(method, mode));
    assert.deepEqual(
      order.map((item) => item.phase),
      [
        "discovery-written",
        "tool-request-before-discovery-eof",
        "discovery-eof-released",
        "discovery-eof-exported",
        "tool-response",
      ],
    );
    for (let i = 1; i < order.length; i++)
      assert(
        BigInt(order[i - 1].monotonic_ns) <= BigInt(order[i].monotonic_ns),
      );
    const owners = spans.filter(
      (span) =>
        attrs(span.attributes)["antnest.runtime.execution.id"] === executionId,
    );
    assert.equal(owners.length, 1);
    const owner = owners[0],
      attributes = attrs(owner.attributes);
    const common = {
      "organization.id": "organization-1",
      "antnest.runtime.execution.id": executionId,
      "antnest.mcp.method": `tools/${method}`,
      "antnest.mcp.tool_result.outcome":
        mode === "success"
          ? "success"
          : mode === "tool-error"
            ? "tool_error"
            : "not_received",
      "antnest.mcp.connection.close.outcome": "closed",
      "antnest.mcp.caller_cancelled": mode === "caller-abort",
      "antnest.outcome":
        mode === "success"
          ? "ok"
          : mode === "tool-error"
            ? "tool_error"
            : "error",
      "antnest.execution.revision": "execution-1",
    };
    const business =
      method === "list"
        ? { "execution.revision": "execution-1" }
        : {
            "run.id": "run-1",
            "antnest.run.id": "run-1",
            "tool.name": "bash",
            "mcp.source_id": "runtime",
            "antnest.organization.id": "organization-1",
            "antnest.provider.connection_id": "provider-1",
            "antnest.configuration.revision": 1,
            "antnest.agent.revision": "spec-1",
            "antnest.runtime.revision": "runtime-1",
            "antnest.runtime.execution_id": executionId,
            "antnest.deadline": receipt.deadlineAt,
          };
    const failureType = method === "list" ? "Error" : "McpToolCallError";
    const diagnostic =
      mode === "success"
        ? {}
        : mode === "tool-error"
          ? { "error.type": "mcp_tool_error" }
          : {
              "error.type": failureType,
              "antnest.operation.phase": `mcp.tools.${method}`,
            };
    assert.deepEqual(attributes, { ...common, ...business, ...diagnostic });
    assert.equal(owner.name, `mcp.tools.${method}`);
    assert.equal(Number(owner.kind), 1);
    assert(!owner.parentSpanId || /^0+$/u.test(owner.parentSpanId));
    assert.equal(attributes["antnest.mcp.method"], `tools/${method}`);
    const parsed = mode === "success" || mode === "tool-error";
    const result = mode === "tool-error" ? "tool_error" : "success";
    assert.equal(
      attributes["antnest.mcp.tool_result.outcome"],
      parsed ? result : "not_received",
    );
    assert.equal(attributes["antnest.mcp.connection.close.outcome"], "closed");
    assert.equal(
      attributes["antnest.mcp.caller_cancelled"],
      mode === "caller-abort",
    );
    assert.equal(Number(owner.status?.code ?? 0), mode === "success" ? 0 : 2);
    const lifecycle = (owner.events ?? []).filter((event) =>
      event.name.startsWith("antnest.mcp."),
    );
    assert.deepEqual(
      (owner.events ?? []).map((event) => event.name),
      parsed
        ? sequence
        : [...sequence.filter((name) => name !== sequence[2]), "antnest.error"],
    );
    if (!parsed) {
      const cause = [
        {
          type: failureType,
          message: `${failureType}: unregistered message omitted`,
        },
        ...(method === "call"
          ? [{ type: "Error", message: "Error: unregistered message omitted" }]
          : []),
      ];
      assert.deepEqual(attrs(owner.events.at(-1).attributes), {
        "antnest.error.stage": `mcp.tools.${method}`,
        "antnest.error.type": failureType,
        "antnest.error.message": `${failureType}: unregistered message omitted`,
        "antnest.error.cause_types": method === "call" ? ["Error"] : [],
        "antnest.error.causes": JSON.stringify(cause),
        "antnest.operation.phase": `mcp.tools.${method}`,
      });
    }
    assert.deepEqual(
      lifecycle.map((event) => event.name),
      parsed ? sequence : sequence.filter((name) => name !== sequence[2]),
    );
    for (const event of lifecycle)
      assert.deepEqual(
        attrs(event.attributes),
        event.name === sequence[2]
          ? { outcome: result }
          : event.name === sequence[3]
            ? { "antnest.mcp.caller_cancelled": mode === "caller-abort" }
            : event.name === sequence[4]
              ? { outcome: "closed" }
              : {},
      );
    assert.deepEqual(
      requests.map((request) => request.method),
      ["server/discover", `tools/${method}`],
    );
    const children = spans.filter(
      (span) =>
        span.traceId === owner.traceId && span.parentSpanId === owner.spanId,
    );
    assert.equal(children.length, 2);
    const ordered = (boundary, before, after, child) => {
      const excess = BigInt(before) - BigInt(after);
      if (excess <= 0n) return;
      assert.equal(child.parentSpanId, owner.spanId);
      assert.equal(child.traceId, owner.traceId);
      assert.equal(BigInt(owner.startTimeUnixNano) % 1_000_000n, 0n);
      assert.equal(BigInt(child.startTimeUnixNano) % 1_000_000n, 0n);
      assert(excess < 1_000_000n, `${boundary}: cross-span difference >= 1ms`);
      timeObservations.push({
        trace_id: owner.traceId,
        owner_span_id: owner.spanId,
        client_span_id: child.spanId,
        boundary,
        before_ns: before,
        after_ns: after,
        raw_difference_ns: excess.toString(),
        reason: "deferred-same-node-sdk-sub-ms-cross-span-event",
      });
    };
    const at = (name) =>
      lifecycle.find((event) => event.name === name).timeUnixNano;
    const closeStarted = at(sequence[3]),
      closeCompleted = at(sequence[4]);
    for (const request of requests) {
      const child = children.find(
        (span) =>
          span.spanId === request.spanId && span.traceId === request.traceId,
      );
      assert(
        child,
        "actual peer request must belong to its original operation",
      );
      assert.equal(Number(child.kind), 3);
      const httpKeys = [
        "http.request.method",
        "peer.service",
        "server.address",
        "server.port",
        "http.response.status_code",
        "http.response.body.size",
      ];
      const isDiscovery = request.method === "server/discover";
      const http = allowed(child.attributes, [
        ...httpKeys,
        ...(isDiscovery
          ? []
          : mode === "http-error"
            ? ["antnest.outcome"]
            : [
                "antnest.outcome",
                "antnest.operation.phase",
                "antnest.cancellation.type",
              ]),
      ]);
      assert.equal(child.name, "HTTP POST antnest-runtime");
      assert.equal(http["http.request.method"], "POST");
      assert.equal(http["peer.service"], "antnest-runtime");
      assert.equal(http["server.address"], "127.0.0.1");
      assert(
        Number.isInteger(http["server.port"]) &&
          http["server.port"] > 0 &&
          http["server.port"] < 65536,
      );
      ordered(
        "owner.start-before-client",
        owner.startTimeUnixNano,
        child.startTimeUnixNano,
        child,
      );
      ordered(
        "client.join-before-close.completed",
        child.endTimeUnixNano,
        closeCompleted,
        child,
      );
      ordered(
        "client.join-before-owner.end",
        child.endTimeUnixNano,
        owner.endTimeUnixNano,
        child,
      );
      if (isDiscovery) {
        assert.equal(http["http.response.status_code"], 200);
        assert.equal(http["http.response.body.size"], 292);
        assert.equal(Number(child.status?.code ?? 0), 0);
        assert.equal((child.events ?? []).length, 0);
        ordered(
          "discovery.start-before-ready",
          child.startTimeUnixNano,
          at(sequence[0]),
          child,
        );
        ordered(
          "discovery.eof-after-dispatch",
          at(sequence[1]),
          child.endTimeUnixNano,
          child,
        );
        ordered(
          "discovery.eof-before-result-or-close",
          child.endTimeUnixNano,
          parsed ? at(sequence[2]) : closeStarted,
          child,
        );
      } else {
        ordered(
          "dispatch-before-tool-HTTP",
          at(sequence[1]),
          child.startTimeUnixNano,
          child,
        );
        if (mode === "http-error") {
          assert.equal(http["http.response.status_code"], 503);
          assert.equal(http["http.response.body.size"], 2);
          assert.equal(Number(child.status?.code ?? 0), 2);
          assert.equal(http["antnest.outcome"], "http_error");
          assert.deepEqual(child.events ?? [], []);
          ordered(
            "failed-HTTP-before-close",
            child.endTimeUnixNano,
            closeStarted,
            child,
          );
        } else {
          assert.equal(Number(child.status?.code ?? 0), 0);
          assert.equal(http["antnest.outcome"], "cancelled");
          assert.equal(http["antnest.operation.phase"], "http.send_or_read");
          assert.equal(http["antnest.cancellation.type"], "AbortError");
          assert.deepEqual(
            (child.events ?? []).map((event) => event.name),
            ["antnest.cancelled"],
          );
          assert.deepEqual(attrs(child.events[0].attributes), {
            "antnest.cancellation.phase": "http.send_or_read",
            "antnest.cancellation.type": "AbortError",
          });
          const cancelled = child.events[0].timeUnixNano;
          if (mode === "caller-abort") {
            // Cancellation can win before fetch receives even the HTTP headers.
            if (http["http.response.status_code"] === undefined)
              assert.equal(http["http.response.body.size"], undefined);
            else {
              assert.equal(http["http.response.status_code"], 200);
              assert(
                Number.isInteger(http["http.response.body.size"]) &&
                  http["http.response.body.size"] >= 0 &&
                  http["http.response.body.size"] <=
                    Buffer.byteLength("event: message\ndata: "),
              );
            }
            ordered(
              "dispatch-before-caller-cancel",
              at(sequence[1]),
              cancelled,
              child,
            );
            ordered(
              "caller-cancel-before-close",
              cancelled,
              closeStarted,
              child,
            );
          } else {
            assert.equal(http["http.response.status_code"], 200);
            assert.equal(
              http["http.response.body.size"],
              method === "list" ? 230 : mode === "tool-error" ? 281 : 257,
            );
            ordered(
              "close.started-before-owned-cancel",
              closeStarted,
              cancelled,
              child,
            );
            ordered(
              "owned-cancel-before-close.completed",
              cancelled,
              closeCompleted,
              child,
            );
          }
        }
      }
    }
  }
  return { traces: receipts.length, spans: spans.length, timeObservations };
}

export function counterexamples(receipts, bodies, expectedInstance) {
  const cases = [
    [
      "unowned owner error",
      (owner) =>
        owner.events.push({
          name: "antnest.error",
          timeUnixNano: owner.endTimeUnixNano,
          attributes: [],
        }),
    ],
    ["tool HTTP ERROR", (_owner, children) => (children[1].status.code = 2)],
    [
      "tool exception event",
      (_owner, children) =>
        children[1].events.push({
          name: "exception",
          timeUnixNano: children[1].endTimeUnixNano,
          attributes: [],
        }),
    ],
    [
      "tool legacy error flag",
      (_owner, children) =>
        children[1].attributes.push({
          key: "error",
          value: { boolValue: true },
        }),
    ],
    ["missing cancellation", (_owner, children) => (children[1].events = [])],
    [
      "duplicate status key",
      (_owner, children) =>
        children[1].attributes.unshift({
          key: "http.response.status_code",
          value: { intValue: "503" },
        }),
    ],
    [
      "unjoined tool HTTP",
      (owner, children) =>
        (children[1].endTimeUnixNano = (
          BigInt(owner.endTimeUnixNano) + 5_000_000_000n
        ).toString()),
    ],
    [
      "cancellation before actual close",
      (owner, children) =>
        (children[1].events[0].timeUnixNano = children[1].startTimeUnixNano),
    ],
    ["missing readiness", (owner) => owner.events.shift()],
    [
      "wrong method",
      (owner) =>
        (owner.attributes.find(
          (item) => item.key === "antnest.mcp.method",
        ).value.stringValue = "tools/call"),
    ],
    [
      "wrong execution",
      (owner) =>
        (owner.attributes.find(
          (item) => item.key === "antnest.runtime.execution.id",
        ).value.stringValue = "foreign"),
    ],
    ["missing parsed receipt", (owner) => owner.events.splice(2, 1)],
    [
      "dispatch before readiness",
      (owner) =>
        ([owner.events[0], owner.events[1]] = [
          owner.events[1],
          owner.events[0],
        ]),
    ],
    [
      "event after own end",
      (owner) =>
        (owner.events[1].timeUnixNano = (
          BigInt(owner.endTimeUnixNano) + 1n
        ).toString()),
    ],
    [
      "unowned child",
      (_owner, children) => (children[0].parentSpanId = "f".repeat(16)),
    ],
    [
      "content event attribute",
      (owner) =>
        (owner.events[0].attributes = [
          { key: "content", value: { stringValue: "unapproved" } },
        ]),
    ],
    [
      "failed close",
      (owner) =>
        (owner.attributes.find(
          (item) => item.key === "antnest.mcp.connection.close.outcome",
        ).value.stringValue = "failed"),
    ],
  ];
  for (const [name, mutate] of cases) {
    const copies = structuredClone(bodies),
      spans = spansOf(copies);
    const owner = spans.find(
      (span) =>
        attrs(span.attributes)["antnest.runtime.execution.id"] ===
        receipts[0].executionId,
    );
    mutate(
      owner,
      spans.filter(
        (span) =>
          span.parentSpanId === owner.spanId && span.traceId === owner.traceId,
      ),
    );
    assert.throws(
      () => verify(receipts, copies, expectedInstance),
      { code: "ERR_ASSERTION" },
      name,
    );
  }
  return {
    event: "runtime_tools_inspector_counterexamples",
    passed: cases.map(([name]) => name),
  };
}
