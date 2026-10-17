import { costControlTraceFixture } from "../acp-cost/control-trace.fixture.mjs";
import { costSessionTraceFixture } from "../acp-cost/session-trace.fixture.mjs";
import { fixture as commandFixture } from "../acp-commands/trace-fixtures.mjs";
import { privateBoundaryFixture } from "../acp-plan/private-boundary.fixture.mjs";
import { addPostPromptInformationRead } from "../observability/runtime-information-run-fixtures.mjs";
import { privatePersistenceFaultFixture } from "./fault-trace.fixture.mjs";
import { indexPersistenceRequests } from "./client-evidence.mjs";
import { lifecycleResolutionFixture } from "../stage3-base/resolve-fixtures.mjs";
import { runtimeCommandId } from "../stage3-base/contracts.mjs";

export function persistenceReceipt(expected) {
  const {
    version,
    kind,
    label,
    phase,
    connectionTrace,
    connectionSpanID,
    ...actual
  } = expected;
  void version;
  void kind;
  void label;
  void phase;
  void connectionTrace;
  void connectionSpanID;
  return structuredClone(actual);
}

export function persistenceCollectorFixture(version = 1, kind = "initialize") {
  let f;
  if (["intent", "accept", "finish"].includes(kind)) {
    f = privatePersistenceFaultFixture(version, kind);
    f.fault.label = `v${version}-${kind}`;
    f.fault.prompt_receipt = persistenceReceipt(f.expected);
    if (version === 1 && kind === "finish")
      addPostPromptInformationRead(f.trace);
  } else if (kind === "ordinary") {
    f = privateBoundaryFixture(commandFixture("ordinary"), { version });
    Object.assign(f.expected, {
      version,
      kind,
      label: `v${version}-intent-post`,
      phase: `v${version}-intent-post`,
      inputSessionID: "session",
      outcome: "succeeded",
      requestParams: {
        sessionId: "session",
        prompt: [{ type: "text", text: `v${version}-intent-post` }],
      },
      requestResult:
        version === 1 ? { stopReason: "end_turn" } : { messageId: "message" },
    });
    for (const row of f.requests) row.phase = f.expected.phase;
    if (version === 1) addPostPromptInformationRead(f.trace);
  } else if (kind === "initialize") {
    f = costControlTraceFixture({ version, catalog: version === 1 });
    f.expected.label = `v${version}-intent-prompt-initialize`;
  } else {
    f = costSessionTraceFixture({
      version,
      method:
        kind === "new"
          ? "session/new"
          : version === 1
            ? "session/load"
            : "session/resume",
      catalog: version === 1,
    });
    f.expected.label = `v${version}-intent-${kind === "new" ? "new" : "replay-1"}`;
    f.expected.requestParams = structuredClone(
      f.expected.requestReceipt.params,
    );
    f.expected.requestResult = structuredClone(
      f.expected.requestReceipt.result,
    );
    delete f.expected.requestReceipt;
  }
  // Jaeger exports fixed-width IDs. Preserve every internal and external edge
  // and diagnostic origin while adapting the existing readable source fixtures.
  const ids = new Map(
    f.trace.spans.map((span, index) => [
      span.spanID,
      (index + 1).toString(16).padStart(16, "0"),
    ]),
  );
  for (const span of f.trace.spans) {
    span.spanID = ids.get(span.spanID);
    for (const ref of span.references)
      if (ref.traceID === f.trace.traceID) ref.spanID = ids.get(ref.spanID);
    for (const fields of [
      span.tags,
      ...(span.logs ?? []).map((event) => event.fields),
    ])
      for (const field of fields)
        if (
          ["span_id", "antnest.error.origin_span_id"].includes(field.key) &&
          ids.has(field.value)
        )
          field.value = ids.get(field.value);
  }
  for (const row of f.requests ?? [])
    row.model_span_id = ids.get(row.model_span_id);
  f.requests ??= [];
  f.faults = f.fault ? [f.fault] : [];
  return f;
}

// Build the complete consumer inventory from independent owning Trace fixtures.
// Re-key exact identities without changing their span topology or diagnostics.
export function persistenceCollectionFixture() {
  const traces = new Map(),
    byLabel = new Map(),
    connections = [],
    faults = [],
    modelRequests = [],
    lifecycle = [];
  let nextID = 100;
  const traceID = () => (++nextID).toString(16).padStart(32, "0");
  const rewrite = (value, replacements) => {
    if (typeof value === "string") return replacements.get(value) ?? value;
    if (Array.isArray(value))
      return value.map((item) => rewrite(item, replacements));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          rewrite(item, replacements),
        ]),
      );
    return value;
  };
  for (const version of [1, 2])
    for (const phase of ["intent", "accept", "finish"]) {
      const scenario = `v${version}-${phase}`,
        sessionId = `${scenario}-session`;
      for (const role of ["prompt", "replay-1", "replay-2"]) {
        const connectionTraceID = traceID(),
          clientSpanID = (++nextID).toString(16).padStart(16, "0");
        const kinds =
          role === "prompt"
            ? ["initialize", "new", phase]
            : [
                "initialize",
                "replay",
                ...(role === "replay-2" ? ["ordinary"] : []),
              ];
        const rows = [];
        for (const [index, kind] of kinds.entries()) {
          const f = persistenceCollectorFixture(version, kind);
          const label =
            kind === "initialize"
              ? `${scenario}-${role}-initialize`
              : kind === "new"
                ? `${scenario}-new`
                : kind === "replay"
                  ? `${scenario}-${role}`
                  : kind === "ordinary"
                    ? `${scenario}-post`
                    : `${scenario}-fault`;
          const replacements = new Map([
            [f.trace.traceID, traceID()],
            [f.expected.connectionTraceID, connectionTraceID],
            [f.expected.clientSpanID, clientSpanID],
            ["session", sessionId],
            ["new-session", sessionId],
            [
              "run",
              `${scenario}-${kind === "ordinary" ? "post" : "fault"}-run`,
            ],
            ["receipt", `${scenario}-receipt`],
            [f.expected.label, label],
          ]);
          const expected = rewrite(f.expected, replacements),
            trace = rewrite(f.trace, replacements);
          for (const source of [trace, expected.connectionTrace])
            for (const resource of Object.values(source.processes))
              if (resource.serviceName === "agent-acp-service") {
                resource.tags = resource.tags.filter(
                  (field) =>
                    ![
                      "host.name",
                      "process.pid",
                      "service.instance.id",
                    ].includes(field.key),
                );
                resource.tags.push(
                  { key: "host.name", value: "persistence-acp-host" },
                  {
                    key: "process.pid",
                    value: Number.parseInt(clientSpanID, 16),
                  },
                  {
                    key: "service.instance.id",
                    value: `persistence-${connectionTraceID}`,
                  },
                );
              }
          expected.requestId = String(index + 1);
          for (const span of trace.spans)
            for (const field of [
              ...span.tags,
              ...(span.logs ?? []).flatMap((event) => event.fields),
            ])
              if (["antnest.request.id", "request_id"].includes(field.key))
                field.value = expected.requestId;
          rows.push(persistenceReceipt(expected));
          if (f.fault) {
            const fault = rewrite(f.fault, replacements);
            fault.label = scenario;
            fault.prompt_receipt = persistenceReceipt(expected);
            faults.push(fault);
          }
          modelRequests.push(...rewrite(f.requests, replacements));
          traces.set(trace.traceID, trace);
          traces.set(connectionTraceID, expected.connectionTrace);
          byLabel.set(label, trace.traceID);
        }
        connections.push({
          version,
          phase,
          role,
          agentId: "agent",
          connectionTraceID,
          clientSpanID,
          closed: true,
          initialization: rows[0],
          evidence: rows.slice(1),
          evidence_errors: [],
          requests: rows.map((row) => ({
            requestId: row.requestId,
            method: row.method,
            sessionId: row.inputSessionID,
          })),
          raw_frames: rows
            .filter((row) => row.outcome === "succeeded")
            .map((row) => ({
              id: Number(row.requestId),
              result: structuredClone(
                row.method === "initialize"
                  ? row.initializationResult
                  : row.requestResult,
              ),
            })),
        });
      }
    }
  for (const kind of ["create", "delete"]) {
    const f = lifecycleResolutionFixture(kind, "shared");
    const replacements = new Map(
      [...f.traces.keys()].map((id) => [id, traceID()]),
    );
    replacements.set(f.expected.agentId, "agent");
    for (const phase of ["runtime_initialize", "runtime_delete"])
      replacements.set(
        runtimeCommandId(f.expected.requestId, phase),
        runtimeCommandId(`${kind}-request`, phase),
      );
    const requestReferences = (value) => {
      if (typeof value === "string" && value.includes(f.expected.requestId))
        replacements.set(
          value,
          value.replaceAll(f.expected.requestId, `${kind}-request`),
        );
      else if (value && typeof value === "object")
        for (const item of Object.values(value)) requestReferences(item);
    };
    requestReferences(f.expected);
    for (const source of f.traces.values()) requestReferences(source);
    const expected = rewrite(f.expected, replacements);
    lifecycle.push(expected);
    for (const source of f.traces.values()) {
      const trace = rewrite(source, replacements);
      traces.set(trace.traceID, trace);
    }
  }
  return {
    traces,
    byLabel,
    input: {
      ...indexPersistenceRequests({ agentId: "agent", connections }),
      connections,
      faults,
      lifecycle,
      modelRequests,
    },
  };
}
