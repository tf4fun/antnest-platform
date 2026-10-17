import { inspectRuntimeToolLifecycle } from "../observability/runtime-tool-lifecycle.mjs";
import { namedEvent } from "../observability/runtime-tool-evidence.mjs";

const deferred = "deferred-same-node-sdk-sub-ms-endpoint";
const deferredHTTP = "deferred-node-http-sub-ms-endpoint";
const reviewedUpgrade = "reviewed-node-ws-post-response-endpoint";
const reviewedRuntimeCleanup = "reviewed-runtime-tool-http-cleanup";
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
      // supplies the parent edge used by Jaeger's warning propagation; it
      // does not imply that a server joins its work before the peer returns.
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
    sdk:
      values.get("telemetry.sdk.language") === "nodejs" &&
      values.get("telemetry.sdk.name") === "opentelemetry",
    node:
      values.get("process.runtime.name") === "nodejs" &&
      (!values.has("telemetry.sdk.language") ||
        values.get("telemetry.sdk.language") === "nodejs") &&
      (!values.has("telemetry.sdk.name") ||
        values.get("telemetry.sdk.name") === "opentelemetry"),
  };
}

function attributes(span) {
  if (!Array.isArray(span.tags)) return null;
  const result = new Map();
  for (const item of span.tags) {
    if (!item || typeof item.key !== "string" || result.has(item.key))
      return null;
    result.set(item.key, item.value);
  }
  return result;
}

function status(fields) {
  const current = fields.get("http.response.status_code");
  const legacy = fields.get("http.status_code");
  if (current !== undefined && legacy !== undefined && current !== legacy)
    return null;
  return current ?? legacy;
}

function nodeHTTPBoundary(trace, child, parent, left, right) {
  if (
    !left.node ||
    !right.node ||
    !right.sdk ||
    trace.processes[child.processID].serviceName !== "agent-acp-service" ||
    trace.processes[parent.processID].serviceName !==
      "antnest-private-acp-client" ||
    child.startTime < parent.startTime ||
    child.startTime % 1000 !== 0 ||
    parent.startTime % 1000 !== 0 ||
    end(child) <= end(parent)
  )
    return false;
  const c = attributes(child),
    p = attributes(parent);
  if (!c || !p) return false;
  const method = c.get("http.request.method"),
    route = c.get("http.route");
  return (
    c.get("span.kind") === "server" &&
    p.get("span.kind") === "client" &&
    ["GET", "POST", "DELETE"].includes(method) &&
    p.get("http.request.method") === method &&
    ["/v1/acp", "/v2/acp"].includes(route) &&
    c.get("antnest.listener") === "workspace" &&
    child.operationName === `HTTP ${method} ${route}` &&
    parent.operationName === `HTTP ${method} agent-acp-workspace` &&
    [101, 200, 202, 204].includes(status(c)) &&
    status(c) === status(p)
  );
}

function deferredNodeHTTP(trace, child, parent, left, right) {
  // This existing user deferral remains strictly below one millisecond.
  // Neither independent Node anchors nor post-write completion is claimed
  // as the cause of an individual raw observation.
  return (
    end(child) - end(parent) < 1000 &&
    nodeHTTPBoundary(trace, child, parent, left, right)
  );
}

function reviewedNodeUpgrade(trace, child, parent, left, right) {
  if (!nodeHTTPBoundary(trace, child, parent, left, right)) return false;
  const c = attributes(child),
    p = attributes(parent);
  if (c.get("http.request.method") !== "GET" || status(c) !== 101) return false;
  for (const fields of [c, p])
    if (
      ![undefined, false].includes(fields.get("error")) ||
      ![undefined, "UNSET", "OK"].includes(fields.get("otel.status_code")) ||
      fields.has("error.type") ||
      fields.has("exception.type") ||
      ["error", "failed", "cancelled", "rejected", "disconnected"].includes(
        fields.get("antnest.outcome"),
      )
    )
      return false;
  const names = [
    "antnest.http.upgrade.response.prepared",
    "antnest.http.upgrade.connection.setup.started",
    "antnest.http.upgrade.connection.setup.completed",
  ];
  if (!Array.isArray(child.logs) || child.logs.length !== names.length)
    return false;
  let previous = child.startTime;
  for (const [index, event] of child.logs.entries()) {
    if (
      !event ||
      !Number.isSafeInteger(event.timestamp) ||
      event.timestamp < previous ||
      event.timestamp > end(child) ||
      !Array.isArray(event.fields) ||
      event.fields.length !== 1 ||
      event.fields[0]?.key !== "event" ||
      event.fields[0]?.value !== names[index] ||
      ![undefined, "string"].includes(event.fields[0]?.type)
    )
      return false;
    previous = event.timestamp;
  }
  // The real worker gate proves that setup may outlive the accepted peer
  // handshake. Original response preparation must still fall inside that
  // CLIENT, so whole-span/event clock shifts cannot borrow an arbitrary tail.
  // This is a lifecycle classification, not cross-process clock calibration.
  return child.logs[0].timestamp <= end(parent);
}

function runtimeCleanupSource({ trace, parents }, propagation) {
  // Re-run the existing complete parsed-result proof on original objects.
  // Rust resources are checked here in their native scope; the generic Node
  // process policy remains unchanged. This helper alone cannot grant admission.
  try {
    const server = propagation.at(-1),
      client = parents.get(server);
    if (
      server?.operationName !== "HTTP POST /mcp" ||
      client?.operationName !== "HTTP POST antnest-runtime" ||
      warnings(server).length !== 1 ||
      server.startTime < client.startTime ||
      end(server) <= end(client) ||
      !processIdentity(trace, client)?.node
    )
      return null;
    const fields = attributes(server);
    const resource = attributes(trace.processes[server.processID]);
    if (!fields || !resource) return null;
    const agentId = fields.get("antnest.agent.id"),
      executionId = fields.get("antnest.runtime.execution.id");
    const generation = fields.get("antnest.runtime.generation");
    const image = resource.get("antnest.runtime.image.id"),
      reference = resource.get("antnest.runtime.image.reference");
    if (
      typeof agentId !== "string" ||
      !agentId.trim() ||
      typeof executionId !== "string" ||
      !executionId.trim() ||
      !/^[1-9]\d*$/u.test(generation) ||
      !Number.isSafeInteger(Number(generation)) ||
      resource.get("antnest.agent.id") !== agentId ||
      resource.get("antnest.runtime.generation") !== generation ||
      resource.get("telemetry.sdk.language") !== "rust" ||
      resource.get("telemetry.sdk.name") !== "opentelemetry" ||
      typeof image !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(image) ||
      typeof reference !== "string" ||
      !reference.trim() ||
      fields.get("antnest.protocol.outcome") !== "success" ||
      fields.get("http.transport.outcome") !== "success"
    )
      return null;
    const owner = parents.get(client);
    const proof = inspectRuntimeToolLifecycle(trace, owner, {
      agentId,
      executionId,
    });
    const pairs = proof.exchanges.filter(
      (pair) => pair.server === server && pair.client === client,
    );
    if (
      proof.parsedOutcome !== "success" ||
      !proof.ownedCancellations.has(client) ||
      pairs.length !== 1
    )
      return null;
    const operation = pairs[0].operation;
    const completed = namedEvent(operation, "Runtime MCP operation completed");
    if (
      operation.startTime < client.startTime ||
      end(operation) > end(client) ||
      !Number.isSafeInteger(completed.timestamp) ||
      completed.timestamp < client.startTime ||
      completed.timestamp > end(client)
    )
      return null;
    // No other edge can borrow this HTTP tail: descendants must remain in
    // the same original Rust process and inside their immediate parent.
    for (const span of propagation) {
      if (span === server) continue;
      const parent = parents.get(span);
      if (
        !parent ||
        span.processID !== server.processID ||
        parent.processID !== server.processID ||
        span.startTime < parent.startTime ||
        end(span) > end(parent)
      )
        return null;
    }
    return {
      trace_id: trace.traceID,
      span_id: server.spanID,
      parent_span_id: client.spanID,
      raw_end_beyond_parent_us: end(server) - end(client),
      classification: reviewedRuntimeCleanup,
      runtime_cleanup: {
        tool_span_id: owner.spanID,
        operation_span_id: operation.spanID,
        agent_id: agentId,
        execution_id: executionId,
        runtime_generation: generation,
        runtime_image_id: image,
        runtime_image_reference: reference,
        runtime_process_id: server.processID,
        client_process_id: client.processID,
        raw_operation_end_us: end(operation),
        raw_client_end_us: end(client),
        raw_server_end_us: end(server),
        owner_events: structuredClone(proof.events),
        operation_completed: structuredClone(completed),
        server_completed: structuredClone(
          namedEvent(server, "Runtime HTTP request completed"),
        ),
        client_cancelled: structuredClone(
          namedEvent(client, "antnest.cancelled"),
        ),
      },
    };
  } catch {
    return null;
  }
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

  const cleanup = runtimeCleanupSource(context, propagation);
  if (cleanup) return { ...cleanup, calculated_delta_us: delta };

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
  else if (crossProcess)
    classification = deferredNodeHTTP(trace, child, parent, left, right)
      ? deferredHTTP
      : reviewedNodeUpgrade(trace, child, parent, left, right)
        ? reviewedUpgrade
        : "cross-process";
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
    ...(classification === reviewedUpgrade
      ? { upgrade_events: structuredClone(child.logs) }
      : {}),
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
    const count = inventory.filter((item) =>
      [deferred, deferredHTTP].includes(item.classification),
    ).length;
    const reviewed = inventory.filter((item) =>
      [reviewedUpgrade, reviewedRuntimeCleanup].includes(item.classification),
    ).length;
    return {
      warning_count: inventory.length,
      deferred_warning_count: count,
      reviewed_lifecycle_warning_count: reviewed,
      rejected_warning_count: inventory.length - count - reviewed,
      eligible_for_deferral: inventory.length === count,
      eligible_for_review: inventory.length === count + reviewed,
      inventory,
      sources: [...sourceMap.values()],
    };
  } catch {
    // Raw warning text may contain secrets; detailed results stay in the
    // caller's private archive and are never interpolated into an exception.
    throw invalid();
  }
}
