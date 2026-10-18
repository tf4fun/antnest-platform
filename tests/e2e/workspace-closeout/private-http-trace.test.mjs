import assert from "node:assert/strict";
import test from "node:test";
import { inspect as describe } from "node:util";
import { workspaceStateTraceFixture as fixture } from "./private-http-trace.fixture.mjs";

const implementation = await import("./private-http-trace.mjs").catch(
  (error) => {
    if (
      error.code !== "ERR_MODULE_NOT_FOUND" ||
      !error.message.includes("/workspace-closeout/private-http-trace.mjs")
    )
      throw error;
    return {};
  },
);
const inspect = (f) => {
  assert.equal(typeof implementation.inspectWorkspaceStateTrace, "function");
  return implementation.inspectWorkspaceStateTrace(f.trace, f.expected, [
    "workspace-private-http-secret",
  ]);
};
for (const [kind, mode, errors] of [
  ["private_state", "local-close", 0],
  ["private_state_watch", "local-close", 1],
  ["private_state_watch", "revocation", 0],
])
  test(`Workspace ${kind}/${mode} proves actual CLIENT, readiness and original private receipt`, () => {
    const f = fixture(kind, mode),
      before = structuredClone({ trace: f.trace, expected: f.expected });
    const report = inspect(f);
    assert.equal(report.topology, "passed");
    assert.equal(report.diagnostic_inventory_verified, true);
    assert.equal(report.raw_error_inventory.length, errors);
    assert.equal(report.sql_spans, 2);
    assert.deepEqual(f.trace, before.trace);
    assert.deepEqual(f.expected, before.expected);
  });

for (const [name, mutate] of Object.entries({
  foreign_client: (f) => {
    f.expected.clientSpanID = "0".repeat(16);
  },
  foreign_agent: (f) => {
    f.expected.agentID = "foreign";
  },
  foreign_principal: (f) => {
    f.expected.principal = { organization_id: "other", user_id: "other" };
  },
  foreign_session: (f) => {
    f.expected.session_digest = "0".repeat(64);
  },
  conflicting_header: (f) => {
    f.receipt.response_trace_id = "0".repeat(32);
  },
  partial_body: (f) => {
    f.receipt.body_bytes--;
  },
  unjoined_reader: (f) => {
    f.receipt.joined = false;
  },
  reader_failure: (f) => {
    f.receipt.errors = ["reader failed"];
  },
  failed_state_status: (f) => {
    f.receipt.status = 503;
  },
  unowned_server_error: (f) => {
    f.set(f.server, "error", true);
  },
  failed_database: (f) => {
    f.set(f.sql, "error", true);
  },
  extra_sql: (f) => {
    f.trace.spans.push({
      ...structuredClone(f.sql),
      spanID: "extra-query",
      tags: f.sql.tags.map((field) =>
        field.key === "db.query.text"
          ? { ...field, value: "DELETE FROM runs" }
          : field,
      ),
    });
  },
  wrong_database: (f) => {
    f.set(f.sql, "db.namespace", "antnest_identity");
  },
  wrong_readiness_query: (f) => {
    f.set(f.readinessSQL, "db.query.text", "SELECT * FROM runs");
  },
  hidden_readiness_work: (f) => {
    f.trace.spans.push({
      ...structuredClone(f.readinessSQL),
      spanID: "extra-ready-query",
    });
  },
  missing_readiness: (f) => {
    f.trace.spans = f.trace.spans.filter((span) => span !== f.readinessSQL);
  },
  foreign_sql_parent: (f) => {
    f.sql.references[0].spanID = f.client.spanID;
  },
  detached_client: (f) => {
    f.server.references = [];
  },
  wrong_route: (f) => {
    f.set(f.server, "http.route", "/api/app/agents/agent/state");
  },
  payload_capture: (f) => {
    f.set(f.sql, "db.query.parameters", "private");
  },
  secret_capture: (f) => {
    f.set(f.client, "private", "workspace-private-http-secret");
  },
  body_capture: (f) => {
    f.set(f.client, "http.response.body", "private");
  },
}))
  test(`Workspace private state refuses ${name}`, () => {
    const f = fixture();
    mutate(f);
    assert.throws(() => inspect(f));
  });

test("private state retains the schema's nullable opaque configuration revision", () => {
  const f = fixture();
  const body = JSON.parse(Buffer.from(f.receipt.raw_body_base64, "base64"));
  Object.assign(body, {
    access_allowed: false,
    availability: "offline",
    configuration_revision: null,
    unavailable_reason: "access_denied",
  });
  const raw = Buffer.from(JSON.stringify(body));
  f.receipt.raw_body_base64 = raw.toString("base64");
  f.receipt.body_bytes = raw.length;
  f.set(f.client, "http.response.body.size", raw.length);
  assert.equal(inspect(f).topology, "passed");
});

for (const kind of ["private_state", "private_state_watch"])
  test(`${kind} ready state requires its actual Runtime protection query`, () => {
    const f = fixture(kind);
    f.trace.spans = f.trace.spans.filter((span) => span !== f.sql);
    assert.throws(() => inspect(f));
  });

for (const child of ["sql", "readiness", "readinessSQL"])
  test(`private state joins ${child} before its actual ACP parent ends`, () => {
    const f = fixture();
    f[child].startTime = f.server.startTime + f.server.duration + 1_000_000;
    assert.throws(() => inspect(f));
  });

test("private state mismatches do not expose the original body in diagnostics", () => {
  const f = fixture(),
    canary = "workspace-private-http-secret-canary";
  const body = JSON.parse(Buffer.from(f.receipt.raw_body_base64, "base64"));
  body.agent_id = canary;
  const raw = Buffer.from(JSON.stringify(body));
  f.receipt.raw_body_base64 = raw.toString("base64");
  f.receipt.body_bytes = raw.length;
  f.set(f.client, "http.response.body.size", raw.length);
  let failure;
  try {
    inspect(f);
  } catch (error) {
    failure = error;
  }
  assert(failure);
  assert(!describe(failure, { depth: 20 }).includes(canary));
});

for (const [name, mutate] of Object.entries({
  invented_shutdown: (f) => {
    f.set(f.server, "antnest.stream.termination", "process-shutdown");
  },
  extra_error_event: (f) => {
    f.server.logs.push({
      timestamp: f.server.startTime,
      fields: [{ key: "event", value: "antnest.error" }],
    });
  },
  wrong_cancellation: (f) => {
    f.set(f.server, "error.type", "unexpected_failure");
  },
  wrong_client_outcome: (f) => {
    f.set(f.client, "antnest.outcome", "eof");
  },
  no_original_error: (f) => {
    f.set(f.server, "error.type", undefined);
  },
}))
  test(`local watch cannot borrow ${name}`, () => {
    const f = fixture("private_state_watch");
    mutate(f);
    assert.throws(() => inspect(f));
  });

test("revocation requires original full denied state and remote EOF, without cancellation errors", () => {
  for (const mutate of [
    (f) => {
      f.receipt.closure.kind = "local-close";
    },
    (f) => {
      f.receipt.body_outcome = "cancelled";
    },
    (f) => {
      f.set(f.server, "error.type", "stream_interrupted");
    },
    (f) => {
      f.receipt.revocation_start.observedAt = 999;
    },
  ]) {
    const f = fixture("private_state_watch", "revocation");
    mutate(f);
    assert.throws(() => inspect(f));
  }
});
