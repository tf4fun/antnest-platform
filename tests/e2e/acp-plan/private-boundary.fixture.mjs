import { requestFixture } from "./trace-fixture.mjs";

const field = (span, key, value) => {
  span.tags = span.tags.filter((tag) => tag.key !== key);
  span.tags.push({ key, value });
};

// The two raw traces model a real exported CLIENT/upgrade pair and the
// independent ACP request linked to that precise upgrade SERVER span.
export function privateBoundaryFixture(
  original = requestFixture(),
  { version = 1, connection = 1 } = {},
) {
  const { trace, expected } = original;
  const connectionTraceID = connection.toString(16).padStart(32, "c");
  const clientSpanID = "1".repeat(16);
  const connectionSpanID = "2".repeat(16);
  trace.traceID = connection.toString(16).padStart(32, "d");
  for (const request of original.requests ?? [])
    request.trace_id = trace.traceID;
  trace.spans = trace.spans.filter(
    (span) => trace.processes[span.processID].serviceName !== "edge-gateway",
  );
  delete trace.processes["edge-gateway"];
  for (const span of trace.spans) {
    span.traceID = trace.traceID;
    for (const ref of span.references) ref.traceID = trace.traceID;
    for (const event of span.logs ?? [])
      for (const item of event.fields ?? [])
        if (item.key === "trace_id") item.value = trace.traceID;
  }
  const request = trace.spans.find((span) => span.spanID === "request");
  const process = trace.processes[request.processID];
  process.tags ??= [];
  for (const [key, value] of Object.entries({
    "host.name": "private-acp-host",
    "process.pid": 17,
    "service.instance.id": "private-acp-instance",
  }))
    if (!process.tags.some((item) => item.key === key))
      process.tags.push({ key, value });
  request.references = [
    {
      refType: "FOLLOWS_FROM",
      traceID: connectionTraceID,
      spanID: connectionSpanID,
    },
  ];
  field(request, "antnest.request.id", expected.requestId ?? "2");
  field(request, "antnest.protocol.version", `v${version}`);
  const tags = (values) =>
    Object.entries(values).map(([key, value]) => ({ key, value }));
  const connectionTrace = {
    traceID: connectionTraceID,
    processes: {
      client: { serviceName: "antnest-private-acp-client" },
      acp: {
        serviceName: "agent-acp-service",
        tags: structuredClone(process.tags),
      },
    },
    spans: [
      {
        traceID: connectionTraceID,
        spanID: clientSpanID,
        processID: "client",
        operationName: "HTTP GET agent-acp-workspace",
        startTime: 0,
        duration: 1,
        references: [],
        tags: tags({
          "span.kind": "client",
          "http.request.method": "GET",
          "http.response.status_code": 101,
        }),
      },
      {
        traceID: connectionTraceID,
        spanID: connectionSpanID,
        processID: "acp",
        operationName: `HTTP GET /v${version}/acp`,
        startTime: 0,
        duration: 1,
        references: [
          {
            refType: "CHILD_OF",
            traceID: connectionTraceID,
            spanID: clientSpanID,
          },
        ],
        tags: tags({
          "span.kind": "server",
          "http.request.method": "GET",
          "http.route": `/v${version}/acp`,
          "http.response.status_code": 101,
          "antnest.listener": "workspace",
        }),
      },
    ],
  };
  Object.assign(expected, {
    boundary: "private-acp",
    protocolVersion: version,
    transport: "websocket",
    requestId: expected.requestId ?? "2",
    connectionTraceID,
    connectionSpanID,
    clientSpanID,
    connectionTrace,
  });
  return { ...original, request, connectionTrace, field };
}
