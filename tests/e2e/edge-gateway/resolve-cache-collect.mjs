import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import { inspectLoadOwnerDrain } from "./resolve-cache-owner-drain.mjs";
import { cleanupInventory } from "./resolve-cache-load-close.mjs";

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
    ownerLifecycle,
    ownerScope,
    write = writeEvidenceFile,
  } = {},
) {
  const requests = inspectLoadWire(wire);
  inspectLoadOwnerDrain(wire, ownerLifecycle);
  directory = evidenceDirectory(directory);
  assert(directory, "durable load archive required");
  assert(Number.isSafeInteger(attempts) && attempts >= 3);
  // All measured HTTP bodies have completed. Allow bounded outstanding
  // refresh work (<=5s) and the standard 5s exporter batch before searching.
  // Owner stream closure must also be supplied by the owning Docker flow;
  // three stable snapshots do not make a still-running private stream complete.
  await wait(settleMS, undefined, { signal });
  let previous,
    stable = 0,
    lastError;
  let convergence = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    signal?.throwIfAborted();
    const found = {};
    const failures = [];
    let attemptError;
    const queryEnd = Date.now();
    try {
      for (const [name, service, operation, tags] of [
        ["gateway", "edge-gateway", "HTTP POST identity-service"],
        [
          "identity",
          "identity-service",
          undefined,
          { "rpc.method": "resolve_access_token", "span.kind": "server" },
        ],
        ["refresh", "edge-gateway", "gateway.identity.resolve.refresh"],
        ["close", "agent-ui", "agent_ui.acp.close"],
        [
          "delete",
          "agent-acp-service",
          "HTTP DELETE /v1/acp",
          {
            "span.kind": "server",
            "http.request.method": "DELETE",
            "http.route": "/v1/acp",
            "antnest.listener": "workspace",
          },
        ],
        [
          "health",
          "agent-acp-service",
          "HTTP GET /status",
          {
            "span.kind": "server",
            "http.request.method": "GET",
            "http.route": "/status",
            "antnest.listener": "control",
          },
        ],
      ]) {
        signal?.throwIfAborted();
        const query = new URLSearchParams({
          service,
          limit: String(limit),
          lookback: "1h",
          ...(operation ? { operation } : {}),
          ...(tags ? { tags: JSON.stringify(tags) } : {}),
        });
        try {
          found[name] = await search(base, query, {
            fetchImpl: request,
            now: queryEnd,
            signal: signal
              ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
              : AbortSignal.timeout(30000),
          });
          assert(
            Array.isArray(found[name]) && found[name].length < limit,
            "load Trace search saturated",
          );
        } catch (error) {
          signal?.throwIfAborted();
          failures.push({ source: name, error });
        }
      }
      found.http = [];
      for (const row of requests) {
        signal?.throwIfAborted();
        try {
          let response, raw;
          try {
            response = await request(
              `${base.replace(/\/$/u, "")}/api/traces/${row.trace_id}`,
              {
                signal: signal
                  ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
                  : AbortSignal.timeout(10000),
              },
            );
            raw = await response.text();
          } catch {
            signal?.throwIfAborted();
            throw new Error("actual HTTP Trace query failed");
          }
          write(directory, `http-query-${attempt}-${row.trace_id}.json`, raw);
          signal?.throwIfAborted();
          assert.equal(response.status, 200, "actual HTTP Trace not exported");
          let body;
          try {
            body = JSON.parse(raw);
          } catch {
            throw new Error("Jaeger returned invalid HTTP Trace JSON");
          }
          assert(
            body && typeof body === "object",
            "Jaeger HTTP Trace envelope missing",
          );
          assert(
            body.errors == null ||
              (Array.isArray(body.errors) && body.errors.length === 0),
            "Jaeger backend errors require review",
          );
          assert(
            Array.isArray(body.data) && body.data.length === 1 && body.data[0],
            "actual HTTP Trace missing",
          );
          assert.equal(
            body.data[0].traceID,
            row.trace_id,
            "wrong actual HTTP Trace",
          );
          found.http.push(body.data[0]);
        } catch (error) {
          signal?.throwIfAborted();
          failures.push({ source: row.trace_id, error });
        }
      }
      // A failed independent query prevents admission, but cannot erase the
      // remaining available inventories or any of the 100 known HTTP sources.
      if (failures.length) throw failures[0].error;
      const all = new Map();
      for (const trace of Object.values(found).flat()) {
        // An unclassified CLIENT/SERVER fragment may be a late refresh from
        // this load. It cannot be dismissed as unrelated without its
        // complete parent chain, even when all HTTP request traces look complete.
        traceTopology(trace);
        all.set(trace.traceID, trace);
      }
      const selected = new Map(
        found.http.map((trace) => [trace.traceID, trace]),
      );
      const causal = new Set(selected.keys());
      const first = selected.get(requests[0].trace_id);
      const initialUI = first.spans.filter(
        (span) =>
          first.processes[span.processID]?.serviceName === "agent-ui" &&
          span.operationName === "agent_ui.http.request" &&
          tag(span, "span.kind") === "server",
      );
      assert.equal(
        initialUI.length,
        1,
        "actual initialization UI receiver missing or duplicate",
      );
      for (const row of cleanupInventory([...all.values()], "close")) {
        // An unlinked or malformed close cannot be declared unrelated. Select
        // every measured-trace link here; the inspector then requires the exact
        // first UI span, so an extra wrong link cannot disappear from inventory.
        assert.equal(
          row.tree.parent(row.span),
          undefined,
          "cleanup close is not a root",
        );
        const references = row.span.references ?? [];
        assert(
          references.length === 1 &&
            references[0].refType === "FOLLOWS_FROM" &&
            /^[a-f0-9]{32}$/u.test(references[0].traceID ?? "") &&
            typeof references[0].spanID === "string" &&
            references[0].spanID.length > 0,
          "cleanup close has no unambiguous source Link",
        );
        if (causal.has(references[0].traceID))
          selected.set(row.trace.traceID, row.trace);
      }
      for (const row of cleanupInventory([...all.values()], "delete")) {
        const parent = row.tree.parent(row.span);
        assert(
          parent &&
            row.tree.service(parent) === "agent-ui" &&
            parent.operationName === "agent_ui.acp.close" &&
            !row.tree.parent(parent),
          "unclassified independent ACP DELETE source",
        );
      }
      for (const trace of found.health) selected.set(trace.traceID, trace);
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
      Object.assign(collection, {
        ownerLifecycle,
        ownerScope,
        cleanupSearches: {
          close: found.close,
          delete: found.delete,
          health: found.health,
        },
      });
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
      const snapshot = {
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
      };
      const current = JSON.stringify(snapshot);
      stable = current === previous ? stable + 1 : 1;
      if (current !== previous) convergence = [];
      convergence.push({
        attempt,
        snapshot_sha256: createHash("sha256").update(current).digest("hex"),
        archived_trace_ids: [...collection.archivedTraceIDs].sort(),
        causal_query_ids: snapshot.queries,
      });
      previous = current;
      if (stable >= 3) {
        const complete = { ...checked, convergence: convergence.slice(-3) };
        write(directory, "load.json", JSON.stringify(complete, null, 2));
        return complete;
      }
      lastError = new Error("load Trace searches have not converged");
    } catch (error) {
      attemptError = signal?.aborted ? signal.reason : error;
      lastError = attemptError;
      previous = undefined;
      stable = 0;
      convergence = [];
      if (signal?.aborted) throw attemptError;
    } finally {
      const archiveErrors = [];
      const save = (name, raw) => {
        try {
          write(directory, name, raw);
        } catch (error) {
          archiveErrors.push(error);
        }
      };
      save(`search-${attempt}.json`, JSON.stringify(found));
      if (failures.length)
        save(
          `search-failures-${attempt}.private.json`,
          JSON.stringify(
            failures.map(({ source, error }) => ({
              source,
              message: error.message,
            })),
          ),
        );
      if (archiveErrors.length) {
        const originals = [
          ...new Set([
            ...failures.map((row) => row.error),
            ...(attemptError ? [attemptError] : []),
          ]),
        ];
        throw new AggregateError(
          [...originals, ...archiveErrors],
          "load collection and archive failed",
        );
      }
    }
    if (attempt < attempts) await wait(1000, undefined, { signal });
  }
  throw lastError;
}
