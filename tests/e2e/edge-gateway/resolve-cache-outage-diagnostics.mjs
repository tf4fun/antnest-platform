import assert from "node:assert/strict";
import {
  resolveTraceSources,
  resolveTraceDiagnostics,
} from "../../support/gateway-resolution-evidence.mjs";
import { clockSkewWarning } from "../../support/strict-findings.mjs";
import { hasError } from "../acp-plan/requests.mjs";

import { outageGateNames } from "../../support/resolve-cache-admission.mjs";
export { outageGateNames };
const claimNames = outageGateNames.filter(
  (n) => !["authority", "recovery_authority"].includes(n),
);
const key = (row) => `${row.trace_id}:${row.span_id}`;
export function inspectOutageDiagnostics(collection, gates, secrets = []) {
  assert(
    collection.traces instanceof Map &&
      collection.archivedTraceIDs instanceof Set,
  );
  assert.deepEqual(
    [...collection.traces.keys()].sort(),
    [...collection.archivedTraceIDs].sort(),
    "raw archive inventory mismatch",
  );
  const first = collection.traces.values().next().value;
  assert(first, "raw outage archive missing");
  const all = resolveTraceSources(first, secrets, collection),
    errors = new Map();
  for (const trace of all) {
    const warning = (items) => {
      assert(Array.isArray(items), "malformed warning inventory");
      for (const value of items)
        assert(
          typeof value === "string" && clockSkewWarning.test(value),
          "unreviewed raw warning",
        );
    };
    warning(trace.warnings ?? []);
    for (const span of trace.spans) {
      assert(
        Number.isFinite(span.startTime) &&
          Number.isFinite(span.duration) &&
          span.duration >= 0,
        "unfinished raw span",
      );
      warning(span.warnings ?? []);
      if (hasError(span))
        errors.set(
          key({ trace_id: trace.traceID, span_id: span.spanID }),
          span,
        );
      else
        for (const field of [
          ...(span.tags ?? []),
          ...(span.logs ?? []).flatMap((e) => e.fields ?? []),
        ]) {
          const explicitError =
            (/^(error\.(type|code)|exception\.|antnest\.error\.)/u.test(
              field.key,
            ) &&
              field.value !== "" &&
              field.value !== undefined &&
              !(
                field.key === "antnest.error.class" && field.value === "none"
              )) ||
            (field.key === "event" &&
              ["exception", "error"].includes(field.value)) ||
            (field.key === "otel.status_code" && field.value === 2) ||
            ((field.key === "outcome" || field.key.endsWith(".outcome")) &&
              [
                "error",
                "failed",
                "failure",
                "rejected",
                "unavailable",
              ].includes(field.value));
          assert(
            !explicitError,
            "unclassified raw diagnostic outside error inventory",
          );
        }
    }
  }
  for (const name of outageGateNames)
    assert.equal(
      gates[name]?.status,
      "passed",
      `owning gate ${name} incomplete`,
    );
  const owned = new Map();
  for (const name of claimNames) {
    const claims = gates[name].owned_error_spans;
    assert(Array.isArray(claims), `owning gate ${name} claims missing`);
    for (const claim of claims) {
      assert(
        claim &&
          typeof claim.trace_id === "string" &&
          typeof claim.span_id === "string" &&
          typeof claim.reason === "string" &&
          claim.reason.length > 0,
        "malformed exact error claim",
      );
      const id = key(claim);
      assert(errors.has(id), "claim is not an actual archived error");
      const prior = owned.get(id);
      if (prior) {
        assert.equal(prior.reason, claim.reason, "conflicting error ownership");
        prior.owners.add(name);
      } else
        owned.set(id, {
          trace_id: claim.trace_id,
          span_id: claim.span_id,
          reason: claim.reason,
          owners: new Set([name]),
        });
    }
  }
  assert.deepEqual(
    [...owned.keys()].sort(),
    [...errors.keys()].sort(),
    "unowned raw outage error",
  );
  return {
    status: "passed",
    trace_count: all.length,
    owning_gate_names: [...outageGateNames],
    owned_error_count: owned.size,
    owned_error_spans: [...owned.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, v]) => ({ ...v, owners: [...v.owners].sort() })),
    unowned_error_spans: [],
    ...resolveTraceDiagnostics(first, all),
  };
}
