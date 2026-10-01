import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";

import { RuntimeSkillMaintenanceSigner } from "../../src/adapters/runtime-skill-maintenance-signer.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const input = {
  organizationId: "org-1",
  agentId: "agent-1",
  executionId: "execution-1",
  jobId: "job-1",
  generation: 2,
  action: "prepare" as const,
  requestId: "request-1",
  body: Buffer.from("exact raw request body"),
};

describe("Runtime Skill maintenance ticket signer", () => {
  it("signs the exact L0 domain, identity, body and bounded issue window", () => {
    const signer = new RuntimeSkillMaintenanceSigner("key-1", privateKey, () => 1_800_000_000);
    const authorization = signer.sign(input);
    expect(authorization.startsWith("AntnestMaintenance ")).toBe(true);
    const [header, payload, signature] = authorization
      .slice("AntnestMaintenance ".length)
      .split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({
      version: 1,
      algorithm: "Ed25519",
      kid: "key-1",
    });
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toEqual({
      organization_id: "org-1",
      agent_id: "agent-1",
      execution_id: "execution-1",
      job_id: "job-1",
      generation: 2,
      action: "prepare",
      request_id: "request-1",
      body_sha256: `sha256:${createHash("sha256").update(input.body).digest("hex")}`,
      issued_at: 1_800_000_000,
      expires_at: 1_800_000_060,
    });
    expect(
      verify(
        null,
        Buffer.from(`antnest-skill-maintenance-v1\n${header}.${payload}`),
        publicKey,
        Buffer.from(signature!, "base64url"),
      ),
    ).toBe(true);
    expect(signer.sign({ ...input, body: Buffer.from("changed") })).not.toBe(authorization);
  });

  it("rejects keys and identities Runtime cannot verify", () => {
    expect(() => new RuntimeSkillMaintenanceSigner("bad.key", privateKey)).toThrow();
    const signer = new RuntimeSkillMaintenanceSigner("key-1", privateKey);
    expect(() => signer.sign({ ...input, requestId: "slash/id" })).toThrow();
    expect(() => signer.sign({ ...input, generation: 0 })).toThrow();
  });
});
