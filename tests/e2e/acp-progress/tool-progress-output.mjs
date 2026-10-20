import assert from "node:assert/strict";
import { tag } from "../observability/trace-tree.mjs";
import {
  end,
  expected,
  runtimeToolEvidence,
} from "../observability/runtime-tool-evidence.mjs";
import { assertSessionSuccess } from "../identity-closeout/session-diagnostics.mjs";

const normalize = (query) => query.replace(/\s+/gu, " ").trim();
// These are statement texts, not parameter values. Binding is provided by the
// original same-process Tool/Run ancestry and the output Agent/Session tags.
const progressWrites = [
  "BEGIN",
  "SELECT session_id FROM runs WHERE id = $1",
  "SELECT last_message_sequence FROM acp_sessions WHERE id = $1 FOR UPDATE",
  "SELECT session_id, state FROM runs WHERE id = $1 FOR UPDATE",
  "SELECT id FROM tool_attempts WHERE run_id = $1 AND tool_call_id = $2 AND state = 'in_progress'",
  "INSERT INTO session_messages( id, session_id, run_id, sequence, kind, visible, payload, created_at ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)",
  "UPDATE acp_sessions SET last_message_sequence = $2, updated_at = $3 WHERE id = $1",
  "COMMIT",
];
const sessionRead =
  "SELECT id, organization_id, principal_id, agent_id, cwd, state, title, forked_from_session_id, client_mcp_revision_id, last_execution_revision, last_message_sequence, created_at, updated_at FROM acp_sessions WHERE id = $1";
const outputReads = [
  sessionRead,
  "SELECT s.last_message_sequence AS sequence, s.append_version, s.title, s.updated_at, COALESCE((SELECT jsonb_agg( CASE WHEN $3::boolean THEN jsonb_build_object( 'sequence', m.sequence, 'runId', m.run_id, 'messageId', m.id, 'payload', m.payload ) ELSE m.payload END ORDER BY m.sequence) FROM session_messages m WHERE m.session_id = s.id AND m.visible AND m.sequence > COALESCE($2::bigint, s.last_message_sequence)), '[]'::jsonb) AS events, r.state, r.stop_reason FROM acp_sessions s LEFT JOIN LATERAL (SELECT state, stop_reason FROM runs WHERE session_id = s.id ORDER BY created_at DESC, id DESC LIMIT 1) r ON true WHERE s.id = $1",
  sessionRead,
  "SELECT configuration, configuration_revision FROM acp_sessions WHERE id = $1 AND state <> 'deleted'",
];

// onProgress persists and publishes while the original MCP call context is
// active. These ACP branches must succeed even when the Tool itself fails.
// They never become part of the Tool's error/cancellation ownership set.
export function inspectToolProgressOutput(trace, owner, identity) {
  const ctx = runtimeToolEvidence(trace, owner, identity);
  const { tree, children, sameProcess, nodeBefore } = ctx;
  const spans = new Set();
  const branches = children(owner).filter((span) =>
    ["postgresql transaction", "acp.session.output"].includes(
      span.operationName,
    ),
  );
  if (branches.length) {
    assert(
      typeof identity.sessionId === "string" && identity.sessionId.length > 0,
    );
    const runs = tree
      .chain(owner)
      .filter((span) => span.operationName === "agent.run");
    assert.equal(runs.length, 1, "Progress output has no original Run");
    sameProcess(runs[0], owner, "agent-acp-service");
    expected(runs[0], { "antnest.session.id": identity.sessionId });
  }
  const check = (span, parent) => {
    sameProcess(span, parent, "agent-acp-service");
    assert(
      span.startTime >= parent.startTime,
      "Progress output precedes parent",
    );
    // Publication is asynchronous and finish() joins persistence after the
    // instrumented call has returned. Do not invent a Tool containment bound
    // or timing exemption. Original source warnings still fail strict review.
    if (parent !== owner)
      nodeBefore(
        span,
        parent,
        end(span),
        end(parent),
        "progress-output-sql-joined-by-parent",
      );
    assert.equal(span.logs?.length ?? 0, 0, "unexpected Progress output event");
    assertSessionSuccess(span);
    assert(
      !span.tags.some(({ key }) =>
        /^(rpc\.|mcp\.|http\.|executor\.|peer\.service$|antnest\.runtime\.)/u.test(
          key,
        ),
      ),
      "protocol work disguised as Progress output",
    );
    spans.add(span);
  };
  for (const branch of branches) {
    check(branch, owner);
    expected(branch, { "span.kind": "internal" });
    const transaction = branch.operationName === "postgresql transaction";
    if (transaction)
      expected(branch, {
        "db.system.name": "postgresql",
        "antnest.transaction.outcome": "committed",
      });
    else {
      expected(branch, {
        "antnest.agent.id": identity.agentId,
        "antnest.session.id": identity.sessionId,
        "antnest.operation.phase": "read",
        "antnest.outcome": "ok",
      });
      for (const [key, value] of [
        ["agent.id", identity.agentId],
        ["session.id", identity.sessionId],
      ])
        if (tag(branch, key) !== undefined) expected(branch, { [key]: value });
    }
    const queries = children(branch);
    const statements = queries.map((query) => {
      const sql = tag(query, "db.query.text");
      assert(typeof sql === "string", "missing original Progress SQL");
      return normalize(sql);
    });
    assert.deepEqual(
      statements.toSorted(),
      (transaction ? progressWrites : outputReads).toSorted(),
      "unexpected Progress SQL inventory",
    );
    const remaining = queries.toSorted((a, b) => a.startTime - b.startTime);
    const ordered = (transaction ? progressWrites : outputReads).map((sql) => {
      const index = remaining.findIndex(
        (query) => normalize(tag(query, "db.query.text")) === sql,
      );
      return remaining.splice(index, 1)[0];
    });
    // Statements are awaited sequentially. Compare their original start times,
    // allowing equal SDK millisecond timestamps and arbitrary Jaeger ordering.
    assert(
      ordered.every(
        (query, index) =>
          index === 0 || ordered[index - 1].startTime <= query.startTime,
      ),
      "Progress SQL execution starts out of order",
    );
    for (const query of queries) {
      check(query, branch);
      assert.equal(children(query).length, 0, "work nested below Progress SQL");
      assert(
        (transaction
          ? ["BEGIN", "SELECT", "INSERT", "UPDATE", "COMMIT"]
          : ["SELECT"]
        ).includes(query.operationName),
        "unexpected Progress database operation",
      );
      expected(query, {
        "span.kind": "client",
        "db.system.name": "postgresql",
        "db.namespace": "antnest_agent_acp",
        "db.operation.name": query.operationName,
      });
      const sql = tag(query, "db.query.text");
      assert(
        typeof sql === "string" &&
          sql.trim().split(/\s+/u)[0] === query.operationName,
        "missing original Progress SQL",
      );
    }
  }
  return { spans, timeObservations: ctx.timeObservations };
}
