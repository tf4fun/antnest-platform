const deferred = "deferred-same-node-sdk-sub-ms-endpoint";
const invalid = () => new Error("invalid Cost warning sources");
const requireSource = (condition) => {
  if (!condition) throw invalid();
};
const warnings = (item) => item.warnings ?? [];
const end = (span) => span.startTime + span.duration;

function topology(sources) {
  requireSource(Array.isArray(sources));
  const traces = new Map();
  for (const trace of sources) {
    requireSource(
      trace &&
        /^[a-f0-9]{32}$/u.test(trace.traceID) &&
        !traces.has(trace.traceID) &&
        Array.isArray(trace.spans) &&
        trace.processes &&
        typeof trace.processes === "object",
    );
    const spans = new Map();
    const parents = new Map();
    for (const item of [trace, ...trace.spans])
      requireSource(
        item &&
          Array.isArray(warnings(item)) &&
          warnings(item).every((warning) => typeof warning === "string"),
      );
    for (const span of trace.spans) {
      requireSource(
        span.traceID === trace.traceID &&
          /^[a-f0-9]{16}$/u.test(span.spanID) &&
          !spans.has(span.spanID) &&
          Number.isSafeInteger(span.startTime) &&
          Number.isSafeInteger(span.duration) &&
          span.duration >= 0 &&
          Number.isSafeInteger(end(span)) &&
          Array.isArray(span.references),
      );
      spans.set(span.spanID, span);
    }
    for (const span of spans.values()) {
      // A WS RPC can link to a different connection Trace. Only CHILD_OF
      // denotes a synchronous parent and can propagate an endpoint warning.
      for (const reference of span.references) {
        requireSource(
          reference &&
            ["CHILD_OF", "FOLLOWS_FROM"].includes(reference.refType) &&
            /^[a-f0-9]{32}$/u.test(reference.traceID) &&
            /^[a-f0-9]{16}$/u.test(reference.spanID),
        );
        if (reference.refType === "FOLLOWS_FROM") continue;
        requireSource(
          !parents.has(span) &&
            reference.traceID === trace.traceID &&
            spans.has(reference.spanID),
        );
        parents.set(span, spans.get(reference.spanID));
      }
    }
    for (const span of spans.values()) {
      const seen = new Set();
      for (let current = span; current; current = parents.get(current)) {
        requireSource(!seen.has(current));
        seen.add(current);
      }
    }
    traces.set(trace.traceID, { trace, parents });
  }
  return traces;
}

function processIdentity(trace, span) {
  const process = trace.processes[span.processID];
  if (!process || !Array.isArray(process.tags)) return null;
  const values = new Map();
  const keys = new Set([
    "host.name",
    "process.pid",
    "service.instance.id",
    "process.runtime.name",
    "telemetry.sdk.language",
    "telemetry.sdk.name",
  ]);
  for (const tag of process.tags) {
    if (!tag || !keys.has(tag.key)) continue;
    if (values.has(tag.key)) return null;
    values.set(tag.key, tag.value);
  }
  const host = values.get("host.name");
  const pid = values.get("process.pid");
  const instance = values.get("service.instance.id");
  if (
    typeof host !== "string" ||
    !host.trim() ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    typeof instance !== "string" ||
    !instance.trim() ||
    typeof process.serviceName !== "string" ||
    !process.serviceName.trim()
  )
    return null;
  return {
    host,
    pid,
    instance,
    key: JSON.stringify([host, pid, instance, process.serviceName]),
    node:
      values.get("process.runtime.name") === "nodejs" &&
      (!values.has("telemetry.sdk.language") ||
        values.get("telemetry.sdk.language") === "nodejs") &&
      (!values.has("telemetry.sdk.name") ||
        values.get("telemetry.sdk.name") === "opentelemetry"),
  };
}

function calculatedDelta(warning) {
  const match =
    /^clock skew adjustment disabled; not applying calculated delta of (-?\d+(?:\.\d+)?)(ns|µs|ms|s)$/u.exec(
      warning,
    );
  if (!match) return null;
  const value =
    Number(match[1]) * { ns: 0.001, µs: 1, ms: 1000, s: 1e6 }[match[2]];
  return Number.isFinite(value) ? value : null;
}

function aliasEquals(value, first, second, expected) {
  return (
    (Object.hasOwn(value, first) || Object.hasOwn(value, second)) &&
    [first, second].every(
      (key) => !Object.hasOwn(value, key) || value[key] === expected,
    )
  );
}

function hasExactObservation(trace, child, parent, identity, observations) {
  const relevant = observations.filter(
    (value) =>
      value?.reason === deferred &&
      value.trace_id === trace.traceID &&
      value.span_id === child.spanID &&
      (value.parent_span_id === parent.spanID ||
        value.next_span_id === parent.spanID),
  );
  if (relevant.length !== 1) return false;
  const value = relevant[0];
  return (
    aliasEquals(value, "parent_span_id", "next_span_id", parent.spanID) &&
    aliasEquals(
      value,
      "raw_child_start_us",
      "raw_span_start_us",
      child.startTime,
    ) &&
    aliasEquals(
      value,
      "raw_parent_start_us",
      "raw_next_start_us",
      parent.startTime,
    ) &&
    value.process_id === child.processID &&
    value.host_name === identity.host &&
    value.process_pid === identity.pid &&
    value.service_instance_id === identity.instance &&
    value.raw_left_us === end(child) &&
    value.raw_right_us === end(parent) &&
    value.raw_difference_us === end(child) - end(parent)
  );
}

function sourceFor(context, span, warning, observations) {
  const delta = calculatedDelta(warning);
  if (delta === null) return { classification: "unknown-warning" };
  if (!span) return { classification: "unattributed-warning" };
  const { trace, parents } = context;
  const ancestors = [];
  for (let current = span; current; current = parents.get(current))
    ancestors.push(current);
  const last = ancestors.findLastIndex((item) =>
    warnings(item).includes(warning),
  );
  const propagation = ancestors.slice(0, last + 1);
  if (
    propagation.some(
      (item) =>
        warnings(item).filter((value) => value === warning).length !== 1,
    )
  )
    return { classification: "ambiguous-source" };

  // Every edge in the propagation chain matters. A later cross-process or
  // inverted edge cannot borrow an earlier ancestor's endpoint observation.
  const candidates = [];
  for (const child of propagation) {
    const parent = parents.get(child);
    if (!parent) return { classification: "unattributed-warning" };
    const left = processIdentity(trace, child);
    const right = processIdentity(trace, parent);
    const uncertain = !left || !right;
    const crossProcess = !uncertain && left.key !== right.key;
    if (
      uncertain ||
      crossProcess ||
      child.startTime < parent.startTime ||
      end(child) > end(parent)
    )
      candidates.push({ child, parent, left, right, uncertain, crossProcess });
  }
  if (candidates.length !== 1)
    return {
      classification: candidates.length
        ? "ambiguous-source"
        : "unattributed-warning",
    };
  const { child, parent, left, right, uncertain, crossProcess } = candidates[0];
  const difference = end(child) - end(parent);
  let classification;
  if (warnings(child).length !== 1) classification = "ambiguous-source";
  else if (uncertain) classification = "invalid-process-identity";
  else if (crossProcess) classification = "cross-process";
  else if (!left.node || !right.node) classification = "unsupported-runtime";
  else if (
    child.startTime < parent.startTime ||
    child.startTime % 1000 !== 0 ||
    parent.startTime % 1000 !== 0 ||
    difference <= 0 ||
    difference >= 1000
  )
    classification = "unsupported-time-boundary";
  else if (Math.abs(delta) >= 1000)
    classification = "unsupported-warning-delta";
  else if (!hasExactObservation(trace, child, parent, left, observations))
    classification = "missing-exact-observation";
  else classification = deferred;
  return {
    trace_id: trace.traceID,
    span_id: child.spanID,
    parent_span_id: parent.spanID,
    raw_end_beyond_parent_us: difference,
    calculated_delta_us: delta,
    classification,
  };
}

// This private diagnostic inventory does not prove archive completeness, own
// errors, or grant admission. Its caller must bind raw sources to collection.
export function inspectCostWarningSources(sources, timeObservations = []) {
  try {
    requireSource(Array.isArray(timeObservations));
    const contexts = topology(sources);
    const inventory = [];
    const sourceMap = new Map();
    for (const context of contexts.values()) {
      const { trace } = context;
      for (const item of [trace, ...trace.spans])
        for (const [index, warning] of warnings(item).entries()) {
          const source = sourceFor(
            context,
            item === trace ? null : item,
            warning,
            timeObservations,
          );
          const occurrence = {
            trace_id: trace.traceID,
            span_id: item === trace ? null : item.spanID,
            warning_index: index,
          };
          const entry = {
            ...occurrence,
            warning,
            classification: source.classification,
          };
          if (source.span_id) {
            entry.source_span_id = source.span_id;
            entry.source_parent_span_id = source.parent_span_id;
            const key = JSON.stringify([
              source.trace_id,
              source.span_id,
              warning,
            ]);
            if (!sourceMap.has(key))
              sourceMap.set(key, { ...source, occurrences: [] });
            sourceMap.get(key).occurrences.push(occurrence);
          }
          inventory.push(entry);
        }
    }
    const count = inventory.filter(
      (item) => item.classification === deferred,
    ).length;
    return {
      warning_count: inventory.length,
      deferred_warning_count: count,
      rejected_warning_count: inventory.length - count,
      eligible_for_deferral: inventory.length === count,
      inventory,
      sources: [...sourceMap.values()],
    };
  } catch {
    // Raw warning text may contain secrets; detailed results stay in the
    // caller's private archive and are never interpolated into an exception.
    throw invalid();
  }
}
