import assert from "node:assert/strict";
import { createHash, createPrivateKey, randomUUID, sign } from "node:crypto";
import { readFileSync } from "node:fs";

const agentId = process.env.ANTNEST_E2E_AGENT_ID;
const oldKey = process.env.ANTNEST_E2E_OLD_SIGNING_KEY;
const nextKey = process.env.ANTNEST_E2E_NEXT_SIGNING_KEY;
assert(agentId && oldKey && nextKey);
const serviceHeader = "Antnest-Service-Authorization";

async function main() {
  // The Runtime admits only its alias as Host; the caller pins it.
  const origin = `http://antnest-runtime-${agentId}:8093`;
  if (process.env.ANTNEST_E2E_EXPECT_RUNTIME_OFFLINE === "true") {
    await assert.rejects(
      fetch(`${origin}/status`, { signal: AbortSignal.timeout(2000) }),
    );
    console.log(JSON.stringify({ status: "runtime_stopped" }));
    return;
  }
  // ACP may hold credentials for earlier Runtime connections; the live
  // Runtime accepts only its own.
  const tokens = readFileSync("/proof/runtime-tokens", "utf8")
    .split(/\s+/u)
    .filter(Boolean);
  assert(tokens.length > 0, "no ACP Runtime credential");
  let token;
  let runtime;
  for (const candidate of tokens) {
    const response = await fetch(`${origin}/status`, {
      headers: { [serviceHeader]: `Bearer ${candidate}` },
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 200) {
      token = candidate;
      runtime = await response.json();
      break;
    }
    await response.body?.cancel();
  }
  assert(token, "Runtime rejected every ACP credential");
  assert.equal(runtime.status, "ready");
  assert.equal(typeof runtime.execution_id, "string");

  const jobId = randomUUID();

  // The read-only digest is the probe: a verifier decision never changes the
  // workspace, whichever key it admits.
  async function digestWith(kid, encodedKey) {
    const requestId = randomUUID();
    const body = Buffer.from(
      JSON.stringify({
        action: "digest",
        request_id: requestId,
        job_id: jobId,
        generation: 1,
        package_path: ".antnest/skills/fixture-procedure",
      }),
    );
    const digest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
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
        action: "digest",
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
    return fetch(`${origin}/internal/skill-maintenance/digest`, {
      method: "POST",
      headers: {
        [serviceHeader]: `Bearer ${token}`,
        Authorization: `AntnestMaintenance ${header}.${payload}.${signature}`,
        "Content-Type": "application/json",
        "X-Antnest-Expected-Execution-ID": runtime.execution_id,
      },
      body,
      signal: AbortSignal.timeout(5000),
    });
  }

  const removed = await digestWith("fixture-key", oldKey);
  const oldTrusted = process.env.ANTNEST_E2E_EXPECT_OLD_TRUSTED === "true";
  const removedText = await removed.clone().text();
  assert.equal(removed.status, oldTrusted ? 200 : 401, removedText);
  // A transport rejection is also 401; only the maintenance verifier's code
  // proves that the removed key itself was refused.
  if (!oldTrusted)
    assert.equal(
      JSON.parse(removedText).error?.code,
      "maintenance_unauthorized",
      removedText,
    );
  const retained = await digestWith("fixture-next", nextKey);
  assert.equal(retained.status, 200, await retained.clone().text());
  assert.equal((await retained.json()).outcome, "observed");
  console.log(
    JSON.stringify({
      status: oldTrusted ? "old_key_still_trusted" : "removed_key_rejected",
      execution_id: runtime.execution_id,
    }),
  );
}
await main();
