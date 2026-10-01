import assert from "node:assert/strict";
import { createHash, createPrivateKey, randomUUID, sign } from "node:crypto";

const agentId = process.env.ANTNEST_E2E_AGENT_ID;
const runtimeIp = process.env.ANTNEST_E2E_RUNTIME_IP;
const oldKey = process.env.ANTNEST_E2E_OLD_SIGNING_KEY;
const nextKey = process.env.ANTNEST_E2E_NEXT_SIGNING_KEY;
assert(agentId && runtimeIp && oldKey && nextKey);

async function main() {
  const origin = `http://${runtimeIp}:8093`;
  if (process.env.ANTNEST_E2E_EXPECT_RUNTIME_OFFLINE === "true") {
    await assert.rejects(
      fetch(`${origin}/status`, { signal: AbortSignal.timeout(2000) }),
    );
    console.log(JSON.stringify({ status: "runtime_stopped" }));
    return;
  }
  const statusResponse = await fetch(`${origin}/status`, {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(statusResponse.status, 200);
  const runtime = await statusResponse.json();
  assert.equal(runtime.status, "ready");
  assert.equal(typeof runtime.execution_id, "string");

  const requestId = randomUUID();
  const jobId = randomUUID();
  const body = Buffer.from(
    JSON.stringify({
      action: "cancel",
      request_id: requestId,
      job_id: jobId,
      generation: 1,
    }),
  );
  const digest = `sha256:${createHash("sha256").update(body).digest("hex")}`;

  async function cancel(kid, encodedKey) {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(
      JSON.stringify({
        version: 1,
        algorithm: "Ed25519",
        kid,
      }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        organization_id: "org-1",
        agent_id: agentId,
        execution_id: runtime.execution_id,
        job_id: jobId,
        generation: 1,
        action: "cancel",
        request_id: requestId,
        body_sha256: digest,
        issued_at: now,
        expires_at: now + 60,
      }),
    ).toString("base64url");
    const message = Buffer.from(
      `antnest-skill-maintenance-v1\n${header}.${payload}`,
    );
    const privateKey = createPrivateKey({
      key: Buffer.from(encodedKey, "base64"),
      format: "der",
      type: "pkcs8",
    });
    const signature = sign(null, message, privateKey).toString("base64url");
    return fetch(`${origin}/internal/skill-maintenance/cancel`, {
      method: "POST",
      headers: {
        Authorization: `AntnestMaintenance ${header}.${payload}.${signature}`,
        "Content-Type": "application/json",
        "X-Antnest-Expected-Execution-ID": runtime.execution_id,
      },
      body,
      signal: AbortSignal.timeout(5000),
    });
  }

  const removed = await cancel("fixture-key", oldKey);
  const oldTrusted = process.env.ANTNEST_E2E_EXPECT_OLD_TRUSTED === "true";
  assert.equal(
    removed.status,
    oldTrusted ? 200 : 401,
    await removed.clone().text(),
  );
  const retained = await cancel("fixture-next", nextKey);
  assert.equal(retained.status, 200, await retained.clone().text());
  assert.equal((await retained.json()).outcome, "cancelled");
  console.log(
    JSON.stringify({
      status: oldTrusted ? "old_key_still_trusted" : "removed_key_rejected",
      execution_id: runtime.execution_id,
    }),
  );
}
await main();
