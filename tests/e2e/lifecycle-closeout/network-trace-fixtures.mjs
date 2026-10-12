export function fixture() {
  return {
    traceID: "trace",
    processes: Object.fromEntries(
      [
        "edge-gateway",
        "admin-console",
        "agent-controller",
        "antnest-runtime-egress",
      ].map((serviceName, i) => [i, { serviceName }]),
    ),
    spans: [0, 1, 2, 3].map((i) => ({
      processID: String(i),
      traceID: "trace",
      spanID: String(i),
      operationName:
        i === 3
          ? "HTTP PUT /internal/agent-policy-assignments/{agent_id}"
          : "HTTP",
      references:
        i === 0
          ? []
          : [{ refType: "CHILD_OF", traceID: "trace", spanID: String(i - 1) }],
      tags:
        i !== 3
          ? []
          : Object.entries({
              "http.request.method": "PUT",
              "http.route": "/internal/agent-policy-assignments/{agent_id}",
              "http.response.status_code": 200,
              "antnest.agent.id": "agent-a",
            }).map(([key, value]) => ({ key, value })),
    })),
  };
}
