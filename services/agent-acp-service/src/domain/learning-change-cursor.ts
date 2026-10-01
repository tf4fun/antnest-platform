import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { DomainError } from "./errors.js";

type Scope = { organizationId: string; agentId: string; ownerId: string };
type Direction = "after" | "before";
type Payload = {
  v: 1;
  o: string;
  a: string;
  p: string;
  d: Direction;
  s: string;
  e: number;
};

const MAX_SEQUENCE = 9_223_372_036_854_775_807n;
const TTL_SECONDS = 24 * 60 * 60;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/u;

/** Scoped, direction-bound cursors over committed Agent learning changes. */
export class LearningChangeCursor {
  private readonly key: Buffer;

  public constructor(
    secret: Buffer,
    private readonly nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    if (secret.length !== 32) throw new Error("Invalid learning change cursor secret");
    this.key = createHash("sha256")
      .update("antnest-learning-change-cursor-v1\n")
      .update(secret)
      .digest();
  }

  public encode(scope: Scope, direction: Direction, sequence: string): string {
    validateScope(scope);
    validateSequence(sequence, direction);
    if (sequence === "0") return "0";
    const now = this.nowSeconds();
    if (!Number.isSafeInteger(now) || now < 0)
      throw new Error("Learning change cursor clock is unavailable");
    const payload: Payload = {
      v: 1,
      o: scope.organizationId,
      a: scope.agentId,
      p: scope.ownerId,
      d: direction,
      s: sequence,
      e: now + TTL_SECONDS,
    };
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = createHmac("sha256", this.key).update(body).digest("base64url");
    return `${body}.${signature}`;
  }

  public decode(value: string, scope: Scope, direction: Direction): string {
    validateScope(scope);
    if (value === "0") {
      if (direction === "after") return "0";
      throw expired();
    }
    if (value.length < 1 || value.length > 4096) throw expired();
    const parts = value.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw expired();
    const expected = createHmac("sha256", this.key).update(parts[0]).digest();
    const actual = canonicalBase64Url(parts[1]);
    if (actual === null || actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw expired();
    const decoded = canonicalBase64Url(parts[0]);
    if (decoded === null || decoded.length > 1024) throw expired();
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoded.toString("utf8"));
    } catch {
      throw expired();
    }
    if (!isPayload(parsed)) throw expired();
    if (
      parsed.o !== scope.organizationId ||
      parsed.a !== scope.agentId ||
      parsed.p !== scope.ownerId
    )
      throw new DomainError("access_denied", "Learning change cursor scope changed");
    if (parsed.d !== direction) throw expired();
    try {
      validateSequence(parsed.s, direction);
    } catch {
      throw expired();
    }
    if (parsed.e <= this.nowSeconds()) throw expired();
    return parsed.s;
  }
}

function isPayload(value: unknown): value is Payload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    Object.keys(item).sort().join(",") === "a,d,e,o,p,s,v" &&
    item.v === 1 &&
    typeof item.o === "string" &&
    typeof item.a === "string" &&
    typeof item.p === "string" &&
    (item.d === "after" || item.d === "before") &&
    typeof item.s === "string" &&
    typeof item.e === "number" &&
    Number.isSafeInteger(item.e)
  );
}

function canonicalBase64Url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const decoded = Buffer.from(value, "base64url");
  return decoded.toString("base64url") === value ? decoded : null;
}

function validateScope(scope: Scope): void {
  if (!ID.test(scope.organizationId) || !ID.test(scope.agentId) || !ID.test(scope.ownerId))
    throw new DomainError("access_denied", "Learning change cursor scope is invalid");
}

function validateSequence(value: string, direction: Direction): void {
  if (
    !/^(?:0|[1-9][0-9]{0,18})$/u.test(value) ||
    BigInt(value) > MAX_SEQUENCE ||
    (direction === "before" && value === "0")
  )
    throw new Error("Invalid learning change cursor sequence");
}

function expired(): DomainError {
  return new DomainError("cursor_expired", "Learning change cursor is invalid or expired");
}
