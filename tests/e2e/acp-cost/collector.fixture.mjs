import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { costControlTraceFixture } from "./control-trace.fixture.mjs";

const tags = (object) =>
  Object.entries(object).map(([key, value]) => ({ key, value }));
export function costCollectorFixture(t, f) {
  const directory = mkdtempSync(join(tmpdir(), "antnest-cost-collector-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const expected = { ...f.expected },
    raw = new Map([[f.trace.traceID, f.trace]]);
  delete expected.connectionTrace;
  delete expected.connectionSpanID;
  if (f.connectionTrace) raw.set(f.connectionTrace.traceID, f.connectionTrace);
  for (const receipt of expected.httpConnection?.requests ?? []) {
    receipt.events = [
      { kind: "headers", monotonicMs: 2 },
      {
        kind: receipt.bodyOutcome === "cancelled" ? "cancel" : "eof",
        monotonicMs: 3,
      },
      { kind: "body_closed", monotonicMs: 4 },
    ];
    if (receipt.traceID === f.trace.traceID) continue;
    if (receipt.rpcMethod === "initialize") {
      const init = costControlTraceFixture({ http: true });
      init.trace.traceID = receipt.traceID;
      for (const span of init.trace.spans) {
        span.traceID = receipt.traceID;
        for (const ref of span.references) ref.traceID = receipt.traceID;
      }
      init.set(init.request, "antnest.request.id", String(receipt.requestID));
      raw.set(receipt.traceID, init.trace);
      continue;
    }
    const client = {
      ...structuredClone(f.client),
      traceID: receipt.traceID,
      operationName: `HTTP ${receipt.method} agent-acp-workspace`,
      tags: tags({
        "span.kind": "client",
        "http.request.method": receipt.method,
        "http.response.status_code": receipt.status,
        "http.response.body.size": receipt.bytes,
        "antnest.outcome": receipt.bodyOutcome,
        "antnest.http.body.outcome": receipt.bodyOutcome,
      }),
    };
    const receiver = {
      ...structuredClone(f.receiver),
      traceID: receipt.traceID,
      operationName: `HTTP ${receipt.method} /v1/acp`,
      references: [
        {
          refType: "CHILD_OF",
          traceID: receipt.traceID,
          spanID: client.spanID,
        },
      ],
      tags: tags({
        "span.kind": "server",
        "http.request.method": receipt.method,
        "http.route": "/v1/acp",
        "antnest.listener": "workspace",
        "http.response.status_code": receipt.status,
        ...(receipt.method === "GET"
          ? {
              "antnest.outcome": "disconnected",
              "error.type": "stream_interrupted",
              "otel.status_code": "ERROR",
              error: true,
            }
          : {}),
      }),
    };
    const ready = {
      ...structuredClone(receiver),
      spanID: "8".repeat(16),
      operationName: "postgres.ready",
      references: [
        {
          refType: "CHILD_OF",
          traceID: receipt.traceID,
          spanID: receiver.spanID,
        },
      ],
      tags: tags({ "span.kind": "internal", "db.system.name": "postgresql" }),
    };
    const sql = {
      ...structuredClone(ready),
      spanID: "9".repeat(16),
      operationName: "SELECT",
      references: [
        { refType: "CHILD_OF", traceID: receipt.traceID, spanID: ready.spanID },
      ],
      tags: tags({
        "span.kind": "client",
        "db.system.name": "postgresql",
        "db.namespace": "antnest_agent_acp",
        "db.operation.name": "SELECT",
        "db.query.text": "SELECT 1",
      }),
    };
    raw.set(receipt.traceID, {
      traceID: receipt.traceID,
      processes: structuredClone(f.trace.processes),
      spans: [client, receiver, ready, sql],
    });
  }
  const normalizedIDs = new Map();
  const normalizeSpanID = (value) => {
    assert.equal(typeof value, "string");
    if (/^[a-f0-9]{16}$/u.test(value)) return value;
    if (!normalizedIDs.has(value))
      normalizedIDs.set(
        value,
        createHash("sha256").update(value).digest("hex").slice(0, 16),
      );
    return normalizedIDs.get(value);
  };
  for (const trace of raw.values()) {
    const originals = new Map();
    for (const span of trace.spans) {
      const normalized = normalizeSpanID(span.spanID);
      if (originals.has(normalized))
        assert.equal(
          originals.get(normalized),
          span.spanID,
          "Cost fixture Span ID normalization collision",
        );
      else originals.set(normalized, span.spanID);
    }
    for (const span of trace.spans) {
      span.spanID = normalizeSpanID(span.spanID);
      for (const reference of span.references)
        reference.spanID = normalizeSpanID(reference.spanID);
      for (const fields of [
        span.tags ?? [],
        ...(span.logs ?? []).map((event) => event.fields ?? []),
      ])
        for (const field of fields)
          if (["antnest.error.origin_span_id", "span_id"].includes(field.key))
            field.value = normalizeSpanID(field.value);
    }
  }
  for (const key of ["clientSpanID", "connectionSpanID"])
    if (expected[key] !== undefined)
      expected[key] = normalizeSpanID(expected[key]);
  for (const receipt of expected.httpConnection?.requests ?? [])
    if (receipt.clientSpanID !== undefined)
      receipt.clientSpanID = normalizeSpanID(receipt.clientSpanID);
  for (const request of f.requests ?? [])
    if (request.model_span_id !== undefined)
      request.model_span_id = normalizeSpanID(request.model_span_id);
  let flushed = false;
  return {
    ...f,
    ...(typeof f.query === "function"
      ? { query: (id) => f.query(normalizeSpanID(id)) }
      : {}),
    expected,
    directory,
    raw,
    options: {
      directory,
      attempts: 3,
      wait: async () => {},
      flush: async () => {
        flushed = true;
      },
      secrets: ["PRIVATE_COLLECTOR_CANARY"],
      requests: f.requests ?? [],
      request: async (address, { signal }) => {
        assert(flushed);
        assert(signal instanceof AbortSignal);
        const path = new URL(address).pathname;
        if (path === "/api/v3/trace-summaries")
          return Response.json({ summaries: [{ traceId: f.trace.traceID }] });
        const id = path.split("/").at(-1);
        assert(raw.has(id), "unexpected collector query");
        return Response.json({ data: [raw.get(id)] });
      },
    },
  };
}
