import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export type OwnerRegistrationRequest = {
  member_id: string;
  incarnation_id: string;
  registration_nonce: string;
};

export type OwnerProbeRequest = OwnerRegistrationRequest & { challenge: string };

export type OwnerRegistration = {
  registration_id: string;
  member_id: string;
  incarnation_id: string;
};

const errorCodes = [
  "invalid_request",
  "acp_probe_intent_mismatch",
  "acp_registration_unavailable",
  "acp_registry_unavailable",
  "deadline_exceeded",
] as const;

export type OwnerIncarnationErrorCode = (typeof errorCodes)[number];

export class OwnerIncarnationError extends Error {
  public readonly code: OwnerIncarnationErrorCode;

  public constructor(code: OwnerIncarnationErrorCode) {
    const safeCode = errorCodes.includes(code) ? code : "invalid_request";
    super(safeCode);
    this.name = "OwnerIncarnationError";
    this.code = safeCode;
  }
}

const memberPattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const noncePattern = /^[0-9a-f]{64}$/u;

function validMember(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 64 &&
    memberPattern.exec(value)?.[0] === value
  );
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" && value.length === 36 && uuidPattern.test(value);
}

function validNonce(value: unknown): value is string {
  return typeof value === "string" && value.length === 64 && noncePattern.test(value);
}

function exactRecord(value: unknown, expected: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new OwnerIncarnationError("invalid_request");
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expected.length ||
    keys.some((key) => typeof key !== "string" || !expected.includes(key))
  )
    throw new OwnerIncarnationError("invalid_request");
  return value as Record<string, unknown>;
}

export function parseOwnerProbeRequest(value: unknown): OwnerProbeRequest {
  try {
    const record = exactRecord(value, [
      "member_id",
      "incarnation_id",
      "registration_nonce",
      "challenge",
    ]);
    const {
      member_id: memberId,
      incarnation_id: incarnationId,
      registration_nonce: registrationNonce,
      challenge,
    } = record;
    if (
      !validMember(memberId) ||
      !validUuid(incarnationId) ||
      !validNonce(registrationNonce) ||
      !validNonce(challenge)
    )
      throw new OwnerIncarnationError("invalid_request");
    return Object.freeze({
      member_id: memberId,
      incarnation_id: incarnationId,
      registration_nonce: registrationNonce,
      challenge,
    });
  } catch {
    throw new OwnerIncarnationError("invalid_request");
  }
}

export function parseOwnerRegistration(value: unknown): Readonly<OwnerRegistration> {
  try {
    const record = exactRecord(value, ["registration_id", "member_id", "incarnation_id"]);
    const {
      registration_id: registrationId,
      member_id: memberId,
      incarnation_id: incarnationId,
    } = record;
    if (!validUuid(registrationId) || !validMember(memberId) || !validUuid(incarnationId))
      throw new OwnerIncarnationError("acp_registration_unavailable");
    return Object.freeze({
      registration_id: registrationId,
      member_id: memberId,
      incarnation_id: incarnationId,
    });
  } catch {
    throw new OwnerIncarnationError("acp_registration_unavailable");
  }
}

export class OwnerIncarnation {
  #pending: Readonly<OwnerRegistrationRequest> | undefined;
  #registration: Readonly<OwnerRegistration> | undefined;
  #closed = false;

  public constructor(memberId: string) {
    if (!validMember(memberId)) throw new OwnerIncarnationError("invalid_request");
    try {
      this.#pending = Object.freeze({
        member_id: memberId,
        incarnation_id: randomUUID(),
        registration_nonce: randomBytes(32).toString("hex"),
      });
    } catch {
      throw new OwnerIncarnationError("acp_registration_unavailable");
    }
  }

  public registrationRequest(): Readonly<OwnerRegistrationRequest> {
    if (this.#closed || this.#pending === undefined)
      throw new OwnerIncarnationError("acp_registration_unavailable");
    return this.#pending;
  }

  public probe(request: OwnerProbeRequest): OwnerProbeRequest {
    const pending = this.#pending;
    if (this.#closed || pending === undefined)
      throw new OwnerIncarnationError("acp_probe_intent_mismatch");
    let parsed: OwnerProbeRequest;
    try {
      parsed = parseOwnerProbeRequest(request);
    } catch {
      throw new OwnerIncarnationError("acp_probe_intent_mismatch");
    }
    if (
      this.#pending !== pending ||
      parsed.member_id !== pending.member_id ||
      parsed.incarnation_id !== pending.incarnation_id ||
      !timingSafeEqual(
        Buffer.from(parsed.registration_nonce, "ascii"),
        Buffer.from(pending.registration_nonce, "ascii"),
      )
    )
      throw new OwnerIncarnationError("acp_probe_intent_mismatch");
    return parsed;
  }

  public acceptRegistration(receipt: OwnerRegistration): Readonly<OwnerRegistration> {
    const pending = this.#pending;
    if (this.#closed || pending === undefined)
      throw new OwnerIncarnationError("acp_registration_unavailable");
    const parsed = parseOwnerRegistration(receipt);
    if (
      this.#pending !== pending ||
      parsed.member_id !== pending.member_id ||
      parsed.incarnation_id !== pending.incarnation_id
    )
      throw new OwnerIncarnationError("acp_registration_unavailable");
    this.#registration = parsed;
    this.#pending = undefined;
    return parsed;
  }

  public currentRegistration(): Readonly<OwnerRegistration> | undefined {
    return this.#closed ? undefined : this.#registration;
  }

  public close(): void {
    this.#closed = true;
    this.#pending = undefined;
    this.#registration = undefined;
  }
}
