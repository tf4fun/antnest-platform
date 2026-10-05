import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseReceiver,
  validateToken,
  validateMode,
  authenticateFields,
} from "../../src/adapters/service-authentication.js";
import { parseKeys, verifyCallerContext } from "../../src/adapters/caller-context.js";

const tokens = JSON.parse(
  readFileSync(
    new URL("../../../../contracts/platform/service-token-fixtures.json", import.meta.url),
    "utf8",
  ),
) as {
  receiver_configurations: Record<string, Record<string, string[]>>;
  configuration_vectors: {
    name: string;
    receiver: string;
    self_allowed: boolean;
    callers_json: string;
    valid: boolean;
  }[];
  token_vectors: { name: string; token: string; valid: boolean }[];
  header_vectors: {
    name: string;
    configuration: string;
    allowed_callers: string[];
    fields: { name: string; value: string }[];
    expected: {
      code: string | null;
      http_status: number;
      caller: string | null;
      www_authenticate: string | null;
    };
  }[];
  mode_vectors: {
    name: string;
    mode: string | null;
    allow_insecure_transport: string | null;
    transport: "http" | "https";
    valid: boolean;
  }[];
};
describe("shared token conformance", () => {
  it.each(tokens.configuration_vectors)("receiver: $name", (v) => {
    const operation = () => parseReceiver(v.receiver, Buffer.from(v.callers_json), v.self_allowed);
    if (v.valid) expect(operation).not.toThrow();
    else expect(operation).toThrow();
  });
  it.each(tokens.token_vectors)("token: $name", (v) => {
    expect(validateToken(v.token)).toBe(v.valid);
  });
  it.each(tokens.header_vectors)("header: $name", (v) => {
    const receiver = parseReceiver(
      "runtime-controller",
      Buffer.from(JSON.stringify(tokens.receiver_configurations[v.configuration])),
    );
    expect(authenticateFields(receiver, v.fields, v.allowed_callers)).toEqual(v.expected);
  });
  it.each(tokens.mode_vectors)("mode: $name", (v) => {
    const operation = () =>
      validateMode(v.mode ?? undefined, v.allow_insecure_transport ?? undefined, v.transport);
    if (v.valid) expect(operation).not.toThrow();
    else expect(operation).toThrow();
  });
});
const contexts = JSON.parse(
  readFileSync(
    new URL("../../../../contracts/platform/caller-context-fixtures.json", import.meta.url),
    "utf8",
  ),
) as {
  jwks: unknown;
  verification_vectors: {
    name: string;
    token: string;
    now: number;
    tolerance: number;
    consumer: string;
    organization: string;
    agent: string | null;
    valid: boolean;
  }[];
};
describe("shared signed CCT conformance", () => {
  it.each(contexts.verification_vectors)("$name", async (v) => {
    const keys = await parseKeys(Buffer.from(JSON.stringify(contexts.jwks)));
    const promise = verifyCallerContext(v.token, keys, {
      consumer: v.consumer,
      organization: v.organization,
      agent: v.agent ?? undefined,
      now: v.now,
      tolerance: v.tolerance,
    });
    if (v.valid) await expect(promise).resolves.toHaveProperty("sub");
    else await expect(promise).rejects.toThrow();
  });
});
