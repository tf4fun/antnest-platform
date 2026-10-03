import { compactVerify, importJWK, type CryptoKey } from "jose";
import { z } from "zod";
import { strictObject } from "./strict-json.js";

export const CALLER_CONTEXT_HEADER = "Antnest-Caller-Context";
const kid = z.string().regex(/^[!-~]{1,128}$/u);
const identifier = z
  .string()
  .min(1)
  .max(200)
  .regex(/^\S+$/u)
  .refine((value) =>
    [...value].every((character) => {
      const code = character.charCodeAt(0);
      return code > 31 && code !== 127;
    }),
  );
const headerSchema = z.strictObject({
  typ: z.literal("antnest-cct+jwt"),
  alg: z.literal("EdDSA"),
  kid,
});
const keySchema = z.strictObject({
  kid,
  kty: z.literal("OKP"),
  crv: z.literal("Ed25519"),
  use: z.literal("sig"),
  alg: z.literal("EdDSA"),
  x: z.string(),
});
const claimsSchema = z.strictObject({
  iss: z.literal("antnest://service/identity-service"),
  sub: identifier,
  org: identifier,
  mbr: identifier,
  sys_role: z.enum(["user", "admin"]),
  org_role: z.enum(["member", "admin"]),
  sid: identifier,
  aud: z
    .array(
      z.enum([
        "identity-service",
        "admin-console",
        "agent-ui",
        "agent-acp-service",
        "agent-controller",
        "skill-registry",
      ]),
    )
    .min(1)
    .max(5)
    .refine((value) => new Set(value).size === value.length),
  iat: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  exp: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  jti: identifier,
  agt: identifier.optional(),
});
export type CallerClaims = z.infer<typeof claimsSchema>;
export type Keys = Map<string, CryptoKey>;
export class CallerContextError extends Error {
  public constructor(
    public readonly code: "caller_context_invalid" | "identity_dependency_unavailable",
  ) {
    super(code);
  }
}
function invalid(): never {
  throw new CallerContextError("caller_context_invalid");
}

function segment(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) invalid();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) invalid();
  return bytes;
}
function frame(token: string) {
  try {
    if (token.length > 8192) invalid();
    const parts = token.split(".");
    if (parts.length !== 3 || segment(parts[2]!).length !== 64) invalid();
    return {
      header: headerSchema.parse(strictObject(segment(parts[0]!))),
      claims: claimsSchema.parse(strictObject(segment(parts[1]!))),
    };
  } catch {
    invalid();
  }
}
export async function parseKeys(raw: Uint8Array): Promise<Keys> {
  try {
    if (raw.length > 16384) invalid();
    const document = z
      .strictObject({ keys: z.array(keySchema).min(1).max(8) })
      .parse(strictObject(raw));
    const result: Keys = new Map();
    for (const key of document.keys) {
      if (result.has(key.kid) || segment(key.x).length !== 32) invalid();
      result.set(key.kid, await importJWK(key, "EdDSA"));
    }
    return result;
  } catch {
    invalid();
  }
}

export type ExpectedContext = {
  consumer: string;
  organization?: string | undefined;
  agent?: string | undefined;
  now: number;
  tolerance: number;
};
export async function verifyCallerContext(
  token: string,
  keys: Keys,
  expected: ExpectedContext,
): Promise<CallerClaims> {
  const { header, claims } = frame(token);
  const key = keys.get(header.kid);
  if (
    !key ||
    expected.tolerance < 0 ||
    expected.tolerance > 30 ||
    !Number.isFinite(expected.now) ||
    claims.exp <= claims.iat ||
    claims.exp - claims.iat > 60 ||
    claims.iat > expected.now + expected.tolerance ||
    expected.now >= claims.exp + expected.tolerance ||
    !claims.aud.some((value) => value === expected.consumer) ||
    (expected.organization !== undefined && claims.org !== expected.organization) ||
    claims.agt !== expected.agent
  )
    invalid();
  try {
    await compactVerify(token, key, { algorithms: ["EdDSA"] });
  } catch {
    invalid();
  }
  return claims;
}

// The only key source is the configured, workload-authenticated Identity origin.
// Never follow token-supplied URLs. Expired key caches fail closed on an outage.
export class CallerContextVerifier {
  private keys: Keys = new Map();
  private expiresAt = 0;
  private refreshAfter = 0;
  private refreshing: Promise<void> | undefined;
  public constructor(
    private readonly identityOrigin: string,
    private readonly fetcher: typeof fetch,
    private readonly now = () => Date.now(),
  ) {}
  public async verify(
    token: string,
    expected: { agent?: string | undefined; requireAgent?: boolean; organization?: string },
  ): Promise<CallerClaims> {
    const parsed = frame(token);
    if (
      this.keys.size === 0 ||
      this.now() >= this.expiresAt ||
      (!this.keys.has(parsed.header.kid) && this.now() >= this.refreshAfter)
    )
      await this.refresh();
    if (!this.keys.has(parsed.header.kid)) invalid();
    const agent = expected.requireAgent ? parsed.claims.agt : expected.agent;
    if (expected.requireAgent && agent === undefined) invalid();
    return verifyCallerContext(token, this.keys, {
      consumer: "agent-acp-service",
      agent,
      organization: expected.organization,
      now: Math.floor(this.now() / 1000),
      tolerance: 30,
    });
  }
  private refresh(): Promise<void> {
    this.refreshing ??= this.readKeys().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }
  private async readKeys(): Promise<void> {
    this.refreshAfter = this.now() + 5000;
    try {
      const response = await this.fetcher(new URL("/rpc/identity/jwks", this.identityOrigin), {
        method: "GET",
        signal: AbortSignal.timeout(5000),
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
      });
      if (response.status !== 200 || !response.body) {
        await response.body?.cancel();
        throw new Error();
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > 16384) throw new Error();
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      this.keys = await parseKeys(Buffer.concat(chunks));
      this.expiresAt = this.now() + 30000;
    } catch {
      throw new CallerContextError("identity_dependency_unavailable");
    }
  }
}
