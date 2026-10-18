import assert from "node:assert/strict";
import { inspect } from "node:util";

export function recordNetworkFailures(result, errors) {
  if (!Object.hasOwn(result, "networkErrors"))
    Object.defineProperty(result, "networkErrors", { value: [] });
  result.networkErrors.push(...errors);
  result.private_collection_errors = [...new Set(result.networkErrors)].map(
    (error) => inspect(error, { depth: 8 }),
  );
  return result;
}

export function networkFailures(errors) {
  const unique = [...new Set(errors)];
  if (unique.length === 1) throw unique[0];
  if (unique.length)
    throw new AggregateError(
      unique,
      "Network business, evidence or cleanup failed",
    );
}

export async function afterNetworkRequestsClosed(sessions, errors, collect) {
  try {
    await sessions.closeAndWait(errors);
  } catch (error) {
    errors.push(error);
  }
  return collect();
}

export async function closeNetworkConnection(client, errors) {
  try {
    await client.closeAndWait();
  } catch (error) {
    errors.push(error);
  }
}

export function assertNetworkOwner(principal, creationPrincipal, agent) {
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

export async function networkPromptResult(probe, signal) {
  const result = await probe.promise,
    errors = [];
  if (Object.hasOwn(result, "error")) errors.push(result.error);
  if (signal?.aborted) errors.push(signal.reason);
  networkFailures(errors);
  return result.value;
}

export function createNetworkSessions({
  access,
  owner,
  principal,
  creationPrincipal,
  signal,
}) {
  const clients = [],
    probes = [];
  let closing;
  return {
    probes,
    async start(agent, input) {
      assert(!closing, "Network sessions are closing");
      signal?.throwIfAborted();
      assertNetworkOwner(principal, creationPrincipal, agent);
      // The private opener already owns the one initialization. Keep the
      // connection even when session/new fails so independent cleanup joins it.
      const client = await access.open(agent.id, owner, principal);
      clients.push(client);
      const sessionId = (
        await client.request(
          "new",
          { cwd: "/workspace", mcpServers: [] },
          15000,
          { phase: input.phase },
        )
      ).sessionId;
      const probe = {
        agent,
        input: structuredClone(input),
        client,
        sessionId,
        settled: false,
      };
      probe.promise = client
        .request(
          "prompt",
          {
            sessionId,
            prompt: [{ type: "text", text: JSON.stringify(input) }],
          },
          65000,
          { kind: "ordinary", phase: input.phase, toolName: "bash" },
        )
        .then(
          (value) => {
            probe.settled = true;
            return { value };
          },
          (error) => {
            probe.settled = true;
            return { error };
          },
        );
      probes.push(probe);
      return probe;
    },
    held(phase, first, second) {
      assert(["before-deny", "after-stale-cas"].includes(phase));
      assert.deepEqual(
        [first.input.phase, second.input.phase],
        ["held-a", "held-b"],
      );
      assert.notEqual(first.agent.id, second.agent.id);
      const receipt = [first, second].map((probe) => {
        assert(probes.includes(probe));
        assert.equal(
          probe.settled,
          false,
          "Network held Prompt already settled",
        );
        const snapshot = probe.client.snapshot();
        assert.equal(snapshot.closed, false);
        const prompts = snapshot.evidence.filter(
          (r) => r.method === "session/prompt",
        );
        assert.equal(prompts.length, 1);
        assert.equal(prompts[0].outcome, undefined);
        return {
          phase: probe.input.phase,
          agent_id: probe.agent.id,
          session_id: probe.sessionId,
          connection_trace_id: snapshot.connectionTraceID,
          settled: false,
        };
      });
      assert.notEqual(
        receipt[0].connection_trace_id,
        receipt[1].connection_trace_id,
      );
      return { phase, probes: receipt };
    },
    closeAndWait(errors) {
      return (closing ??= (async () => {
        for (const client of clients) {
          await closeNetworkConnection(client, errors);
        }
        for (const probe of probes) {
          const result = await probe.promise;
          if (Object.hasOwn(result, "error")) errors.push(result.error);
        }
        if (signal?.aborted) errors.push(signal.reason);
      })());
    },
  };
}

// Return failed entries as well as preserving the actual exceptions. A sibling
// request/policy/lifecycle failure must not suppress independent collection.
export async function collectNetworkTraces(
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
        request_id: row.requestID,
        agent_id: row.agentID,
        kind: row.kind,
        topology: "failed",
        strict_trace: "failed",
      });
    }
  }
  if (signal?.aborted) errors.push(signal.reason);
  return results;
}
