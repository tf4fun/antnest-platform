import assert from "node:assert/strict";
import {
  resolveTraceSources,
  resolveTraceDiagnostics,
} from "../../support/gateway-resolution-evidence.mjs";
import { hasError } from "../acp-plan/requests.mjs";
import {
  tag,
  traceTopology,
  databaseChildrenTopology,
} from "../observability/trace-tree.mjs";

const one = (rows, message) => {
  assert.equal(rows.length, 1, message);
  return rows[0];
};
const end = (span) => {
  assert(
    Number.isFinite(span.startTime) &&
      Number.isFinite(span.duration) &&
      span.duration >= 0,
    "unfinished feed span",
  );
  return span.startTime + span.duration;
};
const values = (fields) => {
  const result = Object.fromEntries(fields.map((f) => [f.key, f.value]));
  assert.equal(
    Object.keys(result).length,
    fields.length,
    "duplicate feed field",
  );
  return result;
};
const errorKey =
  /^(error($|\.)|exception\.|db\.response\.status_code$|antnest\.(error\.|outcome$|result$|operation\.phase$|cancellation\.)|otel\.status_)/u;
const failures = {
  deadline_exceeded: {
    message: "Request deadline exceeded",
    causes: [
      ["context.deadlineExceededError"],
      ["*net.OpError", "*poll.DeadlineExceededError"],
      ["*net.OpError", "*net.timeoutError"],
      ["*net.OpError", "*net.DNSError", "*net.timeoutError"],
    ],
  },
  network_error: {
    message: "Network operation failed",
    causes: [
      ["*net.OpError", "*os.SyscallError", "syscall.Errno"],
      ["*net.OpError", "syscall.Errno"],
    ],
  },
  dns_error: {
    message: "Could not resolve the remote service",
    causes: [["*net.OpError", "*net.DNSError"]],
  },
};
function failedSend(client) {
  const type = tag(client, "error.type"),
    shape = failures[type];
  assert(shape, "unrelated feed transport failure");
  const tags = values(client.tags ?? []);
  const expected = {
    error: true,
    "error.type": type,
    "otel.status_code": "ERROR",
    "otel.status_description": shape.message,
  };
  for (const [key, value] of Object.entries(expected))
    assert.equal(tags[key], value, `missing or wrong feed ${key}`);
  for (const [key, value] of Object.entries(tags))
    if (errorKey.test(key)) {
      assert(Object.hasOwn(expected, key), "unrelated feed error metadata");
      assert.equal(value, expected[key]);
    }
  const event = one(client.logs ?? [], "one exact feed send error required");
  assert(
    Number.isFinite(event.timestamp) &&
      event.timestamp >= client.startTime &&
      event.timestamp <= end(client),
    "feed event outside owning span",
  );
  const fields = values(event.fields ?? []),
    causes = fields["antnest.error.cause_types"];
  assert(
    shape.causes.some((chain) => JSON.stringify(chain) === causes),
    "unrelated feed error cause",
  );
  assert.deepEqual(fields, {
    event: "antnest.error",
    "error.type": type,
    "antnest.error.stage": "send",
    "antnest.error.message": shape.message,
    "antnest.error.cause_types": causes,
  });
  return type;
}
function lifecycle(evidence) {
  const {
    before,
    stopped,
    stopped_end: stoppedEnd,
    after,
    healthy,
    stop_started_at: stopAt,
    stop_started_at_ms: stopMS,
    restart_started_at: restartAt,
    restart_started_at_ms: restartMS,
  } = evidence.identity;
  assert(typeof before.id === "string" && before.id.length > 0);
  for (const state of [before, stopped, stoppedEnd, after, healthy]) {
    assert.equal(state.id, before.id, "Identity container replaced");
    assert.equal(state.project, evidence.project, "wrong Identity project");
    assert.equal(state.service, "identity-service");
    assert.equal(state.restarting, false);
    assert.equal(state.oom_killed, false);
    assert.equal(state.exit_code, 0);
    assert(
      Number.isFinite(state.at) && Number.isSafeInteger(state.observed_at_ms),
    );
  }
  for (const state of [before, after, healthy])
    assert.equal(state.running, true);
  for (const state of [stopped, stoppedEnd]) {
    assert.equal(state.running, false);
    assert.equal(state.started_at, before.started_at);
    assert.equal(state.finished_at, stopped.finished_at);
  }
  assert.equal(before.health, "healthy");
  assert.equal(healthy.health, "healthy");
  assert.equal(after.started_at, healthy.started_at);
  assert.notEqual(after.started_at, before.started_at);
  assert.equal(after.finished_at, stopped.finished_at);
  assert.equal(healthy.finished_at, stopped.finished_at);
  assert(Number.isFinite(stopAt) && Number.isSafeInteger(stopMS));
  assert(Number.isFinite(restartAt) && Number.isSafeInteger(restartMS));
  assert(
    before.at <= stopAt &&
      stopAt <= stopped.at &&
      stoppedEnd.at >= stopped.at + 5000 &&
      restartAt >= stoppedEnd.at &&
      after.at >= restartAt &&
      healthy.at >= after.at,
  );
  const finished = Date.parse(stopped.finished_at),
    started = Date.parse(after.started_at);
  assert(Number.isFinite(finished) && Number.isFinite(started));
  assert(
    before.observed_at_ms <= stopMS &&
      stopMS <= finished &&
      finished <= stopped.observed_at_ms &&
      stopped.observed_at_ms <= stoppedEnd.observed_at_ms &&
      stoppedEnd.observed_at_ms <= restartMS &&
      restartMS <= started &&
      started <= after.observed_at_ms &&
      after.observed_at_ms <= healthy.observed_at_ms,
    "invalid Identity stop/restart observations",
  );
  return {
    before: before.observed_at_ms * 1000,
    stopping: stopMS * 1000,
    stopped: finished * 1000,
    restart: restartMS * 1000,
    started: started * 1000,
    healthy: healthy.observed_at_ms * 1000,
  };
}
function inventory(collection, all, window) {
  const search = collection.feedSearch;
  assert(
    search &&
      Number.isSafeInteger(search.now) &&
      search.now * 1000 >= window.healthy,
    "complete fixed feed search window required",
  );
  assert.match(search.lookback ?? "", /^[1-9][0-9]*ms$/u);
  const low = (search.now - Number.parseInt(search.lookback, 10)) * 1000,
    high = search.now * 1000;
  assert(low <= window.before && high >= window.healthy);
  const archived = collection.archivedTraceIDs;
  assert(
    archived instanceof Set && collection.feedAttemptTraceIDs instanceof Set,
  );
  const ids = (rows) => {
    assert(
      Array.isArray(rows) && rows.length < 500,
      "feed search saturated or missing",
    );
    const result = rows
      .map((row) => {
        assert.match(row.traceID ?? "", /^[a-f0-9]{32}$/u);
        assert(
          archived.has(row.traceID) && collection.traces.has(row.traceID),
          "search Trace not archived",
        );
        return row.traceID;
      })
      .sort();
    assert.equal(
      new Set(result).size,
      result.length,
      "duplicate feed search Trace",
    );
    return result;
  };
  const rounds = search.feed_attempt_searches;
  assert(
    Array.isArray(rounds) && rounds.length >= 3 && rounds.length <= 20,
    "three stable attempt searches required",
  );
  const checked = rounds.map(ids),
    last = checked.at(-1),
    servers = ids(search.found?.feed);
  assert(
    Array.isArray(search.feed_server_searches) &&
      search.feed_server_searches.length === rounds.length,
    "paired feed SERVER searches required",
  );
  const checkedServers = search.feed_server_searches.map(ids);
  assert(last.length > 0);
  for (let i = checked.length - 3; i < checked.length; i++) {
    const round = checked[i];
    assert.deepEqual(round, last, "feed attempt inventory did not converge");
    assert.deepEqual(
      checkedServers[i],
      servers,
      "feed SERVER inventory did not converge",
    );
    for (const id of servers)
      assert(round.includes(id), "feed SERVER omitted from CLIENT search");
  }
  assert.deepEqual(
    [...collection.feedAttemptTraceIDs].sort(),
    last,
    "wrong complete attempt inventory",
  );
  const matched = [],
    feeds = [];
  for (const trace of all) {
    const tree = traceTopology(trace);
    let matching = false;
    for (const span of trace.spans) {
      if (
        tree.service(span) !== "edge-gateway" ||
        tag(span, "span.kind") !== "client" ||
        tag(span, "http.request.method") !== "POST" ||
        tag(span, "server.address") !== "identity-service" ||
        span.operationName !== "HTTP POST identity-service" ||
        span.startTime < low ||
        span.startTime > high
      )
        continue;
      matching = true;
      const marked = tag(span, "rpc.method") === "list_session_revocations";
      if (!tree.parent(span) || marked) {
        assert(!tree.parent(span), "feed CLIENT must be process-owned");
        assert.equal(
          tag(span, "rpc.method"),
          "list_session_revocations",
          "unknown process-owned Identity attempt",
        );
        assert.equal(tag(span, "rpc.service"), "identity");
        assert.equal(tag(span, "rpc.system.name"), "antnest.http-json");
        const timeout = tag(span, "antnest.request.timeout_ms");
        assert(
          Number.isInteger(timeout) && timeout >= 0 && timeout <= 5000,
          "unbounded feed request",
        );
        for (const s of trace.spans) {
          assert(tree.chain(s).includes(span), "unrelated work in feed Trace");
          end(s);
        }
        feeds.push({ trace, tree, client: span });
      }
    }
    if (matching) {
      assert(archived.has(trace.traceID), "raw attempt not archived");
      matched.push(trace.traceID);
    }
  }
  assert.deepEqual(
    matched.sort(),
    last,
    "broad Gateway Identity inventory differs from raw CLIENTs",
  );
  feeds.sort((a, b) => a.client.startTime - b.client.startTime);
  assert(feeds.length > 0, "feed attempts missing");
  for (let i = 1; i < feeds.length; i++)
    assert(
      end(feeds[i - 1].client) <= feeds[i].client.startTime,
      "feed attempts are not serial",
    );
  return { feeds, servers, inventory_trace_count: last.length };
}
function successful({ trace, tree, client }) {
  assert.equal(tag(client, "http.response.status_code"), 200);
  const server = one(
    trace.spans.filter(
      (s) =>
        tree.service(s) === "identity-service" &&
        tag(s, "span.kind") === "server",
    ),
    "one feed receiver required",
  );
  for (const s of trace.spans) {
    const tags = values(s.tags ?? []);
    const expected =
      s === server
        ? { "antnest.outcome": "success", "antnest.result": "success" }
        : {};
    if (tags["otel.status_code"] === "OK") expected["otel.status_code"] = "OK";
    for (const [key, value] of Object.entries(expected))
      assert.equal(tags[key], value, "successful feed result missing");
    for (const [key, value] of Object.entries(tags))
      if (errorKey.test(key)) {
        assert(
          Object.hasOwn(expected, key),
          "unrelated successful feed diagnostic",
        );
        assert.equal(value, expected[key]);
      }
    assert(!hasError(s), "failed feed response or SQL");
    assert.equal(
      s.logs?.length ?? 0,
      0,
      "unexpected successful feed diagnostic event",
    );
  }
  assert.equal(tree.parent(server), client);
  assert.equal(tag(server, "http.response.status_code"), 200);
  assert.equal(tag(server, "http.request.method"), "POST");
  assert.equal(
    tag(server, "http.route"),
    "/rpc/identity/list-session-revocations",
  );
  assert.equal(tag(server, "rpc.method"), "list_session_revocations");
  const sql = one(
    databaseChildrenTopology(trace, server),
    "one feed SELECT required",
  );
  assert.equal(tree.parent(sql), server);
  assert.equal(sql.processID, server.processID);
  assert(
    sql.startTime >= server.startTime && end(sql) <= end(server),
    "feed SELECT outside owning SERVER lifetime",
  );
  assert.equal(tag(sql, "db.operation.name"), "SELECT");
  assert.equal(
    tag(sql, "db.query.text").replace(/\s+/gu, " ").trim(),
    "SELECT sequence, token_id, user_id, organization_id, reason, occurred_at, traceparent FROM session_revocations WHERE sequence > $1 ORDER BY sequence LIMIT $2",
  );
  assert(
    Number.isSafeInteger(tag(sql, "pgx.rows_affected")) &&
      tag(sql, "pgx.rows_affected") >= 0 &&
      tag(sql, "pgx.rows_affected") <= 500,
  );
  // A pool may establish a physical PostgreSQL connection for this read after
  // Identity restarts. It is a driver observation, not another SQL execution.
  for (const connect of trace.spans.filter(
    (s) => ![client, server, sql].includes(s),
  )) {
    assert.equal(
      connect.operationName,
      "connect",
      "unrelated work in successful feed",
    );
    assert.equal(tree.service(connect), "identity-service");
    assert.equal(connect.processID, server.processID);
    assert.equal(tree.parent(connect), server);
    assert.equal(tag(connect, "span.kind"), "client");
    assert.equal(tag(connect, "db.system.name"), "postgresql");
    assert.equal(tag(connect, "otel.scope.name"), "github.com/exaring/otelpgx");
    for (const key of [
      "db.query.text",
      "db.operation.name",
      "pgx.rows_affected",
    ])
      assert.equal(
        tag(connect, key),
        undefined,
        "connection cannot stand in for SQL",
      );
    for (const key of [
      "otel.scope.name",
      "otel.scope.version",
      "db.namespace",
      "server.address",
      "user.name",
    ]) {
      assert(
        typeof tag(connect, key) === "string" && tag(connect, key).length > 0,
        "connection database identity missing",
      );
      assert.equal(
        tag(connect, key),
        tag(sql, key),
        "connection belongs to another database",
      );
    }
    assert(
      Number.isSafeInteger(tag(connect, "server.port")) &&
        tag(connect, "server.port") > 0,
    );
    assert.equal(tag(connect, "server.port"), tag(sql, "server.port"));
    assert(
      connect.startTime >= server.startTime && end(connect) <= sql.startTime,
      "connection outside owning feed read",
    );
  }
}
export function inspectOutageFeed(evidence, collection, secrets = []) {
  const first = collection.traces.values().next().value;
  assert(first, "feed raw archive missing");
  const all = resolveTraceSources(first, secrets, collection);
  const window = lifecycle(evidence),
    found = inventory(collection, all, window);
  const passed = found.feeds.filter((f) => !hasError(f.client));
  passed.forEach(successful);
  assert.deepEqual(
    passed.map((f) => f.trace.traceID).sort(),
    found.servers,
    "successful feed SERVER inventory differs from raw receipts",
  );
  const resumed = passed.find((f) => f.client.startTime >= window.restart);
  assert(resumed, "actual successful feed after restart required");
  const ready = Math.min(window.healthy, resumed.client.startTime),
    owned = [],
    attempts = [];
  for (const f of found.feeds) {
    let phase = "successful";
    if (hasError(f.client)) {
      assert.equal(
        f.trace.spans.length,
        1,
        "failed feed has receiver or unrelated work",
      );
      assert.equal(
        tag(f.client, "http.response.status_code"),
        undefined,
        "failed send has a response",
      );
      failedSend(f.client);
      assert(
        f.client.startTime >= window.before,
        "feed failure predates controlled lifecycle",
      );
      const finished = end(f.client);
      // A graceful stop closes the listener before the container exits.
      // Attribute that interval to the observed stop invocation, not to an
      // arbitrary allowance around Docker's final exit timestamp.
      if (finished >= window.stopping && finished < window.stopped)
        phase = "stopping";
      else if (finished >= window.stopped && finished <= window.restart)
        phase = "stopped";
      else if (finished > window.restart && finished < ready)
        phase = "restart-not-ready";
      else
        assert.fail(
          "feed failure outside stopping, stopped or restart-not-ready boundary",
        );
      owned.push({
        trace_id: f.trace.traceID,
        span_id: f.client.spanID,
        reason: `identity-feed-${phase}`,
      });
    }
    attempts.push({
      trace_id: f.trace.traceID,
      client_span_id: f.client.spanID,
      phase,
    });
  }
  const successfulOutageRequests = [];
  if (
    !attempts.some(
      ({ phase }) => phase === "stopped" || phase === "restart-not-ready",
    )
  ) {
    // A stopping-only failure does not prove a stopped-period feed attempt.
    // A five-second outage can end before a feed's five-second deadline. Keep
    // its real successful receiver as evidence instead of inventing an error.
    for (const f of passed) {
      if (
        f.client.startTime < window.stopped ||
        f.client.startTime >= window.restart
      )
        continue;
      const server = f.trace.spans.find(
        (s) =>
          f.tree.service(s) === "identity-service" &&
          tag(s, "span.kind") === "server",
      );
      assert(
        tag(f.client, "antnest.request.timeout_ms") > 0,
        "successful outage feed budget missing",
      );
      assert(
        f.client.duration <= 5000000,
        "successful outage feed exceeded five seconds",
      );
      assert(
        end(f.client) > window.started &&
          server.startTime >= window.started &&
          server.startTime < end(f.client) &&
          end(server) <= end(f.client),
        "successful outage feed receiver outside restarted CLIENT lifetime",
      );
      successfulOutageRequests.push({
        trace_id: f.trace.traceID,
        client_span_id: f.client.spanID,
        identity_server_span_id: server.spanID,
        duration_ms: f.client.duration / 1000,
      });
    }
    assert(
      successfulOutageRequests.length > 0,
      "actual stopped-period feed attempt missing",
    );
  }
  return {
    status: "passed",
    attempts,
    inventory_trace_count: found.inventory_trace_count,
    owned_error_spans: owned,
    successful_outage_requests: successfulOutageRequests,
    ...resolveTraceDiagnostics(first, all),
  };
}
