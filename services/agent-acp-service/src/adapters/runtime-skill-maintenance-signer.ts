import { createHash, sign, type KeyObject } from "node:crypto";

export type SkillMaintenanceAction =
  | "prepare"
  | "check"
  | "commit"
  | "observe"
  | "cancel"
  | "release"
  | "digest"
  | "temporary_install"
  | "temporary_release";

export type SkillMaintenanceTicketInput = {
  organizationId: string;
  agentId: string;
  executionId: string;
  jobId: string;
  generation: number;
  action: SkillMaintenanceAction;
  requestId: string;
  body: Buffer;
};

const KID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const SCOPED_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/u;
const OPAQUE_ID = /^[!-~]{1,200}$/u;
const REQUEST_ID = /^[!-~]{1,128}$/u;
const DOMAIN = Buffer.from("antnest-skill-maintenance-v1\n", "utf8");

export class RuntimeSkillMaintenanceSigner {
  public constructor(
    private readonly kid: string,
    private readonly privateKey: KeyObject,
    private readonly nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    if (
      !KID.test(kid) ||
      privateKey.type !== "private" ||
      privateKey.asymmetricKeyType !== "ed25519"
    )
      throw new Error("Invalid Runtime Skill maintenance signing identity");
  }

  public sign(input: SkillMaintenanceTicketInput): string {
    if (
      !SCOPED_ID.test(input.organizationId) ||
      !SCOPED_ID.test(input.agentId) ||
      !validOpaque(input.executionId, OPAQUE_ID) ||
      !validOpaque(input.jobId, OPAQUE_ID) ||
      !validOpaque(input.requestId, REQUEST_ID) ||
      !Number.isSafeInteger(input.generation) ||
      input.generation < 1 ||
      !(input.body instanceof Buffer) ||
      input.body.length >
        (["prepare", "temporary_install"].includes(input.action)
          ? 8 * 1024 * 1024 + 8 * 1024
          : 16 * 1024) ||
      (["temporary_install", "temporary_release"].includes(input.action) && input.generation !== 1)
    )
      throw new Error("Invalid Runtime Skill maintenance ticket input");
    const issuedAt = this.nowSeconds();
    if (!Number.isSafeInteger(issuedAt) || issuedAt < 0 || issuedAt + 60 > Number.MAX_SAFE_INTEGER)
      throw new Error("Runtime Skill maintenance clock is unavailable");
    const header = Buffer.from(
      JSON.stringify({ version: 1, algorithm: "Ed25519", kid: this.kid }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        organization_id: input.organizationId,
        agent_id: input.agentId,
        execution_id: input.executionId,
        job_id: input.jobId,
        generation: input.generation,
        action: input.action,
        request_id: input.requestId,
        body_sha256: `sha256:${createHash("sha256").update(input.body).digest("hex")}`,
        issued_at: issuedAt,
        expires_at: issuedAt + 60,
      }),
    ).toString("base64url");
    const signature = sign(
      null,
      Buffer.concat([DOMAIN, Buffer.from(`${header}.${payload}`)]),
      this.privateKey,
    ).toString("base64url");
    return `AntnestMaintenance ${header}.${payload}.${signature}`;
  }
}

function validOpaque(value: string, pattern: RegExp): boolean {
  return pattern.test(value) && !value.includes("/") && !value.includes("\\");
}
