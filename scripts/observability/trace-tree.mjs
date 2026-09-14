import assert from "node:assert/strict";

export const tag = (span, key) =>
  span?.tags?.find((field) => field.key === key)?.value;

export function traceTree(trace) {
  const tree = traceTopology(trace);
  assert.equal(
    trace.warnings?.length ?? 0,
    0,
    "Jaeger trace warnings require review",
  );
  for (const span of trace.spans)
    assert.equal(
      span.warnings?.length ?? 0,
      0,
      "Jaeger span warnings require review",
    );
  return tree;
}

// Topology can be diagnosed independently; traceTree remains the strict gate.
export function traceTopology(trace) {
  assert(trace?.traceID && trace.spans?.length, "trace is missing");
  const spans = new Map(trace.spans.map((span) => [span.spanID, span]));
  assert.equal(spans.size, trace.spans.length, "duplicate span ID");
  const service = (span) => trace.processes?.[span.processID]?.serviceName;
  const parent = (span) => {
    const refs =
      span.references?.filter((ref) => ref.refType === "CHILD_OF") ?? [];
    assert(refs.length <= 1, "multiple synchronous parents");
    if (!refs.length) return undefined;
    assert.equal(refs[0].traceID, trace.traceID, "foreign parent trace");
    const result = spans.get(refs[0].spanID);
    assert(result, "missing synchronous parent");
    return result;
  };
  const chain = (span) => {
    const result = [];
    while (span) {
      assert(!result.includes(span), "cyclic trace ancestry");
      result.push(span);
      span = parent(span);
    }
    return result;
  };
  for (const span of trace.spans) {
    assert.equal(span.traceID, trace.traceID, "foreign span trace");
    assert(service(span), "unknown span service");
    assert(
      !/^(identity|agent_controller|runtime)\.repository\./u.test(
        span.operationName,
      ) && tag(span, "antnest.repository.operation") === undefined,
      "removed Repository wrapper remains in trace",
    );
    chain(span);
  }
  return { spans, service, parent, chain };
}

function driverOperation(span) {
  const operation = tag(span, "db.operation.name");
  return (
    typeof operation === "string" &&
    /^[A-Z]+$/u.test(operation) &&
    span.operationName === operation
  );
}

export function databaseChildren(trace, server) {
  const { service, chain } = traceTree(trace);
  assert.equal(tag(server, "span.kind"), "server", "DB owner must be SERVER");
  const children = trace.spans.filter((span) => {
    if (tag(span, "db.system.name") !== "postgresql") return false;
    assert(
      !["acquire", "pool.acquire"].includes(span.operationName) &&
        tag(span, "pgx.prepare_stmt.name") === undefined,
      "prepare/pool acquisition adds database execution noise",
    );
    const fields = [
      ...(span.tags ?? []),
      ...(span.logs ?? []).flatMap((event) => event.fields ?? []),
    ];
    for (const field of fields)
      assert(
        !["pgx.query.parameters", "db.connection_string"].includes(field.key) &&
          !/^db\.(query\.parameters?|query\.results?|statement\.parameters)(\.|$)/u.test(
            field.key,
          ),
        "SQL parameters/results or connection string captured",
      );
    // Connection observations do not prove SQL execution.
    if (tag(span, "db.query.text") === undefined) return false;
    const owner = chain(span)
      .slice(1)
      .find((item) => tag(item, "span.kind") === "server");
    if (service(span) === service(server))
      assert(owner, "DB CLIENT detached from owning SERVER");
    return owner === server;
  });
  assert(children.length > 0, "owning SERVER has zero PostgreSQL spans");
  for (const span of children) {
    const lineage = chain(span);
    const driverChain = lineage.slice(0, lineage.indexOf(server));
    for (const driver of driverChain) {
      assert.equal(
        service(driver),
        service(server),
        "foreign service DB child",
      );
      const transaction =
        driver.operationName === "postgresql transaction" &&
        tag(driver, "span.kind") === "internal" &&
        tag(driver, "db.system.name") === "postgresql";
      if (transaction) {
        assert(
          driver !== span && driverChain.at(-1) === driver,
          "transaction must directly belong to its SERVER",
        );
        assert(
          Number.isFinite(driver.duration) && driver.duration >= 0,
          "unfinished transaction span",
        );
        continue;
      }
      assert.equal(
        tag(driver, "span.kind"),
        "client",
        "DB span must be CLIENT",
      );
      assert.equal(
        tag(driver, "db.system.name"),
        "postgresql",
        "non-driver wrapper between DB and owning SERVER",
      );
      assert(
        driverOperation(driver) ||
          (driver !== span &&
            ["batch start", "connect"].includes(driver.operationName)),
        "DB ancestry must contain only low-cardinality driver operations",
      );
      assert(
        Number.isFinite(driver.duration) && driver.duration >= 0,
        "unfinished DB span",
      );
    }
    assert.equal(
      typeof tag(span, "db.query.text"),
      "string",
      "DB query text missing",
    );
    assert(tag(span, "db.query.text").trim(), "empty DB query text");
  }
  return children;
}

export function owningServer(trace, expected) {
  const { service, parent } = traceTree(trace);
  assert(
    expected.route && expected.method,
    "owning SERVER route/method required",
  );
  const matches = trace.spans.filter(
    (span) =>
      service(span) === expected.service &&
      tag(span, "http.route") === expected.route &&
      tag(span, "http.request.method") === expected.method,
  );
  assert.equal(matches.length, 1, "missing/duplicate owning SERVER request");
  const server = matches[0];
  assert.equal(
    tag(server, "span.kind"),
    "server",
    "owning request must be SERVER",
  );
  if (expected.rpcMethod !== undefined)
    assert.equal(
      tag(server, "rpc.method"),
      expected.rpcMethod,
      "wrong owning RPC method",
    );
  const client = parent(server);
  assert(
    client && tag(client, "span.kind") === "client",
    "SERVER must have direct CLIENT parent",
  );
  assert.equal(
    tag(client, "http.request.method"),
    expected.method,
    "wrong CLIENT HTTP method",
  );
  if (expected.clientService)
    assert.equal(
      service(client),
      expected.clientService,
      "wrong RPC client service",
    );
  if (expected.clientSpanID)
    assert.equal(
      client.spanID,
      expected.clientSpanID,
      "wrong RPC client parent",
    );
  if (expected.status !== undefined)
    assert.equal(tag(server, "http.response.status_code"), expected.status);
  const database = databaseChildren(trace, server);
  return { server, client, database };
}

// These closeout fixtures run with RPC content capture disabled, not in raw-content development mode.
export function assertCaptureDisabled(trace) {
  for (const span of trace.spans)
    for (const event of span.logs ?? [])
      assert(
        !event.fields?.some((field) => field.key === "antnest.payload.json"),
        "capture=false fixture exported RPC content",
      );
}
