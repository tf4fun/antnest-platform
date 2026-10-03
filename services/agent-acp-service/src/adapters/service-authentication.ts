import {
  createHash,
  timingSafeEqual,
  X509Certificate,
  createPrivateKey,
  createPublicKey,
} from "node:crypto";
import { openSync, fstatSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import {
  checkServerIdentity,
  createSecureContext,
  type SecureContextOptions,
  type TLSSocket,
} from "node:tls";
import type { IncomingMessage } from "node:http";
import { Agent, fetch as undiciFetch } from "undici";
import { strictObject } from "./strict-json.js";

export const SERVICE_AUTH_HEADER = "Antnest-Service-Authorization";
export const SERVICES = [
  "identity-service",
  "edge-gateway",
  "admin-console",
  "agent-ui",
  "agent-controller",
  "agent-acp-service",
  "runtime-controller",
  "skill-registry",
  "runtime-egress",
  "antnest-runtime",
];
export type Fields = { name: string; value: string }[];
export type Receiver = Map<string, string>;
export type Admission = {
  code: string | null;
  http_status: number;
  caller: string | null;
  www_authenticate: string | null;
};
const unauthenticated = (): Admission => ({
  code: "service_unauthenticated",
  http_status: 401,
  caller: null,
  www_authenticate: 'Bearer realm="antnest-service"',
});

export function validateToken(value: string): boolean {
  if (!/^[A-Za-z0-9_-]{43,86}$/u.test(value)) return false;
  const bytes = Buffer.from(value, "base64url");
  return bytes.length >= 32 && bytes.length <= 64 && bytes.toString("base64url") === value;
}

export function parseReceiver(service: string, raw: Uint8Array, selfAllowed = false): Receiver {
  const config = strictObject(raw);
  if (!SERVICES.includes(service) || Object.keys(config).length > 10)
    throw new Error("invalid_configuration");
  const hashes: Receiver = new Map();
  for (const [caller, values] of Object.entries(config)) {
    if (
      !SERVICES.includes(caller) ||
      (caller === service && !selfAllowed) ||
      !Array.isArray(values) ||
      values.length < 1 ||
      values.length > 2
    )
      throw new Error("invalid_configuration");
    for (const hash of values as unknown[]) {
      if (typeof hash !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(hash) || hashes.has(hash))
        throw new Error("invalid_configuration");
      hashes.set(hash, caller);
    }
  }
  return hashes;
}

export function authenticateFields(
  receiver: Receiver,
  fields: Fields,
  allowed: readonly string[],
): Admission {
  const values = fields.filter(
    (field) => field.name.toLowerCase() === SERVICE_AUTH_HEADER.toLowerCase(),
  );
  if (values.length !== 1) return unauthenticated();
  const value = values[0]?.value;
  if (
    value === undefined ||
    !/^Bearer [A-Za-z0-9_-]+$/iu.test(value) ||
    !validateToken(value.slice(7))
  )
    return unauthenticated();
  const digest = Buffer.from(
    createHash("sha256").update(value.slice(7), "ascii").digest("hex"),
    "ascii",
  );
  let caller: string | undefined;
  for (const [hash, identity] of receiver)
    if (timingSafeEqual(digest, Buffer.from(hash.slice(7), "ascii"))) caller = identity;
  if (caller === undefined) return unauthenticated();
  return allowed.includes(caller)
    ? { code: null, http_status: 200, caller, www_authenticate: null }
    : { code: "caller_not_allowed", http_status: 403, caller, www_authenticate: null };
}

export function fields(request: IncomingMessage): Fields {
  const result: Fields = [];
  for (let i = 0; i < request.rawHeaders.length; i += 2)
    result.push({ name: request.rawHeaders[i]!, value: request.rawHeaders[i + 1]! });
  return result;
}

export function validateMode(
  mode: string | undefined,
  insecure: string | undefined,
  transport: "http" | "https",
): "token" | "mtls" {
  if (
    (mode !== "token" && mode !== "mtls") ||
    (insecure !== undefined && insecure !== "true" && insecure !== "false") ||
    (mode === "mtls" && insecure === "true") ||
    (transport === "http" && (mode !== "token" || insecure !== "true"))
  )
    throw new Error("invalid_configuration");
  return mode;
}

export function readCredential(path: string, maximum: number): Buffer {
  if (!path) throw new Error("credential_file_invalid");
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    if (!fstatSync(descriptor).isFile()) throw new Error("credential_file_invalid");
    const bytes = Buffer.alloc(maximum + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = readSync(descriptor, bytes, size, bytes.length - size, null);
      if (read === 0) break;
      size += read;
    }
    if (size > maximum) throw new Error("credential_file_invalid");
    return bytes.subarray(0, size);
  } catch {
    throw new Error("credential_file_invalid");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function certificateService(certificate: X509Certificate): string | undefined {
  const sans = certificate.subjectAltName ?? "";
  if ((sans.match(/URI:/gu) ?? []).length !== 1) return;
  const identity = /(?:^|, )URI:antnest:\/\/service\/([a-z-]+)(?=, |$)/u.exec(sans)?.[1];
  return identity !== undefined && SERVICES.includes(identity) ? identity : undefined;
}

export class ServiceAuthentication {
  public readonly serverTLS:
    (SecureContextOptions & { requestCert: boolean; rejectUnauthorized: boolean }) | undefined;
  private readonly mode: "token" | "mtls";
  private readonly receiver: Receiver;
  private readonly tokenDirectory: string;
  private readonly agents = new Set<Agent>();
  private readonly insecure: boolean;
  private readonly tls: SecureContextOptions | undefined;

  public constructor(
    env: Record<string, string | undefined>,
    public readonly service = "agent-acp-service",
  ) {
    if (!SERVICES.includes(service)) throw new Error("invalid_configuration");
    this.insecure = env.ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT === "true";
    const tlsPaths = [
      env.ANTNEST_TLS_CA_FILE,
      env.ANTNEST_TLS_CERT_FILE,
      env.ANTNEST_TLS_KEY_FILE,
      env.ANTNEST_TLS_SERVER_NAME,
    ];
    const withTLS = tlsPaths.some((value) => value !== undefined && value !== "");
    this.mode = validateMode(
      env.ANTNEST_SERVICE_AUTH_MODE,
      env.ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT,
      withTLS ? "https" : "http",
    );
    this.receiver =
      this.mode === "token"
        ? parseReceiver(service, readCredential(env.ANTNEST_SERVICE_AUTH_CALLERS_FILE ?? "", 8192))
        : new Map<string, string>();
    this.tokenDirectory = env.ANTNEST_SERVICE_AUTH_TOKEN_DIR ?? "";
    if (!withTLS) return;
    if (tlsPaths.some((path) => path === undefined || path === ""))
      throw new Error("complete_tls_configuration_required");
    const ca = readCredential(tlsPaths[0]!, 65536);
    const cert = readCredential(tlsPaths[1]!, 65536);
    const key = readCredential(tlsPaths[2]!, 8192);
    try {
      const chain = certificateChain(cert);
      const roots = certificateChain(ca);
      const leaf = chain[0]!;
      const now = Date.now();
      for (const certificate of chain)
        if (now < Date.parse(certificate.validFrom) || now >= Date.parse(certificate.validTo))
          throw new Error();
      if (
        certificateService(leaf) !== service ||
        leaf.checkHost(tlsPaths[3]!) === undefined ||
        !leaf.keyUsage.includes("1.3.6.1.5.5.7.3.1") ||
        (this.mode === "mtls" && !leaf.keyUsage.includes("1.3.6.1.5.5.7.3.2"))
      )
        throw new Error();
      for (let i = 0; i < chain.length - 1; i++) {
        const issuer = chain[i + 1]!;
        if (!issuer.ca || !chain[i]!.checkIssued(issuer) || !chain[i]!.verify(issuer.publicKey))
          throw new Error();
      }
      const last = chain.at(-1)!;
      if (
        !roots.some(
          (root) =>
            root.ca &&
            now >= Date.parse(root.validFrom) &&
            now < Date.parse(root.validTo) &&
            last.checkIssued(root) &&
            last.verify(root.publicKey),
        )
      )
        throw new Error();
      if (
        !leaf.publicKey
          .export({ type: "spki", format: "der" })
          .equals(createPublicKey(createPrivateKey(key)).export({ type: "spki", format: "der" }))
      )
        throw new Error();
      createSecureContext({ ca, cert, key, minVersion: "TLSv1.3" });
    } catch {
      throw new Error("tls_configuration_invalid");
    }
    this.tls = { ca, cert, key, minVersion: "TLSv1.3" };
    this.serverTLS = {
      ...this.tls,
      requestCert: this.mode === "mtls",
      rejectUnauthorized: this.mode === "mtls",
    };
  }

  public authenticate(request: IncomingMessage, allowed: readonly string[]): Admission {
    if (this.mode === "token") return authenticateFields(this.receiver, fields(request), allowed);
    const socket = request.socket as TLSSocket;
    if (!socket.authorized) return unauthenticated();
    let caller: string | undefined;
    try {
      caller = certificateService(new X509Certificate(socket.getPeerCertificate().raw));
    } catch {
      return unauthenticated();
    }
    if (caller === undefined) return unauthenticated();
    return allowed.includes(caller)
      ? { code: null, http_status: 200, caller, www_authenticate: null }
      : { code: "caller_not_allowed", http_status: 403, caller, www_authenticate: null };
  }

  public fetchFor(receiver: string, rawOrigin: string): typeof fetch {
    const origin = new URL(rawOrigin);
    if (
      !SERVICES.includes(receiver) ||
      receiver === this.service ||
      !["http:", "https:"].includes(origin.protocol) ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      origin.pathname !== "/" ||
      (origin.protocol === "http:" && !this.insecure) ||
      (origin.protocol === "https:" && !this.tls)
    )
      throw new Error("dependency_origin_invalid");
    if (this.mode === "token") this.outgoingToken(receiver);
    const agent = new Agent({
      connect: {
        ...this.tls,
        ...(this.mode === "token" ? { cert: undefined, key: undefined } : {}),
        checkServerIdentity: (hostname, certificate) => {
          const error = checkServerIdentity(hostname, certificate);
          if (error) return error;
          if (certificateService(new X509Certificate(certificate.raw)) !== receiver)
            return new Error("server_identity_invalid");
          return undefined;
        },
      },
    });
    this.agents.add(agent);
    return async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (
        url.origin !== origin.origin ||
        url.username ||
        url.password ||
        url.hash ||
        request.headers.has("host")
      )
        throw new Error("dependency_origin_invalid");
      request.headers.delete(SERVICE_AUTH_HEADER);
      if (this.mode === "token")
        request.headers.set(SERVICE_AUTH_HEADER, `Bearer ${this.outgoingToken(receiver)}`);
      return (await undiciFetch(url.toString(), {
        method: request.method,
        headers: Object.fromEntries(request.headers),
        signal: request.signal,
        ...(request.body === null
          ? {}
          : {
              body: request.body as unknown as NonNullable<
                NonNullable<Parameters<typeof undiciFetch>[1]>["body"]
              >,
              duplex: "half",
            }),
        redirect: "error",
        credentials: "omit",
        dispatcher: agent,
      })) as unknown as Response;
    };
  }

  public close(): Promise<void> {
    return Promise.all([...this.agents].map((agent) => agent.close())).then(() => undefined);
  }
  private outgoingToken(receiver: string): string {
    const raw = readCredential(
      join(this.tokenDirectory || "/__antnest_missing_token_directory__", receiver),
      86,
    );
    const token = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    if (!this.tokenDirectory || !validateToken(token))
      throw new Error("service_credential_invalid");
    return token;
  }
}

function certificateChain(pem: Buffer): X509Certificate[] {
  const matches = pem
    .toString("ascii")
    .match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu);
  if (!matches?.length) throw new Error("tls_configuration_invalid");
  return matches.map((part) => new X509Certificate(part));
}
