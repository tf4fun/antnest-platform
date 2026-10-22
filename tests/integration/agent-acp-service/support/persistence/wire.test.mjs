import assert from "node:assert/strict";
import { test } from "node:test";
import { Frames, Tracker, successfulResult } from "./wire.mjs";
const string = (s) => Buffer.from(s + "\0");
const short = (n) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};
const integer = (n) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
};
export const message = (type, body) =>
  Buffer.concat([Buffer.from(type), integer(body.length + 4), body]);
export const query = (sql) => message("Q", string(sql));
export const parse = (sql, name = "") =>
  message("P", Buffer.concat([string(name), string(sql), short(0)]));
export const bind = (values, name = "") =>
  message(
    "B",
    Buffer.concat([
      string(""),
      string(name),
      short(0),
      short(values.length),
      ...values.map((v) =>
        v === null
          ? integer(-1)
          : Buffer.concat([integer(Buffer.byteLength(v)), Buffer.from(v)]),
      ),
      short(0),
    ]),
  );
export const execute = () =>
  message("E", Buffer.concat([string(""), integer(0)]));
const framed = (b) => new Frames().push(b)[0];
const intent =
  "INSERT INTO runs(id,request_id,session_id) VALUES ($1,$2,$3) RETURNING id";
const accept =
  "UPDATE runs SET state = 'running', execution_snapshot = $2::jsonb WHERE id=$1";
const finish =
  "WITH finished AS (UPDATE runs SET state=$2 WHERE id=$1) SELECT id FROM finished";
test("wire framing preserves split/coalesced frames and validates startup and bounds", () => {
  const startup = Buffer.concat([integer(8), integer(196608)]),
    input = Buffer.concat([
      startup,
      query("BEGIN"),
      parse(intent),
      bind(["run", "request", "session"]),
    ]);
  const f = new Frames({ startup: true }),
    out = [];
  for (const b of input) out.push(...f.push(Buffer.from([b])));
  assert.deepEqual(Buffer.concat(out.map((x) => x.data)), input);
  assert.deepEqual(
    out.map((x) => x.type),
    ["startup", "Q", "P", "B"],
  );
  assert.throws(() =>
    new Frames().push(Buffer.concat([Buffer.from("Q"), integer(3)])),
  );
  assert.throws(() =>
    new Frames().push(
      Buffer.concat([Buffer.from("Q"), integer(40 * 1024 * 1024)]),
    ),
  );
  assert.throws(() =>
    new Frames({ startup: true }).push(
      Buffer.concat([integer(8), integer(80877103)]),
    ),
  );
});
test("intent/accept receipts require exact Session transaction and explicit COMMIT", () => {
  for (const phase of ["intent", "accept"]) {
    const t = new Tracker(() => ({ phase, session_id: "session" }));
    const send = (b) => t.observe(framed(b));
    send(query("BEGIN"));
    send(parse("SELECT state FROM acp_sessions WHERE id=$1 FOR UPDATE"));
    send(bind(["session"]));
    send(execute());
    send(parse(phase === "intent" ? intent : accept));
    assert.equal(
      send(
        bind(
          phase === "intent"
            ? ["run", "request", "session"]
            : ["run", "PRIVATE_SNAPSHOT"],
        ),
      ),
      undefined,
    );
    send(execute());
    const result = send(query("COMMIT"));
    assert.equal(result.phase, phase);
    assert.equal(result.session_id, "session");
    assert.equal(result.run_id, "run");
    assert.equal(result.command_tag, "COMMIT");
    assert(!JSON.stringify(result).includes("PRIVATE"));
    send(query("BEGIN"));
    assert.equal(
      send(query("COMMIT")),
      undefined,
      "transaction selection leaked",
    );
  }
});
test("foreign scope, rollback, unexecuted binds and unrelated SQL cannot target a commit", () => {
  for (const change of ["foreign", "rollback", "unexecuted", "unrelated"]) {
    const t = new Tracker(() => ({ phase: "intent", session_id: "session" })),
      send = (b) => t.observe(framed(b));
    send(query("BEGIN"));
    send(parse(intent));
    send(
      bind(["run", "request", change === "foreign" ? "foreign" : "session"]),
    );
    if (change !== "unexecuted") send(execute());
    if (change === "rollback") send(query("ROLLBACK"));
    if (change === "unexecuted") send(parse("SELECT 1"));
    if (change === "unrelated") {
      send(query("ROLLBACK"));
      send(query("BEGIN"));
      send(parse("INSERT INTO elsewhere VALUES ($1)"));
      send(bind(["session"]));
    }
    assert.equal(send(query("COMMIT")), undefined);
  }
});
test("completion selects exact Run and requires a successful auto-commit result", () => {
  const t = new Tracker(() => ({
      phase: "finish",
      session_id: "session",
      run_id: "run",
    })),
    send = (b) => t.observe(framed(b));
  send(parse(finish));
  assert.equal(send(bind(["foreign", "completed"])), undefined);
  send(parse(finish));
  send(bind(["run", "completed"]));
  const r = send(execute());
  assert.equal(r.run_id, "run");
  assert.equal(r.command_tag, "SELECT 1");
  const success = [
    framed(message("C", string("SELECT 1"))),
    framed(message("Z", Buffer.from("I"))),
  ];
  assert.equal(successfulResult(success, r), true);
  for (const frames of [
    [...success, framed(message("E", string("failure")))],
    [framed(message("C", string("SELECT 0"))), success[1]],
    [success[0], framed(message("Z", Buffer.from("T")))],
  ])
    assert.equal(successfulResult(frames, r), false);
});

function explicitFinishTransaction({
  sessionId = "session",
  runId = "run",
  lockSession = true,
  rollback = false,
} = {}) {
  const tracker = new Tracker(() => ({
    phase: "finish",
    session_id: "session",
    run_id: "run",
  }));
  const send = (frame) => tracker.observe(framed(frame));
  const statement = (sql, values) => {
    assert.equal(send(parse(sql)), undefined);
    assert.equal(send(bind(values)), undefined);
    assert.equal(
      send(execute()),
      undefined,
      "a statement cannot acknowledge the transaction",
    );
  };

  // These frontend frames select the production transaction. Backend COMMIT
  // and idle ReadyForQuery frames separately prove whether it committed.
  assert.equal(send(query("BEGIN")), undefined);
  statement(
    "SELECT session.organization_id, run.session_id FROM runs run JOIN acp_sessions session ON session.id=run.session_id WHERE run.id=$1",
    [runId],
  );
  statement("SELECT pg_advisory_xact_lock($1::integer, hashtext($2::text))", [
    String(0x41425243),
    "organization",
  ]);
  if (lockSession)
    statement("SELECT id FROM acp_sessions WHERE id=$1 FOR UPDATE", [
      sessionId,
    ]);
  statement(finish, [runId, "completed"]);
  statement(
    "INSERT INTO runtime_barrier_cycles (barrier_id, organization_id, agent_id, runtime_revision, runtime_execution_id) VALUES ($1,$2,$3,$4,$5)",
    [
      "barrier",
      "organization",
      "agent",
      "runtime-revision",
      "runtime-execution",
    ],
  );
  if (rollback) assert.equal(send(query("ROLLBACK")), undefined);
  return { receipt: send(query("COMMIT")), send };
}

test("explicit finish selects only the exact Session and Run at successful COMMIT", () => {
  const { receipt, send } = explicitFinishTransaction();
  assert(receipt, "explicit finish must select its COMMIT response");
  assert.equal(receipt.phase, "finish");
  assert.equal(receipt.session_id, "session");
  assert.equal(receipt.run_id, "run");
  assert.equal(receipt.command_tag, "COMMIT");
  assert.match(receipt.query_hash, /^[a-f0-9]{64}$/);

  const committed = framed(message("C", string("COMMIT")));
  const idle = framed(message("Z", Buffer.from("I")));
  assert.equal(successfulResult([committed, idle], receipt), true);
  for (const frames of [
    [framed(message("C", string("ROLLBACK"))), idle],
    [framed(message("E", string("commit failed"))), idle],
    [committed, framed(message("Z", Buffer.from("T")))],
    [framed(message("C", string("SELECT 1"))), idle],
    [committed],
  ])
    assert.equal(successfulResult(frames, receipt), false);

  assert.equal(send(query("BEGIN")), undefined);
  assert.equal(
    send(query("COMMIT")),
    undefined,
    "finish selection cannot leak into a later transaction",
  );
});

for (const [name, options] of [
  ["a different Session", { sessionId: "foreign" }],
  ["no Session lock", { lockSession: false }],
  ["a different Run", { runId: "foreign" }],
  ["a rolled-back transaction", { rollback: true }],
])
  test(`explicit finish rejects ${name}`, () => {
    assert.equal(explicitFinishTransaction(options).receipt, undefined);
  });
