import { SecretBox } from "../adapters/postgres/secret-box.js";
import { ownershipFence } from "../domain/agent-ownership.js";
import type { ExecutionIdentity } from "../domain/execution-configuration.js";
import { DomainError } from "../domain/errors.js";
import { parseOwnerRegistration, type OwnerRegistration } from "./owner-incarnation.js";

const associatedData = "antnest:acp:http-owner-handle:v1";
const maximumBytes = 4096;
const nonceBytes = 12;
const tagBytes = 16;
const inputFields = ["owner", "epoch", "connectionId", "identity"] as const;
const payloadFields = [
  "version",
  "membership_sha256",
  ...inputFields,
  "protocol",
  "transport",
] as const;

export type HttpOwnerHandle = Readonly<{
  version: 1;
  membership_sha256: string;
  owner: Readonly<OwnerRegistration>;
  epoch: string;
  connectionId: string;
  identity: Readonly<ExecutionIdentity>;
  protocol: "v1";
  transport: "http";
}>;

export class HttpOwnerHandles {
  private readonly secretBox: SecretBox;
  private readonly membershipSha256: string;

  public constructor(options: { secretBox: SecretBox; membershipSha256: string }) {
    try {
      const { secretBox, membershipSha256 } = options;
      if (
        !(secretBox instanceof SecretBox) ||
        typeof membershipSha256 !== "string" ||
        membershipSha256.length !== 64 ||
        !/^[a-f0-9]{64}$/u.test(membershipSha256)
      )
        throw new Error();
      this.secretBox = secretBox;
      this.membershipSha256 = membershipSha256;
    } catch {
      throw invalid();
    }
    Object.freeze(this);
  }

  public seal(value: unknown): string {
    try {
      const binding = exactRecord(value, inputFields);
      const payload = this.parse({
        version: 1,
        membership_sha256: this.membershipSha256,
        ...binding,
        protocol: "v1",
        transport: "http",
      });
      const sealed = this.secretBox.seal(payload, associatedData);
      if (sealed.nonce.byteLength !== nonceBytes || sealed.ciphertext.byteLength < tagBytes)
        throw new Error();
      const encoded = `acph1.${sealed.nonce.toString("base64url")}.${sealed.ciphertext.toString("base64url")}`;
      if (encoded.length > maximumBytes) throw new Error();
      return encoded;
    } catch {
      throw invalid();
    }
  }

  public open(value: string): HttpOwnerHandle {
    try {
      if (typeof value !== "string" || value.length > maximumBytes) throw new Error();
      const match = /^acph1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/u.exec(value);
      if (match === null || match[0] !== value) throw new Error();
      const nonce = canonicalBase64url(match[1]!);
      const ciphertext = canonicalBase64url(match[2]!);
      if (nonce.byteLength !== nonceBytes || ciphertext.byteLength < tagBytes) throw new Error();
      return this.parse(this.secretBox.open<unknown>({ nonce, ciphertext }, associatedData));
    } catch {
      throw invalid();
    }
  }

  private parse(value: unknown): HttpOwnerHandle {
    const payload = exactRecord(value, payloadFields);
    if (
      payload.version !== 1 ||
      payload.membership_sha256 !== this.membershipSha256 ||
      payload.protocol !== "v1" ||
      payload.transport !== "http" ||
      typeof payload.epoch !== "string"
    )
      throw new Error();
    const owner = parseOwnerRegistration(payload.owner);
    const sourceIdentity = exactRecord(payload.identity, [
      "organizationId",
      "principalId",
      "agentId",
    ]);
    const identity = Object.freeze({
      organizationId: identifier(sourceIdentity.organizationId),
      principalId: identifier(sourceIdentity.principalId),
      agentId: identifier(sourceIdentity.agentId),
    });
    const fence = ownershipFence({
      organizationId: identity.organizationId,
      agentId: identity.agentId,
      ownerInstanceId: owner.incarnation_id,
      epoch: payload.epoch,
    });
    return Object.freeze({
      version: 1,
      membership_sha256: this.membershipSha256,
      owner,
      epoch: fence.epoch,
      connectionId: identifier(payload.connectionId),
      identity,
      protocol: "v1",
      transport: "http",
    });
  }
}

function exactRecord(value: unknown, expected: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expected.length ||
    keys.some((key) => typeof key !== "string" || !expected.includes(key))
  )
    throw new Error();
  return value as Record<string, unknown>;
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 200 || value.trim() !== value)
    throw new Error();
  return value;
}

function canonicalBase64url(value: string): Buffer {
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) throw new Error();
  return decoded;
}

function invalid(): DomainError {
  return new DomainError("invalid_request", "Invalid HTTP owner handle");
}
