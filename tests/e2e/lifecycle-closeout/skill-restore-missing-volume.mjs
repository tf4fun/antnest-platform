import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { inspect } from "node:util";

const preparationPath =
  "/api/admin/agent-skill-preparations/by-idempotency-key";

export async function requestMissingSkillEnable(
  { gateway, agentID, key, admin, signal },
  { request = fetch, timeout = AbortSignal.timeout } = {},
) {
  const receipt = {
    request: {
      agent_id: agentID,
      method: "POST",
      path: `/api/admin/agents/${agentID}/enable`,
      body: "{}",
      idempotency_key: key,
      timeout_ms: 5000,
    },
  };
  const deadline = timeout(5000);
  let headersReceived = false;
  try {
    const response = await request(gateway + receipt.request.path, {
      method: receipt.request.method,
      signal: AbortSignal.any([...(signal ? [signal] : []), deadline]),
      headers: {
        "content-type": "application/json",
        Cookie: admin.cookie,
        Origin: gateway,
        "X-Antnest-CSRF-Token": admin.csrf ?? "",
        "Idempotency-Key": key,
      },
      body: receipt.request.body,
    });
    headersReceived = true;
    receipt.status = response.status;
    receipt.trace_id = response.headers.get("x-antnest-trace-id");
    receipt.raw_text = await response.text();
    receipt.outcome = "http";
  } catch (error) {
    Object.defineProperty(receipt, "originalError", { value: error });
    receipt.error_text = inspect(error, { depth: 8 });
    receipt.timeout_aborted = deadline.aborted;
    receipt.parent_aborted = signal?.aborted ?? false;
    receipt.timeout_reason_matches = error === deadline.reason;
    receipt.outcome = headersReceived
      ? "body-error"
      : deadline.aborted &&
          error === deadline.reason &&
          error?.name === "TimeoutError" &&
          !signal?.aborted
        ? "timeout"
        : "transport-error";
  }
  return receipt;
}

export function assertMissingSkillEnable(receipt) {
  assert.deepEqual(receipt.request, {
    agent_id: receipt.request.agent_id,
    method: "POST",
    path: `/api/admin/agents/${receipt.request.agent_id}/enable`,
    body: "{}",
    idempotency_key: receipt.request.idempotency_key,
    timeout_ms: 5000,
  });
  if (["transport-error", "body-error"].includes(receipt.outcome))
    throw receipt.originalError ?? new Error(receipt.error_text);
  if (receipt.outcome === "timeout") {
    assert.equal(receipt.timeout_aborted, true);
    assert.equal(receipt.parent_aborted, false);
    assert.equal(receipt.timeout_reason_matches, true);
    assert.equal(receipt.status, undefined);
    assert.equal(receipt.trace_id, undefined);
    assert.equal(receipt.originalError?.name, "TimeoutError");
    return;
  }
  assert.equal(receipt.outcome, "http");
  assert.equal(receipt.status, 503);
  assert.match(receipt.trace_id, /^[a-f0-9]{32}$/u);
  const body = JSON.parse(receipt.raw_text);
  assert.equal(body.code, "dependency_unavailable");
  assert.equal(body.retryable, true);
}

export function assertMissingSkillPreparation(
  receipt,
  { organizationID, agentID, key, workspace, skillVolume },
) {
  const requestID =
    "lifecycle-" +
    createHash("sha256")
      .update(organizationID + "\0" + key)
      .digest("hex");
  assert(receipt.queries.length > 0);
  for (const query of receipt.queries) {
    assert.deepEqual(query.request, {
      method: "GET",
      path: preparationPath,
      idempotency_key: key,
    });
    assert.equal(query.status, 200);
    assert.match(query.trace_id, /^[a-f0-9]{32}$/u);
    assert.equal(query.body.request_id, requestID);
    assert.equal(query.body.agent_id, agentID);
    assert.equal(query.body.kind, "enable");
    assert(["queued", "preparing", "retry_wait"].includes(query.body.state));
  }
  const final = receipt.queries.at(-1).body;
  assert.equal(final.state, "retry_wait");
  assert.equal(final.error_code, "skill_preparation_unavailable");
  assert.equal(receipt.agent.agent_id, agentID);
  assert.equal(receipt.agent.activation_state, "disabled");
  assert.deepEqual(receipt.resources.containers, []);
  assert.deepEqual(receipt.resources.volumes, [workspace]);
  assert.equal(receipt.volume_query.name, skillVolume);
  assert(
    !receipt.volume_query.lines.includes(skillVolume),
    "Docker recreated the missing Skill volume",
  );
}
