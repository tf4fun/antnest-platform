// Gates a suite that exited 2 (business and topology passed, strict trace
// findings remain). Jaeger clock skew adjustments are the only reviewed
// warning; error spans on denial and cancellation paths are recorded by
// contract (docs/observability-contract.md) and checked by each runner's
// topology. Any other Jaeger warning fails the suite.
export const clockSkewWarning =
  /^clock skew adjustment disabled; not applying calculated delta of -?[0-9.]+(?:ns|µs|ms|s)$/u;

function collect(value, found) {
  if (Array.isArray(value)) {
    for (const item of value) collect(item, found);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "warnings" && Array.isArray(item))
        found.push(...item.filter((warning) => typeof warning === "string"));
      else collect(item, found);
    }
  }
}

export function unreviewedWarnings(output) {
  const warnings = [];
  for (const line of output.split(/\r?\n/u)) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;
    let record;
    try {
      record = JSON.parse(text);
    } catch {
      continue;
    }
    collect(record, warnings);
  }
  return [...new Set(warnings.filter((w) => !clockSkewWarning.test(w)))];
}

function hasStrictTraceFailure(value) {
  if (!value || typeof value !== "object") return false;
  return (
    value.strict_trace === "failed" ||
    Object.values(value).some(hasStrictTraceFailure)
  );
}

function isStrictCompletion(record) {
  const hasTraces = Array.isArray(record.traces) && record.traces.length > 0;
  if (record.status === "business_and_topology_passed")
    return (
      record.strict_exit === 2 &&
      ((record.cleanup === "verified" &&
        record.accepted_exit === 2 &&
        hasTraces) ||
        [
          "identity-core",
          "identity-access",
          "identity-organization-display",
        ].includes(record.suite))
    );
  if (record.status === "browser_passed")
    return (
      record.cleanup === "verified" &&
      record.strict_trace === "failed" &&
      hasTraces
    );
  if (record.status !== "business_passed" || !hasTraces) return false;
  return (
    (record.strict_trace === "failed" &&
      Number.isInteger(record.scenarios) &&
      record.scenarios > 0) ||
    (Array.isArray(record.versions) &&
      record.versions.length === 2 &&
      record.versions[0] === 1 &&
      record.versions[1] === 2 &&
      [record.traces, record.execution_traces, record.offboarding].some(
        hasStrictTraceFailure,
      ))
  );
}

const failedStatuses = new Set([
  "failed",
  "business_failed",
  "cleanup_failed",
  "business_passed_trace_failed",
]);

// Only final business/topology reports establish completion. Diagnostics and
// cleanup-only reports cannot establish it or replace an explicit failure.
export function hasStrictCompletion(output) {
  let completed = false;
  for (const line of output.split(/\r?\n/u)) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;
    let record;
    try {
      record = JSON.parse(text);
    } catch {
      continue;
    }
    if (!record || typeof record !== "object" || Array.isArray(record))
      continue;
    if (failedStatuses.has(record.status) || record.cleanup === "failed") {
      completed = false;
      continue;
    }
    if (isStrictCompletion(record)) completed = true;
  }
  return completed;
}
