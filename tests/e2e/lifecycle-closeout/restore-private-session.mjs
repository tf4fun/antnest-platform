import assert from "node:assert/strict";
import { inspect } from "node:util";

export function assertRestoreOwner(
  principal,
  creationPrincipal,
  initial,
  agentID,
) {
  const [organization, administrator] = JSON.parse(
    decodeURIComponent(creationPrincipal),
  );
  for (const value of [organization, administrator, principal.user_id, agentID])
    assert(typeof value === "string" && value.length > 0);
  assert.equal(principal.organization_id, organization);
  assert.equal(principal.user_id, initial.owner_user_id);
  assert.equal(initial.agent_id, agentID);
}

export function recordRestoreFailures(result, errors) {
  if (!Object.hasOwn(result, "restoreErrors"))
    Object.defineProperty(result, "restoreErrors", { value: [] });
  result.restoreErrors.push(...errors);
  result.private_collection_errors = [...new Set(result.restoreErrors)].map(
    (error) => inspect(error, { depth: 8 }),
  );
  return result;
}

export function restoreFailures(errors) {
  const unique = [...new Set(errors)];
  if (unique.length === 1) throw unique[0];
  if (unique.length)
    throw new AggregateError(
      unique,
      "Restore business, evidence or cleanup failed",
    );
}

export async function closeRestoreConnections(clients, errors) {
  for (const client of clients) {
    try {
      await client.closeAndWait();
    } catch (error) {
      errors.push(error);
    }
  }
}

export async function collectRestoreTraces(
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
