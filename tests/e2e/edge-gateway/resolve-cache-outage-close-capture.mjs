import assert from "node:assert/strict";
import { cleanupInventory, loadSpanKey } from "./resolve-cache-load-close.mjs";
import { tag, traceTopology } from "../observability/trace-tree.mjs";

function rootOf(row) {
  let root = row.span;
  while (row.tree.parent(root)) root = row.tree.parent(root);
  return root;
}

function requireClosedReceipts(closes, deletions) {
  for (const close of closes) {
    if (tag(close.span, "antnest.ui.acp.close.outcome") !== "closed") continue;
    assert.equal(
      deletions.filter(
        (row) =>
          row.trace.traceID === close.trace.traceID &&
          rootOf(row).spanID === close.span.spanID,
      ).length,
      1,
      "closed owner requires one complete DELETE receipt",
    );
  }
}

const snapshot = (traces) =>
  traces
    .toSorted((a, b) => a.traceID.localeCompare(b.traceID))
    .map((trace) => ({
      ...trace,
      spans: trace.spans.toSorted((a, b) => a.spanID.localeCompare(b.spanID)),
    }));

// Capture and owning admission share the complete inventory, not a set derived
// only from whatever the independent queries happened to find.
export function inspectOutageCloseInventory(
  searches,
  traces,
  archivedTraceIDs = new Set(traces.keys()),
) {
  assert.equal(searches.errors.length, 0, "independent cleanup search failed");
  for (const [id, trace] of traces) {
    assert.equal(id, trace.traceID, "cleanup archive key differs");
    assert(archivedTraceIDs.has(id), "cleanup source not archived");
  }
  const inventory = {};
  for (const [name, kind] of [
    ["close", "close"],
    ["deletion", "delete"],
  ]) {
    const found = searches.found[name],
      rounds = searches.rounds?.[name];
    assert(Array.isArray(found), `independent ${name} inventory missing`);
    assert(
      Array.isArray(rounds) && rounds.length >= 3,
      `three stable ${name} snapshots required`,
    );
    const final = snapshot(found);
    for (const round of [...rounds.slice(-3), found]) {
      assert(
        Array.isArray(round) && round.length < 500,
        "cleanup Trace search saturated or missing",
      );
      assert.equal(
        new Set(round.map((trace) => trace.traceID)).size,
        round.length,
        "duplicate cleanup search Trace",
      );
      for (const trace of round) traceTopology(trace);
      assert.deepEqual(
        snapshot(round),
        final,
        `cleanup ${name} raw snapshots did not converge`,
      );
    }
    for (const trace of found) {
      assert(
        cleanupInventory([trace], kind).length > 0,
        "cleanup search result lacks its requested receiver",
      );
      const raw = traces.get(trace.traceID);
      assert(
        raw && archivedTraceIDs.has(trace.traceID),
        "cleanup raw Trace was not archived",
      );
      assert.deepEqual(
        snapshot([trace]),
        snapshot([raw]),
        "cleanup search raw Trace differs from archive",
      );
    }
    const actual = cleanupInventory([...traces.values()], kind),
      searched = cleanupInventory(found, kind);
    assert.deepEqual(
      searched.map((row) => loadSpanKey(row.trace, row.span)).sort(),
      actual.map((row) => loadSpanKey(row.trace, row.span)).sort(),
      `independent ${name} inventory differs from complete archive`,
    );
    inventory[kind] = actual;
  }
  return inventory;
}

// A diagnostic capture preserves failed cleanup as well as successful cleanup.
// It does not apply the normal-stop/DELETE-202 owning admission policy.
export async function searchOutageCloseTraces(base, options) {
  const { search, wait, signal, now, lookback, retainID } = options;
  const found = { close: [], deletion: [] },
    rounds = { close: [], deletion: [] };
  const errors = [];
  for (const [name, service, operation, tags] of [
    ["close", "agent-ui", "agent_ui.acp.close", {}],
    [
      "deletion",
      "agent-acp-service",
      "HTTP DELETE /v1/acp",
      {
        "span.kind": "server",
        "http.request.method": "DELETE",
        "http.route": "/v1/acp",
        "antnest.listener": "workspace",
      },
    ],
  ]) {
    const query = new URLSearchParams({
      service,
      operation,
      lookback,
      limit: "500",
      tags: JSON.stringify(tags),
    });
    let previous,
      stable = 0,
      complete = false,
      lastError;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        signal.throwIfAborted();
        found[name] = await search(base, query, {
          now,
          signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
        });
      } catch (error) {
        lastError = error;
        break;
      }
      rounds[name].push(found[name]);
      try {
        assert(Array.isArray(found[name]), "cleanup search inventory missing");
        for (const trace of found[name]) {
          retainID(trace.traceID);
          for (const span of trace.spans ?? [])
            if (span.operationName === "agent_ui.acp.close")
              for (const link of span.references ?? [])
                if (link.refType === "FOLLOWS_FROM") retainID(link.traceID);
        }
        assert(found[name].length < 500, "cleanup Trace search saturated");
        assert.equal(
          new Set(found[name].map((trace) => trace.traceID)).size,
          found[name].length,
          "duplicate cleanup search Trace",
        );
        if (name === "close")
          assert(found.close.length > 0, "actual owner close Trace missing");
        for (const trace of found[name]) traceTopology(trace);
        if (name === "deletion") {
          requireClosedReceipts(
            cleanupInventory(found.close, "close"),
            cleanupInventory(found.deletion, "delete"),
          );
        }
        const current = JSON.stringify(snapshot(found[name]));
        stable = current === previous ? stable + 1 : 1;
        previous = current;
        if (stable >= 3) {
          complete = true;
          break;
        }
        lastError = new Error("cleanup Trace search has not converged");
      } catch (error) {
        lastError = error;
        stable = 0;
        previous = undefined;
      }
      if (attempt + 1 < 20) {
        try {
          await wait(1000, undefined, { signal });
        } catch (error) {
          lastError = error;
          break;
        }
      }
    }
    if (!complete)
      errors.push(lastError ?? new Error(`${name} cleanup search incomplete`));
  }
  return { found, rounds, errors };
}

export function inspectOutageCloseCapture(searches, traces) {
  const inventory = inspectOutageCloseInventory(searches, traces);
  assert(inventory.close.length > 0, "actual owner close Trace missing");
  requireClosedReceipts(inventory.close, inventory.delete);
  const sources = [];
  for (const row of inventory.close) {
    assert.equal(
      row.tree.parent(row.span),
      undefined,
      "cleanup close is not an independent root",
    );
    const links = row.span.references ?? [];
    assert(
      links.length === 1 &&
        links[0].refType === "FOLLOWS_FROM" &&
        /^[a-f0-9]{32}$/u.test(links[0].traceID ?? "") &&
        /^[a-f0-9]{16}$/u.test(links[0].spanID ?? ""),
      "cleanup initialization Link missing or invalid",
    );
    const source = traces.get(links[0].traceID);
    assert(source, "cleanup initialization source was not archived");
    const tree = traceTopology(source),
      target = tree.spans.get(links[0].spanID);
    assert(
      target &&
        tree.service(target) === "agent-ui" &&
        target.operationName === "agent_ui.http.request" &&
        tag(target, "span.kind") === "server",
      "cleanup Link does not identify its exact UI initialization receiver",
    );
    sources.push({
      close: loadSpanKey(row.trace, row.span),
      trace_id: source.traceID,
      span_id: target.spanID,
    });
  }
  for (const row of inventory.delete) {
    assert.equal(tag(row.span, "span.kind"), "server");
    assert.equal(tag(row.span, "antnest.listener"), "workspace");
    const root = rootOf(row);
    assert(
      inventory.close.some(
        (close) =>
          close.trace.traceID === row.trace.traceID &&
          close.span.spanID === root.spanID,
      ),
      "DELETE lacks its actual close root",
    );
  }
  return {
    status: "captured_owning_admission_pending",
    close_span_ids: inventory.close.map((row) =>
      loadSpanKey(row.trace, row.span),
    ),
    delete_span_ids: inventory.delete.map((row) =>
      loadSpanKey(row.trace, row.span),
    ),
    initialization_sources: sources,
  };
}
