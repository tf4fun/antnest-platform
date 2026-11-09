import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import {
  RuntimeSkillMaintenanceSigner,
  SKILL_MAINTENANCE_ACTIONS,
  type SkillMaintenanceAction,
} from "../../src/adapters/runtime-skill-maintenance-signer.js";

interface MaintenanceTicketVector {
  action: string;
  generation: number;
}

const maintenanceTicketContract = JSON.parse(
  readFileSync(
    new URL("../../../../contracts/runtime/maintenance-ticket.schema.json", import.meta.url),
    "utf8",
  ),
) as { $id: string; $defs: { action: { enum: string[] } } };
const commonIDs = JSON.parse(
  readFileSync(new URL("../../../../contracts/common/ids.schema.json", import.meta.url), "utf8"),
) as object;
const maintenanceTicketFixtures = JSON.parse(
  readFileSync(
    new URL("../../../../contracts/runtime/maintenance-ticket-fixtures.json", import.meta.url),
    "utf8",
  ),
) as {
  valid: { action: SkillMaintenanceAction; generation: number }[];
  invalid: MaintenanceTicketVector[];
};
const ajv = new Ajv2020({ strict: true, validateFormats: false });
ajv.addSchema(commonIDs);
const validateTicket = ajv.compile(maintenanceTicketContract);

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const input = {
  organizationId: "org-1",
  agentId: "agent-1",
  executionId: "execution-1",
  jobId: "job-1",
  generation: 2,
  action: "install" as const,
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
      action: "install",
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

  it("admits a full install artifact but keeps the read-only digest body small", () => {
    const signer = new RuntimeSkillMaintenanceSigner("key-1", privateKey, () => 1_800_000_000);
    const multipart = Buffer.alloc(8 * 1024 * 1024 + 4 * 1024);
    expect(() => signer.sign({ ...input, body: multipart })).not.toThrow();
    expect(() =>
      signer.sign({ ...input, body: Buffer.alloc(8 * 1024 * 1024 + 8 * 1024 + 1) }),
    ).toThrow();
    expect(() =>
      signer.sign({ ...input, action: "digest", body: Buffer.alloc(16 * 1024 + 1) }),
    ).toThrow();
    expect(() =>
      signer.sign({
        ...input,
        action: "temporary_install",
        generation: 1,
        body: Buffer.alloc(8 * 1024 * 1024 + 8 * 1024),
      }),
    ).not.toThrow();
    expect(() =>
      signer.sign({
        ...input,
        action: "temporary_install",
        generation: 1,
        body: Buffer.alloc(8 * 1024 * 1024 + 8 * 1024 + 1),
      }),
    ).toThrow();
    expect(() =>
      signer.sign({
        ...input,
        action: "temporary_release",
        generation: 1,
        body: Buffer.alloc(16 * 1024),
      }),
    ).not.toThrow();
    expect(() =>
      signer.sign({
        ...input,
        action: "temporary_release",
        generation: 1,
        body: Buffer.alloc(16 * 1024 + 1),
      }),
    ).toThrow();
  });

  it("names only the Runtime actions that still exist", () => {
    const signer = new RuntimeSkillMaintenanceSigner("key-1", privateKey, () => 1_800_000_000);
    for (const retired of ["prepare", "check", "commit", "observe", "cancel", "release"])
      expect(() =>
        signer.sign({ ...input, action: retired as unknown as typeof input.action }),
      ).toThrow("Invalid");
  });

  it("exposes exactly the four wire actions the canonical schema declares", () => {
    expect([...SKILL_MAINTENANCE_ACTIONS]).toEqual([
      "install",
      "digest",
      "temporary_install",
      "temporary_release",
    ]);
    expect([...SKILL_MAINTENANCE_ACTIONS]).toEqual(maintenanceTicketContract.$defs.action.enum);
  });

  it("signs every shared valid vector as a schema-clean canonical ticket", () => {
    const signer = new RuntimeSkillMaintenanceSigner("key-1", privateKey, () => 1_800_000_000);
    for (const vector of maintenanceTicketFixtures.valid) {
      const authorization = signer.sign({
        ...input,
        action: vector.action,
        generation: vector.generation,
      });
      const [header, payload, signature] = authorization
        .slice("AntnestMaintenance ".length)
        .split(".");
      const decoded = JSON.parse(Buffer.from(payload!, "base64url").toString()) as Record<
        string,
        unknown
      >;
      expect(validateTicket(decoded)).toBe(true);
      expect(decoded).toEqual({
        organization_id: "org-1",
        agent_id: "agent-1",
        execution_id: "execution-1",
        job_id: "job-1",
        generation: vector.generation,
        action: vector.action,
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
    }
  });

  it("rejects every shared invalid vector and temporary generation drift", () => {
    const signer = new RuntimeSkillMaintenanceSigner("key-1", privateKey, () => 1_800_000_000);
    for (const vector of maintenanceTicketFixtures.invalid)
      expect(() =>
        signer.sign({
          ...input,
          action: vector.action as SkillMaintenanceAction,
          generation: vector.generation,
        }),
      ).toThrow("Invalid");
    for (const action of ["temporary_install", "temporary_release"] as const)
      expect(() => signer.sign({ ...input, action, generation: 0 })).toThrow("Invalid");
  });
});
