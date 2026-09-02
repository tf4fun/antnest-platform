const jaegerUrl = new URL(required(2));
const requestId = required(3);
const lifecycleKind = required(4);
const expectedServices = process.argv.slice(5);
if (expectedServices.length === 0) {
  throw new Error("at least one expected service is required");
}

const recoveryOperation = "recover Agent lifecycle operation";
const requestIDTag = "antnest.lifecycle.request_id";
const lifecycleKindTag = "antnest.lifecycle.kind";
const lifecyclePhaseTag = "antnest.lifecycle.phase";
const forbiddenValues = ["stage3-admin-password", "stage3-provider-secret"];
const expectedPhaseServices = lifecyclePhaseServices(lifecycleKind);
const expectedPhases = Object.keys(expectedPhaseServices);

let lastEvidence = { traces: 0, services: [], phases: [], linked_roots: 0 };
let lastQueryError = "";
for (let attempt = 0; attempt < 40; attempt += 1) {
  try {
    const traces = await findLifecycleTraces();
    const evidence = inspectLifecycleTraces(traces);
    lastEvidence = evidence;
    lastQueryError = "";
    if (
      expectedServices.every((service) => evidence.services.includes(service)) &&
      expectedPhases.every((phase) => evidence.phases.includes(phase)) &&
      expectedPhases.every((phase) =>
        expectedPhaseServices[phase].every((service) =>
          evidence.phase_services[phase]?.includes(service),
        ),
      ) &&
      evidence.linked_roots === Math.max(0, evidence.traces - 1)
    ) {
      process.stdout.write(`${JSON.stringify({ request_id: requestId, ...evidence })}\n`);
      process.exit(0);
    }
  } catch (error) {
    if (String(error).includes("secret material") || String(error).includes("invalid lifecycle")) {
      throw error;
    }
    lastQueryError = String(error);
  }
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}

throw new Error(
  `lifecycle ${requestId} lacks complete phase-trace evidence; ` +
  `observed traces=${lastEvidence.traces} linked_roots=${lastEvidence.linked_roots} ` +
    `services=${lastEvidence.services.join(", ")} phases=${lastEvidence.phases.join(", ")} ` +
    `query_error=${lastQueryError || "none"}`,
);

async function findLifecycleTraces() {
  const endpoint = new URL("/api/traces", jaegerUrl);
  endpoint.searchParams.set("service", "agent-controller");
  endpoint.searchParams.set("operation", recoveryOperation);
  endpoint.searchParams.set("tags", JSON.stringify({ [requestIDTag]: requestId }));
  endpoint.searchParams.set("lookback", "1h");
  endpoint.searchParams.set("limit", "100");
  const response = await fetch(endpoint);
  if (!response.ok) {
    throw new Error(`Jaeger query returned ${response.status}`);
  }
  return (await response.json())?.data ?? [];
}

function inspectLifecycleTraces(traces) {
  const roots = new Map();
  const services = new Set();
  const phases = new Set();
  const phaseServices = new Map();
  let spans = 0;

  for (const trace of traces) {
    const encoded = JSON.stringify(trace);
    for (const forbidden of forbiddenValues) {
      if (encoded.includes(forbidden)) throw new Error("trace contains secret material");
    }

    const processServices = new Map(
      Object.entries(trace.processes ?? {}).map(([id, process]) => [id, process.serviceName]),
    );
    const traceSpans = trace.spans ?? [];
    const traceServices = new Set(
      traceSpans.map((span) => processServices.get(span.processID)).filter(Boolean),
    );
    for (const service of traceServices) services.add(service);
    spans += traceSpans.length;

    const parentless = traceSpans.filter(
      (span) => !(span.references ?? []).some((reference) => reference.refType === "CHILD_OF"),
    );
    const matchingRoots = parentless.filter(
      (span) =>
        span.operationName === recoveryOperation &&
        processServices.get(span.processID) === "agent-controller" &&
        tagValue(span, requestIDTag) === requestId &&
        tagValue(span, lifecycleKindTag) === lifecycleKind,
    );
    if (parentless.length !== 1 || matchingRoots.length !== 1) {
      throw new Error(
        `invalid lifecycle trace ${trace.traceID ?? "unknown"}: ` +
        `parentless=${parentless.length} matching_roots=${matchingRoots.length}`,
      );
    }
    const root = matchingRoots[0];
    if (traceSpans.some((span) => span.traceID !== root.traceID)) {
      throw new Error(`invalid lifecycle trace ${root.traceID}: mixed trace IDs`);
    }
    roots.set(`${root.traceID}/${root.spanID}`, root);
    const phase = tagValue(root, lifecyclePhaseTag);
    if (expectedPhaseServices[phase] === undefined) {
      throw new Error(`invalid lifecycle trace ${root.traceID}: unexpected phase ${phase}`);
    }
    phases.add(phase);
    const observed = phaseServices.get(phase) ?? new Set();
    for (const service of traceServices) observed.add(service);
    phaseServices.set(phase, observed);
  }

  let unlinkedRoots = 0;
  let linkedRoots = 0;
  for (const root of roots.values()) {
    const causalLinks = (root.references ?? []).filter(
      (reference) => reference.refType === "FOLLOWS_FROM",
    );
    if (causalLinks.length === 0) {
      throw new Error(`invalid lifecycle trace ${root.traceID}: root lacks causal link`);
    }
    const linksPriorAttempt = causalLinks.some(
      (reference) =>
        roots.has(`${reference.traceID}/${reference.spanID}`),
    );
    if (linksPriorAttempt) linkedRoots += 1;
    else unlinkedRoots += 1;
  }
  if (roots.size > 0 && unlinkedRoots !== 1) {
    throw new Error(`invalid lifecycle trace chain: ${unlinkedRoots} roots lack a prior-attempt link`);
  }

  return {
    traces: roots.size,
    linked_roots: linkedRoots,
    services: [...services].sort(),
    phases: [...phases].sort(),
    phase_services: Object.fromEntries(
      [...phaseServices].map(([phase, observed]) => [phase, [...observed].sort()]),
    ),
    spans,
  };
}

function lifecyclePhaseServices(kind) {
  const expectations = {
    create: {
      network_ensure: ["agent-controller", "antnest-runtime-egress"],
      runtime_initialize: ["agent-controller", "runtime-controller"],
      publish: ["agent-controller", "antnest-runtime-egress"],
    },
  };
  if (expectations[kind] === undefined) throw new Error(`unsupported lifecycle kind ${kind}`);
  return expectations[kind];
}

function tagValue(span, key) {
  return (span.tags ?? []).find((tag) => tag.key === key)?.value;
}

function required(index) {
  const value = process.argv[index];
  if (!value) throw new Error(`argument ${index - 1} is required`);
  return value;
}
