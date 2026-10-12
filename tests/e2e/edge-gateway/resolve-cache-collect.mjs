import assert from "node:assert/strict";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { searchJaegerTraces } from "../../support/jaeger-search.mjs";
import {
  writeEvidenceFile,
  evidenceDirectory,
} from "../../support/storage.mjs";
import { collectResolutionSources } from "../../support/gateway-resolution-collect.mjs";
import { tag, traceTopology } from "../observability/trace-tree.mjs";
import { inspectLoadWire, inspectResolveLoad } from "./resolve-cache-load.mjs";

const limit = 500;
const canonical = (trace) =>
  JSON.stringify({
    ...trace,
    spans: trace.spans.toSorted((a, b) => a.spanID.localeCompare(b.spanID)),
  });

export async function collectResolveLoad(
  base,
  wire,
  agentID,
  settings,
  secrets,
  {
    directory,
    signal,
    request = fetch,
    search = searchJaegerTraces,
    wait = delay,
    attempts = 40,
    settleMS = 12000,
  } = {},
) {
  inspectLoadWire(wire);
  directory = evidenceDirectory(directory);
  assert(directory, "durable load archive required");
  assert(Number.isSafeInteger(attempts) && attempts >= 3);
  // The connection is already closed and joined. Allow bounded outstanding
  // refresh work (<=5s) and the standard 5s exporter batch before searching;
  // then require the entire search set AND raw closure to converge together.
  await wait(settleMS, undefined, { signal });
  let previous,
    stable = 0,
    lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    signal?.throwIfAborted();
    const found = {};
    try {
      for (const [name, service, operation, tags] of [
        ["list", "edge-gateway", "acp session/list"],
        ["initialize", "edge-gateway", "acp initialize"],
        ["gateway", "edge-gateway", "HTTP POST identity-service"],
        [
          "identity",
          "identity-service",
          undefined,
          { "rpc.method": "resolve_access_token", "span.kind": "server" },
        ],
        ["refresh", "edge-gateway", "gateway.identity.resolve.refresh"],
      ]) {
        const query = new URLSearchParams({
          service,
          limit: String(limit),
          lookback: "1h",
          ...(operation ? { operation } : {}),
          ...(tags ? { tags: JSON.stringify(tags) } : {}),
        });
        found[name] = await search(base, query, {
          fetchImpl: request,
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
            : AbortSignal.timeout(30000),
        });
        assert(
          Array.isArray(found[name]) && found[name].length < limit,
          "load Trace search saturated",
        );
      }
      const response = await request(
        `${base.replace(/\/$/u, "")}/api/traces/${wire.upgrade.trace_id}`,
        {
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
            : AbortSignal.timeout(10000),
        },
      );
      assert.equal(response.status, 200, "upgrade Trace not exported");
      const body = await response.json();
      writeEvidenceFile(
        directory,
        `connection-query-${attempt}.json`,
        JSON.stringify(body),
      );
      assert(
        body.errors == null ||
          (Array.isArray(body.errors) && body.errors.length === 0),
        "Jaeger backend errors require review",
      );
      assert(
        Array.isArray(body.data) && body.data.length === 1,
        "upgrade Trace missing",
      );
      assert.equal(body.data[0].traceID, wire.upgrade.trace_id);
      found.connection = body.data;
      const all = new Map();
      for (const trace of Object.values(found).flat()) {
        // An unclassified CLIENT/SERVER fragment may be a late refresh from
        // this connection. It cannot be dismissed as unrelated without its
        // complete parent chain, even when the selected messages look complete.
        traceTopology(trace);
        all.set(trace.traceID, trace);
      }
      const selected = new Map([[wire.upgrade.trace_id, body.data[0]]]);
      for (const trace of [...found.list, ...found.initialize]) {
        const tree = traceTopology(trace);
        const root = trace.spans.find((span) => !tree.parent(span));
        if (
          root?.references.some(
            (ref) =>
              ref.refType === "FOLLOWS_FROM" &&
              ref.traceID === wire.upgrade.trace_id,
          )
        )
          selected.set(trace.traceID, trace);
      }
      const causal = new Set(selected.keys());
      for (const trace of all.values()) {
        const root = trace.spans.find(
          (span) =>
            span.operationName === "gateway.identity.resolve.refresh" &&
            trace.processes[span.processID]?.serviceName === "edge-gateway" &&
            !(span.references ?? []).some((ref) => ref.refType === "CHILD_OF"),
        );
        if (
          root?.operationName === "gateway.identity.resolve.refresh" &&
          root.references.some(
            (ref) => ref.refType === "FOLLOWS_FROM" && causal.has(ref.traceID),
          )
        )
          selected.set(trace.traceID, trace);
      }
      for (const trace of Object.values(found).flat())
        if (selected.has(trace.traceID))
          assert.equal(
            canonical(trace),
            canonical(selected.get(trace.traceID)),
            "raw search snapshot changed during collection",
          );
      const collection = await collectResolutionSources(
        base,
        [...selected.values()],
        {
          request,
          signal,
          directory: join(directory, "traces"),
          maxTraces: limit,
        },
      );
      const checked = inspectResolveLoad(
        wire,
        agentID,
        settings,
        collection,
        secrets,
      );
      const inventory = (rows, owner, select) =>
        new Set(
          rows.flatMap((trace) => {
            return trace.spans
              .filter(
                (span) =>
                  trace.processes[span.processID]?.serviceName === owner &&
                  select(span),
              )
              .map((span) => `${trace.traceID}:${span.spanID}`);
          }),
        );
      const gateway = inventory(
        found.gateway,
        "edge-gateway",
        (span) =>
          tag(span, "span.kind") === "client" &&
          tag(span, "http.request.method") === "POST" &&
          span.operationName === "HTTP POST identity-service",
      );
      const identity = inventory(
        found.identity,
        "identity-service",
        (span) =>
          tag(span, "span.kind") === "server" &&
          tag(span, "http.route") === "/rpc/identity/resolve-access-token",
      );
      assert(
        checked.gateway_clients.every((id) => gateway.has(id)),
        "independent Gateway search missing actual attempts",
      );
      assert(
        checked.identity_servers.every((id) => identity.has(id)),
        "independent Identity search missing actual receipts",
      );
      const inScope = (ids) =>
        [...ids].filter((id) => collection.traces.has(id.split(":")[0])).sort();
      assert.deepEqual(
        inScope(gateway),
        [...checked.gateway_clients].sort(),
        "unaccounted independent Gateway attempt",
      );
      assert.deepEqual(
        inScope(identity),
        [...checked.identity_servers].sort(),
        "unaccounted independent Identity receipt",
      );
      const current = JSON.stringify({
        // Global feed polls continue throughout collection. Their raw query
        // results remain archived, but only the measured causal scope must
        // stabilize; including unrelated feed IDs would never converge.
        queries: Object.fromEntries(
          Object.entries(found).map(([name, rows]) => [
            name,
            rows
              .filter((row) => collection.traces.has(row.traceID))
              .map((row) => row.traceID)
              .sort(),
          ]),
        ),
        closure: [...collection.traces.values()]
          .toSorted((a, b) => a.traceID.localeCompare(b.traceID))
          .map(canonical),
      });
      stable = current === previous ? stable + 1 : 1;
      previous = current;
      if (stable >= 3) {
        writeEvidenceFile(
          directory,
          "load.json",
          JSON.stringify(checked, null, 2),
        );
        return checked;
      }
      lastError = new Error("load Trace searches have not converged");
    } catch (error) {
      signal?.throwIfAborted();
      lastError = error;
      previous = undefined;
      stable = 0;
    } finally {
      writeEvidenceFile(
        directory,
        `search-${attempt}.json`,
        JSON.stringify(found),
      );
    }
    if (attempt < attempts) await wait(1000, undefined, { signal });
  }
  throw lastError;
}
