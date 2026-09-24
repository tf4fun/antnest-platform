import { createHmac, timingSafeEqual } from "node:crypto";

export type HistoryCondition = {
  organizationId: string;
  principalId: string;
  agentId: string;
  sessionId: string;
  epoch: string;
  incarnation: string;
  appendVersion: number;
};

export class HistoryTokens {
  private readonly key: Buffer;

  public constructor(key: Buffer) {
    if (key.length < 32)
      throw new RangeError("History token key must contain at least 32 bytes");
    this.key = Buffer.from(key);
  }

  public issue(condition: HistoryCondition): string {
    if (!valid(condition)) throw new TypeError("Invalid history condition");
    const payload = Buffer.from(JSON.stringify(fields(condition))).toString(
      "base64url",
    );
    const input = `v1.${payload}`;
    return `${input}.${this.sign(input)}`;
  }

  public matches(token: string, condition: HistoryCondition): boolean {
    if (typeof token !== "string" || token.length > 4096 || !valid(condition))
      return false;
    const parts = token.split(".");
    if (
      parts.length !== 3 ||
      parts[0] !== "v1" ||
      !/^[A-Za-z0-9_-]+$/u.test(parts[1] ?? "") ||
      !/^[A-Za-z0-9_-]{43}$/u.test(parts[2] ?? "")
    )
      return false;
    const input = `v1.${parts[1]}`;
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

function fields(condition: HistoryCondition): unknown[] {
  return [
    condition.organizationId,
    condition.principalId,
    condition.agentId,
    condition.sessionId,
    condition.epoch,
    condition.incarnation,
    condition.appendVersion,
  ];
}

function valid(condition: HistoryCondition): boolean {
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
    ) &&
    Number.isSafeInteger(condition.appendVersion) &&
    condition.appendVersion >= 0
  );
}
