import { createHmac, timingSafeEqual } from "node:crypto";
import type { BridgeScope } from "./registry.ts";

export type ConfigurationCondition = BridgeScope & {
  sessionId: string;
  epoch: string;
  incarnation: string;
  revision: string;
};

export class ConfigurationConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ConfigurationConflictError";
  }
}

export class ConfigurationTokens {
  private readonly key: Buffer;

  public constructor(key: Buffer) {
    if (key.length < 32)
      throw new RangeError("Configuration token key is too short");
    this.key = Buffer.from(key);
  }

  public issue(condition: ConfigurationCondition): string {
    if (!valid(condition))
      throw new TypeError("Invalid configuration condition");
    const payload = Buffer.from(JSON.stringify(fields(condition))).toString(
      "base64url",
    );
    const input = `c1.${payload}`;
    return `${input}.${this.sign(input)}`;
  }

  public matches(token: string, condition: ConfigurationCondition): boolean {
    if (typeof token !== "string" || token.length > 4096 || !valid(condition))
      return false;
    const parts = token.split(".");
    if (
      parts.length !== 3 ||
      parts[0] !== "c1" ||
      !/^[A-Za-z0-9_-]+$/u.test(parts[1] ?? "") ||
      !/^[A-Za-z0-9_-]{43}$/u.test(parts[2] ?? "")
    )
      return false;
    const input = `c1.${parts[1]}`;
    const actual = Buffer.from(parts[2]!, "base64url");
    const expected = Buffer.from(this.sign(input), "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return false;
    try {
      const decoded: unknown = JSON.parse(
        Buffer.from(parts[1]!, "base64url").toString("utf8"),
      );
      return JSON.stringify(decoded) === JSON.stringify(fields(condition));
    } catch {
      return false;
    }
  }

  private sign(input: string): string {
    return createHmac("sha256", this.key).update(input).digest("base64url");
  }
}

function fields(condition: ConfigurationCondition): string[] {
  return [
    condition.organizationId,
    condition.principalId,
    condition.agentId,
    condition.sessionId,
    condition.epoch,
    condition.incarnation,
    condition.revision,
  ];
}

function valid(condition: ConfigurationCondition): boolean {
  return (
    [
      condition.organizationId,
      condition.principalId,
      condition.agentId,
      condition.sessionId,
      condition.epoch,
      condition.incarnation,
    ].every(
      (value) =>
        typeof value === "string" && value.length > 0 && value.length <= 200,
    ) && /^[a-f0-9]{64}$/u.test(condition.revision)
  );
}
