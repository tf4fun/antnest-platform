import { createRequire } from "node:module";
import { context, propagation, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { node, tracing } from "@opentelemetry/sdk-node";
import type { Pool } from "pg";
import type * as pgTypes from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresKernel } from "../../src/adapters/postgres/kernel.js";
import { createPostgresInstrumentation, PostgresSpanNames } from "../../src/telemetry/postgres.js";
import { ServiceTelemetry } from "../../src/telemetry/telemetry.js";

const url = process.env.ANTNEST_ACP_TEST_DATABASE_URL;

describe.skipIf(url === undefined)("PostgreSQL driver trace contract", () => {
  const exporter = new tracing.InMemorySpanExporter();
  const provider = new node.NodeTracerProvider({
    spanProcessors: [new PostgresSpanNames(), new tracing.SimpleSpanProcessor(exporter)],
  });
  const tracer = provider.getTracer("postgres-contract");
  const instrumentation = createPostgresInstrumentation();
  let pool: Pool;
  let kernel: PostgresKernel;

  beforeAll(() => {
    provider.register();
    instrumentation.setTracerProvider(provider);
    // Match production startup: enable instrumentation before loading the driver.
    const pg = createRequire(import.meta.url)("pg") as typeof pgTypes;
    pool = new pg.Pool({ connectionString: url, max: 2 });
    kernel = new PostgresKernel(pool, new ServiceTelemetry("postgres-contract"));
  });
  beforeEach(() => exporter.reset());
  afterAll(async () => {
    await pool.end();
    instrumentation.disable();
    await provider.shutdown();
    trace.disable();
    context.disable();
    propagation.disable();
  });

  async function request<T>(operation: () => Promise<T>): Promise<T> {
    return tracer.startActiveSpan("request", async (span) => {
      try {
        return await operation();
      } finally {
        span.end();
      }
    });
  }

  function sqlSpans() {
    return exporter.getFinishedSpans().filter((span) => span.kind === SpanKind.CLIENT);
  }

  function assertNoPrivateValues() {
    const data = JSON.stringify(
      exporter.getFinishedSpans().map((span) => ({
        name: span.name,
        attributes: span.attributes,
        events: span.events,
        status: span.status,
      })),
    );
    expect(data).not.toContain("bind-value-canary");
    expect(data).not.toContain("pg-pool.connect");
    expect(data).not.toContain("postgres.query");
    expect(data).not.toContain("db.query.parameter");
  }

  it("records each actual query once, with native SQL metadata and no values or rows", async () => {
    await request(async () => {
      await kernel.query("SELECT $1::text AS value", ["bind-value-canary"]);
      await kernel.read("SELECT $1::int AS value", [2], new AbortController().signal);
      await pool.query("SELECT 1");
    });
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(4);
    expect(sqlSpans().map((span) => span.name)).toEqual(["SELECT", "SELECT", "SELECT"]);
    const root = spans.find((span) => span.name === "request")!;
    for (const span of sqlSpans()) {
      expect(span.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
      expect(span.attributes).toMatchObject({
        "db.system.name": "postgresql",
        "db.operation.name": "SELECT",
        "db.namespace": "antnest_agent_acp_test",
        "server.address": "127.0.0.1",
      });
      expect(span.attributes["server.port"]).toEqual(expect.any(Number));
    }
    expect(sqlSpans()[0]!.attributes["db.query.text"]).toBe("SELECT $1::text AS value");
    assertNoPrivateValues();
  });

  it("wraps BEGIN, statements and COMMIT in one INTERNAL transaction", async () => {
    await request(() =>
      kernel.transaction(async (client) => {
        await client.query("SELECT $1::text", ["bind-value-canary"]);
        await client.query("SELECT 2");
      }),
    );
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(6);
    const transaction = spans.find((span) => span.name === "postgresql transaction")!;
    const root = spans.find((span) => span.name === "request")!;
    expect(transaction.kind).toBe(SpanKind.INTERNAL);
    expect(transaction.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    expect(transaction.attributes["antnest.transaction.outcome"]).toBe("committed");
    expect(sqlSpans().map((span) => span.name)).toEqual(["BEGIN", "SELECT", "SELECT", "COMMIT"]);
    for (const span of sqlSpans()) {
      expect(span.parentSpanContext?.spanId).toBe(transaction.spanContext().spanId);
    }
    assertNoPrivateValues();
  });

  it("uses structured command results for prepared queries and batches without extra spans", async () => {
    await request(async () => {
      await pool.query({
        name: "trace_prepared",
        text: "SELECT $1::text",
        values: ["bind-value-canary"],
      });
      await pool.query({
        name: "trace_prepared",
        text: "SELECT $1::text",
        values: ["bind-value-canary"],
      });
      await pool.query("SELECT 1; SELECT 2");
    });
    expect(sqlSpans().map((span) => span.name)).toEqual(["SELECT", "SELECT", "BATCH"]);
    expect(exporter.getFinishedSpans()).toHaveLength(4);
    assertNoPrivateValues();
  });

  it("retains failed SQL and a confirmed rollback without changing the error", async () => {
    await expect(
      request(() => kernel.transaction((client) => client.query("SELECT 1 / 0"))),
    ).rejects.toMatchObject({ code: "22012" });
    const transaction = exporter
      .getFinishedSpans()
      .find((span) => span.name === "postgresql transaction")!;
    expect(transaction.attributes["antnest.transaction.outcome"]).toBe("rolled_back");
    expect(transaction.status.code).toBe(SpanStatusCode.ERROR);
    expect(sqlSpans().map((span) => span.name)).toEqual(["BEGIN", "SELECT", "ROLLBACK"]);
    expect(sqlSpans()[1]!.status.code).toBe(SpanStatusCode.ERROR);
    expect(sqlSpans()[1]!.attributes["error.type"]).toBeDefined();
    expect(
      sqlSpans().every(
        (span) => span.parentSpanContext?.spanId === transaction.spanContext().spanId,
      ),
    ).toBe(true);
  });

  it("does not mark a rejected COMMIT as committed after cleanup", async () => {
    await expect(
      request(() =>
        kernel.transaction(async (client) => {
          await client.query(
            "CREATE TEMP TABLE trace_unique (id int UNIQUE DEFERRABLE INITIALLY DEFERRED) ON COMMIT DROP",
          );
          await client.query("INSERT INTO trace_unique VALUES (1), (1)");
        }),
      ),
    ).rejects.toMatchObject({ code: "23505" });
    const transaction = exporter
      .getFinishedSpans()
      .find((span) => span.name === "postgresql transaction")!;
    expect(transaction.attributes["antnest.transaction.outcome"]).toBe("failed");
    expect(transaction.status.code).toBe(SpanStatusCode.ERROR);
    expect(sqlSpans().find((span) => span.name === "COMMIT")!.status.code).toBe(
      SpanStatusCode.ERROR,
    );
  });

  it("reports PostgreSQL's implicit rollback rather than a false commit", async () => {
    await request(() =>
      kernel.transaction(async (client) => {
        await expect(client.query("SELECT 1 / 0")).rejects.toMatchObject({ code: "22012" });
      }),
    );
    const transaction = exporter
      .getFinishedSpans()
      .find((span) => span.name === "postgresql transaction")!;
    expect(transaction.attributes["antnest.transaction.outcome"]).toBe("rolled_back");
    expect(sqlSpans().map((span) => span.name)).toEqual(["BEGIN", "SELECT", "ROLLBACK"]);
  });

  it("does not turn a multiline failed query into a high-cardinality title", async () => {
    await expect(request(() => kernel.query("SELECT\n1 / 0"))).rejects.toMatchObject({
      code: "22012",
    });
    expect(sqlSpans()).toHaveLength(1);
    expect(sqlSpans()[0]!.name).toBe("QUERY");
    expect(sqlSpans()[0]!.attributes["db.query.text"]).toBe("SELECT\n1 / 0");
    expect(sqlSpans()[0]!.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("isolates concurrent transaction parents and releases the same pool cleanly", async () => {
    await request(() =>
      Promise.all(
        [1, 2].map((value) =>
          kernel.transaction((client) => client.query("SELECT $1::int", [value])),
        ),
      ),
    );
    const transactions = exporter
      .getFinishedSpans()
      .filter((span) => span.name === "postgresql transaction");
    expect(transactions).toHaveLength(2);
    for (const transaction of transactions) {
      expect(
        sqlSpans()
          .filter((span) => span.parentSpanContext?.spanId === transaction.spanContext().spanId)
          .map((span) => span.name),
      ).toEqual(["BEGIN", "SELECT", "COMMIT"]);
    }
    expect(pool.waitingCount).toBe(0);
  });

  it("does not invent a database query for a pre-cancelled read", async () => {
    const reason = new DOMException("cancelled", "AbortError");
    await expect(
      request(() => kernel.read("SELECT 1", [], AbortSignal.abort(reason))),
    ).rejects.toBe(reason);
    expect(sqlSpans()).toHaveLength(0);
  });
});
