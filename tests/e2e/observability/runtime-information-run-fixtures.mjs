import { addCompletedRead } from "../edge-gateway/resolve-cache-completed-read-fixtures.mjs";
import { setTag } from "./gateway-resolution-fixtures.mjs";
import { tag } from "./trace-tree.mjs";

export function addRunInformationRead(
  trace,
  { requestSpanId = "request", version = 1, ...options } = {},
) {
  const request = trace.spans.find((span) => span.spanID === requestSpanId);
  const run = trace.spans.find((span) => span.operationName === "agent.run");
  const info = trace.spans.find(
    (span) => span.operationName === "mcp.runtime.info",
  );
  const list = trace.spans.find(
    (span) => span.operationName === "mcp.tools.list",
  );
  const agent = tag(request, "antnest.agent.id") ?? "agent";
  for (const span of trace.spans) {
    span.startTime *= 1000;
    span.duration *= 1000;
  }
  setTag(request, "antnest.agent.id", agent);
  setTag(request, "antnest.protocol.version", `v${version}`);
  setTag(run, "antnest.session.id", tag(request, "antnest.session.id"));
  setTag(run, "antnest.runtime.execution_id", "execution_test");
  info.duration = 100;
  if (list.startTime <= info.startTime + info.duration) {
    list.startTime = info.startTime + 1000;
    trace.spans.find((span) => span.spanID === "list-runtime").startTime =
      list.startTime;
  }
  trace.spans = trace.spans.filter((span) => span.spanID !== "info-runtime");
  const originalLength = trace.spans.length;
  const read = addCompletedRead(trace, info, "http", agent, {
    preserveRequest: true,
    runtimeOutcome: "success",
    clientOutcome: "success",
    ...options,
  });
  const added = trace.spans.splice(originalLength);
  trace.spans.splice(trace.spans.indexOf(info) + 1, 0, ...added);
  const listServer = trace.spans.find((span) => span.spanID === "list-runtime");
  const listClient = {
    ...structuredClone(list),
    spanID: "list-http",
    operationName: "HTTP POST antnest-runtime",
    references: [
      { refType: "CHILD_OF", traceID: trace.traceID, spanID: list.spanID },
    ],
    tags: [],
  };
  trace.spans.splice(trace.spans.indexOf(listServer), 0, listClient);
  listServer.references[0].spanID = listClient.spanID;
  for (const span of trace.spans) {
    const runtime =
      trace.processes[span.processID].serviceName === "antnest-runtime";
    if (runtime && !added.includes(span)) {
      setTag(span, "antnest.agent.id", agent);
      setTag(span, "antnest.runtime.execution.id", "execution_test");
    }
    if (span.operationName === "HTTP POST antnest-runtime") {
      setTag(span, "span.kind", "client");
      setTag(span, "peer.service", "antnest-runtime");
      setTag(span, "http.request.method", "POST");
      setTag(span, "http.response.status_code", 200);
    }
    if (
      runtime &&
      span.operationName === "HTTP POST /mcp" &&
      !added.includes(span)
    ) {
      setTag(span, "span.kind", "server");
      setTag(span, "http.request.method", "POST");
      setTag(span, "http.response.status_code", 200);
      setTag(span, "http.route", "/mcp");
      if (span === listServer) setTag(span, "rpc.method", "tools/list");
    }
  }
  for (const owner of trace.spans.filter((span) =>
    ["mcp.tools.list", "mcp.tools.call"].includes(span.operationName),
  )) {
    const client = trace.spans.find(
      (span) =>
        span.operationName === "HTTP POST antnest-runtime" &&
        span.references[0]?.spanID === owner.spanID,
    );
    const server = trace.spans.find(
      (span) => span.references[0]?.spanID === client.spanID,
    );
    const discoveryClient = {
      ...structuredClone(client),
      spanID: owner.spanID + "-discovery-http",
      startTime: owner.startTime,
      duration: 200,
    };
    const discoveryServer = {
      ...structuredClone(server),
      spanID: owner.spanID + "-discovery-runtime",
      startTime: server.startTime - 1000,
      duration: 100,
      references: [
        {
          refType: "CHILD_OF",
          traceID: trace.traceID,
          spanID: discoveryClient.spanID,
        },
      ],
    };
    setTag(discoveryServer, "rpc.method", "discover");
    client.startTime = owner.startTime + 300;
    owner.duration = client.startTime + client.duration - owner.startTime + 100;
    trace.spans.splice(
      trace.spans.indexOf(client),
      0,
      discoveryClient,
      discoveryServer,
    );
  }
  run.duration =
    Math.max(...trace.spans.map((span) => span.startTime + span.duration)) -
    run.startTime +
    1000;
  request.duration = run.startTime + run.duration - request.startTime + 2000;
  return { ...read, request, run, info, list };
}

export function addPostPromptInformationRead(trace, options = {}) {
  const request = trace.spans.find(
    (span) =>
      tag(span, "rpc.method") === "session/prompt" &&
      trace.processes[span.processID].serviceName === "agent-acp-service",
  );
  const run = trace.spans.find((span) => span.operationName === "agent.run");
  const before = trace.spans.length;
  const proof = addCompletedRead(
    trace,
    request,
    "http",
    tag(request, "antnest.agent.id"),
    {
      preserveRequest: true,
      runtimeOutcome: "success",
      clientOutcome: "success",
      ...options,
    },
  );
  const delta = run.startTime + run.duration + 1000 - proof.read.startTime;
  for (const span of trace.spans.slice(before)) {
    span.startTime += delta;
    for (const event of span.logs ?? []) event.timestamp += delta;
  }
  request.duration =
    proof.read.startTime + proof.read.duration - request.startTime + 1000;
  return proof;
}
