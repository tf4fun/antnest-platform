import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "../stage3-base/trace-fixtures.mjs";
import { inspectLifecycle } from "../stage3-base/trace.mjs";
import { traceTopology, tag } from "../observability/trace-tree.mjs";

test("Delete of an already closed attachment requires the read receipt and no duplicate fence mutation", () => {
  const f = fixture("delete"),
    tree = traceTopology(f.trace);
  const server = f.trace.spans.find(
    (s) =>
      tree.service(s) === "antnest-runtime-egress" &&
      tag(s, "http.request.method") === "PUT" &&
      tag(s, "http.route") === "/internal/agent-network-attachments/{agent_id}",
  );
  assert(server);
  const client = tree.parent(server);
  f.trace.spans = f.trace.spans.filter((s) => !tree.chain(s).includes(client));
  f.expected.networkAlreadyClosed = true;
  assert.equal(inspectLifecycle(f.trace, f.expected).kind, "delete");
  assert.throws(() =>
    inspectLifecycle(f.trace, { ...f.expected, networkAlreadyClosed: false }),
  );
  const duplicate = fixture("delete");
  duplicate.expected.networkAlreadyClosed = true;
  assert.throws(() => inspectLifecycle(duplicate.trace, duplicate.expected));
  const missing = structuredClone(f);
  const next = traceTopology(missing.trace);
  const get = missing.trace.spans.find(
    (s) =>
      tag(s, "http.request.method") === "GET" &&
      next.chain(s).some((p) => p.spanID === "lifecycle.network_fence"),
  );
  missing.trace.spans = missing.trace.spans.filter(
    (s) => !next.chain(s).includes(get),
  );
  assert.throws(() => inspectLifecycle(missing.trace, missing.expected));
});

for (const kind of ["disable", "rebuild", "delete"])
  test(`${kind} accepts an explicitly expected Runtime barrier and still rejects unsettled execution`, () => {
    const f = fixture(kind);
    f.expected.settlementOutcome = "runtime_barrier_required";
    for (const id of ["settle-agent", "settle-agent-client"])
      f.trace.spans
        .find((s) => s.spanID === id)
        .tags.find((t) => t.key === "antnest.settlement.outcome").value =
        "runtime_barrier_required";
    assert.equal(inspectLifecycle(f.trace, f.expected).settlement, true);
    assert.throws(() =>
      inspectLifecycle(f.trace, {
        ...f.expected,
        settlementOutcome: "settled",
      }),
    );
    assert.throws(() =>
      inspectLifecycle(f.trace, {
        ...f.expected,
        settlementOutcome: "not_settled",
      }),
    );
  });
