const jaegerUrl = new URL(requiredArgument(2, "Jaeger URL"));
const traceId = requiredArgument(3, "trace ID");
const traceKind = requiredArgument(4, "trace kind");
const expectation = expectations()[traceKind];
if (expectation === undefined) {
  throw new Error(`unknown trace kind ${traceKind}`);
}

const forbiddenValues = [
  "stage2-model-secret",
  "Create the Stage 2 acceptance evidence file.",
  "stage2-runtime-tool-ok",
  "stage2-evidence.txt",
];
const forbiddenAttribute = /(?:^|[._])(prompt|secret|tool[._](?:arguments|result))(?:$|[._])/iu;

const trace = await waitForTrace();
const { processService, spanService, observedServices } = indexTrace(trace);

for (const expected of expectation.services) {
  if (!observedServices.has(expected)) {
    throw new Error(
      `${traceKind} trace lacks ${expected}; observed: ${[...observedServices].sort().join(",")}`,
    );
  }
}
for (const [service, operations] of Object.entries(expectation.operations)) {
  const observed = new Set(
    trace.spans
      .filter((span) => processService.get(span.processID) === service)
      .map((span) => span.operationName),
  );
  for (const operation of operations) {
    if (!observed.has(operation)) {
      throw new Error(
        `${traceKind} trace lacks ${service}/${operation}; observed: ${[...observed].sort().join(",")}`,
      );
    }
  }
}
for (const [parentService, childService] of expectation.edges) {
  if (!hasServiceEdge(parentService, childService)) {
    throw new Error(`${traceKind} trace lacks ${parentService} -> ${childService} parent edge`);
  }
}

for (const span of trace.spans) {
  for (const tag of span.tags ?? []) {
    if (forbiddenAttribute.test(tag.key)) {
      throw new Error(`${traceKind} trace exported forbidden attribute ${tag.key}`);
    }
  }
}
const encoded = JSON.stringify(trace);
for (const forbidden of forbiddenValues) {
  if (encoded.includes(forbidden)) {
    throw new Error(`${traceKind} trace exported forbidden business data`);
  }
}

process.stdout.write(
  `${JSON.stringify({ trace_id: traceId, kind: traceKind, services: [...observedServices].sort(), spans: trace.spans.length })}\n`,
);

function hasServiceEdge(parentService, childService) {
  return trace.spans.some((span) => {
    if (processService.get(span.processID) !== childService) {
      return false;
    }
    return (span.references ?? []).some(
      (reference) => spanService.get(reference.spanID) === parentService,
    );
  });
}

async function waitForTrace() {
  const endpoint = new URL(`/api/traces/${traceId}`, jaegerUrl);
  let observedSpanCount = 0;
  let missing = ["trace data"];
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(endpoint);
      if (response.ok) {
        const payload = await response.json();
        const candidate = payload?.data?.[0];
        if (candidate?.spans?.length > 0) {
          missing = missingExpectations(candidate);
          if (missing.length === 0) {
            return candidate;
          }
        }
        observedSpanCount = candidate?.spans?.length ?? observedSpanCount;
      }
    } catch {
      // Jaeger may still be starting or the batch exporter may not have flushed.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(
    `trace ${traceId} did not reach the complete ${traceKind} topology; observed ${observedSpanCount} spans; missing: ${missing.join(", ")}`,
  );
}

function missingExpectations(trace) {
  const { processService, spanService, observedServices } = indexTrace(trace);
  const missing = expectation.services
    .filter((service) => !observedServices.has(service))
    .map((service) => `service ${service}`);
  for (const [service, operations] of Object.entries(expectation.operations)) {
    const observed = new Set(
      trace.spans
        .filter((span) => processService.get(span.processID) === service)
        .map((span) => span.operationName),
    );
    for (const operation of operations) {
      if (!observed.has(operation)) {
        missing.push(`operation ${service}/${operation}`);
      }
    }
  }
  for (const [parentService, childService] of expectation.edges) {
    const found = trace.spans.some(
      (span) =>
        processService.get(span.processID) === childService &&
        (span.references ?? []).some(
          (reference) => spanService.get(reference.spanID) === parentService,
        ),
    );
    if (!found) {
      missing.push(`edge ${parentService}->${childService}`);
    }
  }
  return missing;
}

function indexTrace(trace) {
  const processService = new Map(
    Object.entries(trace.processes ?? {}).map(([id, process]) => [id, process.serviceName]),
  );
  return {
    processService,
    spanService: new Map(
      trace.spans.map((span) => [span.spanID, processService.get(span.processID)]),
    ),
    observedServices: new Set(processService.values()),
  };
}

function expectations() {
  return {
    lifecycle: {
      services: ["agent-controller", "antnest-runtime-egress", "runtime-controller"],
      operations: {
        "agent-controller": [
          "HTTP POST /internal/agents",
          "agent_controller.egress.ensure_agent_network",
          "agent_controller.runtime.initialize",
        ],
        "antnest-runtime-egress": ["egress.control"],
        "runtime-controller": ["runtime.lifecycle.initialize_runtime", "runtime.platform.create"],
      },
      edges: [
        ["agent-controller", "antnest-runtime-egress"],
        ["agent-controller", "runtime-controller"],
      ],
    },
    execution: {
      services: ["agent-acp-service", "agent-controller", "antnest-runtime"],
      operations: {
        "agent-acp-service": [
          "acp.session.prompt",
          "agent.run",
          "agent_controller.acquire_run",
          "model.complete",
          "mcp.tools.list",
          "mcp.tools.call",
          "agent_controller.finish_run",
        ],
        "agent-controller": [
          "HTTP POST /rpc/agent-controller/acquire-run",
          "HTTP POST /rpc/agent-controller/finish-run",
        ],
        "antnest-runtime": [
          "runtime.http",
          "runtime.mcp.operation",
          "runtime.mcp.tool",
          "runtime.executor",
        ],
      },
      edges: [
        ["agent-acp-service", "agent-controller"],
        ["agent-acp-service", "antnest-runtime"],
      ],
    },
  };
}

function requiredArgument(index, name) {
  const value = process.argv[index]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}
