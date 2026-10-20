import assert from "node:assert/strict";
import { inspect } from "node:util";
import { assertLossDenial } from "./loss-evidence.mjs";

export async function expectLossDenial(request) {
  try {
    await request();
  } catch (error) {
    try {
      assertLossDenial(error);
    } catch {
      throw error;
    }
    return;
  }
  assert.fail("expected semantic agent_unavailable refusal");
}

export function assertLossOwner(principal, creationPrincipal, agent) {
  const [organization, administrator] = JSON.parse(
    decodeURIComponent(creationPrincipal),
  );
  for (const value of [
    organization,
    administrator,
    principal.user_id,
    agent.id,
  ])
    assert(typeof value === "string" && value.length > 0);
  assert.equal(principal.organization_id, organization);
  assert.equal(principal.user_id, agent.initial.agent.owner_user_id);
  assert.equal(agent.initial.agent.agent_id, agent.id);
}
export function recordLossFailures(result, errors) {
  if (!Object.hasOwn(result, "lossErrors"))
    Object.defineProperty(result, "lossErrors", { value: [] });
  result.lossErrors.push(...errors);
  result.private_collection_errors = [...new Set(result.lossErrors)].map(
    (error) => inspect(error, { depth: 8 }),
  );
  return result;
}
export function lossFailures(errors) {
  const unique = [...new Set(errors)];
  if (unique.length === 1) throw unique[0];
  if (unique.length)
    throw new AggregateError(
      unique,
      "Loss business, evidence or cleanup failed",
    );
}
export async function closeLossConnections(clients, errors) {
  for (const client of clients) {
    try {
      await client.closeAndWait();
    } catch (error) {
      errors.push(error);
    }
  }
}
export async function collectLossTraces(
  rows,
  collect,
  preserve,
  signal,
  errors,
) {
  const results = [];
  for (const row of rows) {
    if (signal?.aborted) break;
    try {
      results.push({ ...(await collect(row)), topology: "passed" });
    } catch (error) {
      errors.push(error);
      try {
        await preserve(row, error);
      } catch (archiveError) {
        errors.push(archiveError);
      }
      results.push({
        trace_id: row.traceID,
        request_id: row.requestID ?? row.requestId,
        agent_id: row.agentID ?? row.agentId,
        kind: row.kind,
        topology: "failed",
        strict_trace: "failed",
      });
    }
  }
  if (signal?.aborted) errors.push(signal.reason);
  return results;
}
