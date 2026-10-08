import assert from "node:assert/strict";

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

// A learned source stays active and acknowledged at its sequence. When it is
// not, the failure carries every related projection and its managed Skill
// state, which tells a withdrawn source from a delivery still in flight.
export async function assertSourceActive({ sql, agentId, sequence, agentIds }) {
  assert(Number.isSafeInteger(sequence) && sequence > 0);
  const related = [...new Set([agentId, ...agentIds])];
  for (const id of related) assert.match(id, agentPattern);
  const count = await sql(
    `SELECT count(*) FROM skill_source_projections WHERE agent_id='${agentId}' AND active AND sequence=${sequence} AND sent_sequence=${sequence}`,
  );
  if (count === "1") return;
  let rows;
  try {
    rows = JSON.parse(await sql(projectionRows(related)));
  } catch (error) {
    rows = `unavailable: ${error.message}`;
  }
  assert.fail(
    `actual managed source must remain active and acknowledged: ${agentId} sequence ${sequence} matched ${count}; projections ${JSON.stringify(rows)}`,
  );
}
