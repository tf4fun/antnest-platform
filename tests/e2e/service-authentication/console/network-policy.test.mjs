import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { verifyPendingNetwork } from "./network-policy.mjs";

function fixtureRun(hiddenAttempt) {
  const fixture = generateKeyPairSync("ed25519");
  const snapshot = {
    calls: 0,
    businessAttempts: 0,
    networkPolicy: { calls: [] },
  };
  const admission = { responses: [], calls: [], complete: false };
  let policy = {
    agent_id: "agent-1",
    action: "deny_all",
    resource_version: 7,
    attachment: { state: "pending", resource_version: 2 },
  };
  const request = async (_path, options) => {
    const status = options.status ?? 200;
    let body;
    if (status >= 400) {
      if (hiddenAttempt) snapshot.businessAttempts++;
      body = { code: options.code ?? "forbidden" };
    } else {
      snapshot.calls++;
      snapshot.businessAttempts++;
      snapshot.networkPolicy.calls.push({
        method: options.method ?? "GET",
        contextDigest: createHash("sha256")
          .update(options.context)
          .digest("hex"),
        attachment: { ...policy.attachment },
        assignmentVersion: policy.resource_version,
      });
      if (options.method === "PUT") {
        policy = { ...policy, action: "allow_all", resource_version: 8 };
        body = {
          agent_id: "agent-1",
          action: "allow_all",
          resource_version: 8,
        };
      } else body = policy;
    }
    snapshot.networkPolicy.attachment = { ...policy.attachment };
    const response = Response.json(body, {
      status,
      headers: { "Cache-Control": "no-store" },
    });
    return { response, text: await response.text() };
  };
  return {
    fixture,
    request,
    admission,
    state: async () => structuredClone(snapshot),
    openPeer: async () => {
      policy = {
        ...policy,
        attachment: { state: "open", resource_version: 3 },
      };
    },
  };
}

test("network acceptance retains exactly three reads and one assignment", async () => {
  const run = fixtureRun(false);
  await verifyPendingNetwork(run);
  assert.equal(run.admission.complete, true);
});

test("network acceptance rejects an HTTP attempt hidden by dependency authentication failure", async () => {
  await assert.rejects(
    verifyPendingNetwork(fixtureRun(true)),
    /unexpected business HTTP attempt/u,
  );
});
