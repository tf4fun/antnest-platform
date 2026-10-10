import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const agentPattern = /^agent_[a-z0-9]+$/u;

const projectionRows = (
  agentIds,
) => `SELECT coalesce(json_agg(r ORDER BY r.agent_id,r.name),'[]'::json) FROM (
  SELECT p.agent_id,p.name,p.sequence,p.sent_sequence,p.active,p.failures,p.candidate_id,
    p.content_digest,p.next_attempt_at,p.updated_at,
    m.state AS managed_state,m.origin AS managed_origin,
    m.last_candidate_id AS managed_candidate_id,m.last_digest AS managed_digest
  FROM skill_source_projections p
  LEFT JOIN learning_managed_skills m ON m.organization_id=p.organization_id
    AND m.agent_id=p.agent_id AND m.package_path='.antnest/skills/' || p.name
  WHERE p.agent_id IN (${agentIds.map((id) => `'${id}'`).join(",")})) r`;

const managedSource = (rows, agentId, sequence) => {
  if (!Array.isArray(rows)) return null;
  const sources = rows.filter((row) => row?.agent_id === agentId);
  if (sources.length !== 1) return null;
  const source = sources[0];
  return source.active === true &&
    source.sequence === sequence &&
    Number.isSafeInteger(source.sent_sequence) &&
    source.sent_sequence >= 0 &&
    source.sent_sequence <= sequence &&
    source.managed_state === "active" &&
    source.managed_origin === "auto_generated" &&
    typeof source.candidate_id === "string" &&
    source.candidate_id.length > 0 &&
    source.candidate_id === source.managed_candidate_id &&
    typeof source.content_digest === "string" &&
    source.content_digest.length > 0 &&
    source.content_digest === source.managed_digest
    ? source
    : null;
};

// A learned source stays active and acknowledged at its sequence. When it is
// not, the failure carries every related projection and its managed Skill
// state, which tells a withdrawn source from a delivery still in flight.
export async function assertSourceActive({
  sql,
  agentId,
  sequence,
  agentIds,
  waitForAck = false,
  signal,
  timeoutMs = 90000,
  pollMs = 250,
}) {
  assert(Number.isSafeInteger(sequence) && sequence > 0);
  assert(Number.isInteger(timeoutMs) && timeoutMs > 0);
  assert(Number.isInteger(pollMs) && pollMs > 0);
  const related = [...new Set([agentId, ...agentIds])];
  for (const id of related) assert.match(id, agentPattern);
  const deadline = waitForAck ? Date.now() + timeoutMs : Infinity;
  let count;
  let rows;
  const fail = (reason = "") =>
    assert.fail(
      `actual managed source must remain active and acknowledged: ${agentId} sequence ${sequence} matched ${count}; projections ${JSON.stringify(rows)}${reason ? `; ${reason}` : ""}`,
    );
  const check = () => {
    signal?.throwIfAborted();
    if (Date.now() >= deadline) fail("ACK deadline exceeded");
  };
  for (;;) {
    check();
    count = await sql(
      `SELECT count(*) FROM skill_source_projections WHERE agent_id='${agentId}' AND active AND sequence=${sequence} AND sent_sequence=${sequence}`,
    );
    check();
    if (count === "1") return;
    try {
      rows = JSON.parse(await sql(projectionRows(related)));
    } catch (error) {
      signal?.throwIfAborted();
      rows = `unavailable: ${error.message}`;
      fail();
    }
    check();
    if (!waitForAck || count !== "0") fail();
    const source = managedSource(rows, agentId, sequence);
    if (!source) fail();
    if (source.sent_sequence === sequence) return;
    check();
    await delay(Math.min(pollMs, deadline - Date.now()), undefined, { signal });
  }
}
