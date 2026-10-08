import { createHash, timingSafeEqual } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, fetch as undiciFetch } from "undici";
import { DomainError } from "../domain/errors.js";
import {
  parseExecutionConfiguration,
  type ExecutionConfiguration,
} from "../domain/execution-configuration.js";
import {
  runtimeConnectionIdSchema,
  runtimeMcpEndpointSchema,
  runtimeRevisionSchema,
  runtimeTokenSchema,
} from "../domain/runtime-connection.js";
import type { RuntimeBinding } from "../domain/types.js";
import type {
  PreparedRuntimeConnections,
  RuntimeCleanupFence,
  RuntimeConnectionAuthority,
} from "../ports/runtime-connections.js";

type Identity = { organizationId: string; agentId: string; revision: string; digest: Buffer };
type Entry = Identity & { connectionId: string; directory: Stats };
type Reference = { binding: RuntimeBinding; entry: Entry };
type Options = {
  authMode: string | undefined;
  allowInsecureTransport: string | undefined;
  reportCleanupFailure?: () => void;
};
const HEADER = "Antnest-Service-Authorization";
const FENCE = "X-Antnest-Expected-Execution-ID";
const ordinaryHeaders = new Set([
  "accept",
  "content-type",
  "mcp-session-id",
  "mcp-protocol-version",
  "mcp-method",
  "mcp-name",
  "last-event-id",
  "traceparent",
  "tracestate",
]);
const privateRoute =
  /^\/internal\/(?:skill-maintenance\/(?:install|digest)|skill-temporary\/(?:install|release))$/u;
const unavailable = () =>
  new DomainError("runtime_connection_unavailable", "Runtime connection is unavailable");
const conflict = () =>
  new DomainError("configuration_conflict", "Runtime connection identity cannot change");

/** Sender files exist only for this process. Memory retains hashes, never a fallback bearer. */
export class RuntimeConnections implements RuntimeConnectionAuthority {
  public readonly directory: string;
  private readonly root: Stats;
  private readonly uid = process.getuid?.();
  private readonly gid = process.getgid?.();
  private readonly dispatcher: Agent;
  private readonly identities = new Map<string, Identity>();
  private readonly entries = new Map<string, Entry>();
  private readonly references = new Map<string, Reference>();
  private readonly publications = new Map<string, Set<string>>();
  private readonly runs = new Map<string, string>();
  private readonly operations = new Map<string, string>();
  private readonly preparing = new Map<string, Set<string>>();
  private closed = false;
  private closing: Promise<void> | undefined;

  public constructor(private readonly options: Options) {
    // The native Runtime receiver currently implements HTTP token mode only.
    // Respect the exact operator opt-in rather than silently weakening mTLS.
    if (
      options.authMode !== "token" ||
      options.allowInsecureTransport !== "true" ||
      this.uid === undefined ||
      this.gid === undefined
    )
      throw new Error("Runtime transport configuration is unsupported");
    this.directory = mkdtempSync(join(tmpdir(), "antnest-acp-runtime-"));
    this.root = lstatSync(this.directory);
    this.dispatcher = new Agent();
  }

  public prepare(raw: ExecutionConfiguration): PreparedRuntimeConnections {
    if (this.closed) throw unavailable();
    const configuration = parseExecutionConfiguration(raw);
    const organizationId = configuration.organization_id;
    if (this.preparing.has(organizationId)) throw conflict();
    const reserved = new Set<string>();
    const created = new Set<string>();
    const planned = new Map<string, Reference>();
    this.preparing.set(organizationId, reserved);
    try {
      this.verifyDirectory(this.directory, this.root);
      for (const agent of configuration.agents) {
        if (!agent.accepting_runs) continue;
        const runtime = agent.runtime;
        if (
          runtime?.credential === undefined ||
          runtime.connection_id === undefined ||
          new URL(runtime.mcp_endpoint).protocol !== "http:"
        )
          throw unavailable();
        const binding: RuntimeBinding = {
          revision: runtime.runtime_revision,
          executionId: runtime.runtime_execution_id,
          mcpEndpoint: runtime.mcp_endpoint,
          connectionId: runtime.connection_id,
        };
        const digest = tokenDigest(runtime.credential.token);
        const identity: Identity = {
          organizationId,
          agentId: agent.agent_id,
          revision: binding.revision,
          digest,
        };
        const known =
          this.entries.get(binding.connectionId) ?? this.identities.get(binding.connectionId);
        if (known !== undefined && !sameIdentity(known, identity)) throw conflict();
        let entry = this.entries.get(binding.connectionId);
        if (entry === undefined) {
          const directory = join(this.directory, binding.connectionId);
          mkdirSync(directory, { mode: 0o700 });
          // Register ownership before writing so failure rolls back the candidate directory.
          created.add(binding.connectionId);
          entry = {
            ...identity,
            connectionId: binding.connectionId,
            directory: lstatSync(directory),
          };
          this.entries.set(binding.connectionId, entry);
          writeFileSync(join(directory, "antnest-runtime"), runtime.credential.token, {
            flag: "wx",
            mode: 0o600,
          });
        }
        this.readToken(entry);
        reserved.add(binding.connectionId);
        const key = referenceKey(binding);
        if (planned.has(key)) throw conflict();
        planned.set(key, { binding, entry });
      }
      // A verified issuer identity cannot acquire different bytes on retry,
      // even when storage or downstream publication subsequently fails.
      for (const reference of planned.values())
        this.identities.set(reference.entry.connectionId, identityOf(reference.entry));
    } catch (error) {
      this.preparing.delete(organizationId);
      for (const id of created) this.removeEntry(id);
      throw error instanceof DomainError ? error : unavailable();
    }
    let finished = false;
    return {
      commit: () => {
        if (finished || this.closed) throw unavailable();
        // Recheck all files before changing any usable connection.
        for (const reference of planned.values()) this.readToken(reference.entry);
        for (const [key, reference] of planned) {
          this.references.set(key, reference);
          this.identities.set(reference.entry.connectionId, identityOf(reference.entry));
        }
        this.publications.set(organizationId, new Set(planned.keys()));
        this.preparing.delete(organizationId);
        finished = true;
        this.collect();
      },
      rollback: () => {
        if (finished) return;
        finished = true;
        this.preparing.delete(organizationId);
        for (const id of created) this.removeEntry(id);
      },
    };
  }

  public revokePublication(organizationId: string): void {
    this.publications.delete(organizationId);
    this.collect();
  }

  public findForCleanup(fence: RuntimeCleanupFence): RuntimeBinding | null {
    if (this.closed) return null;
    for (const [key, reference] of this.references) {
      const { binding, entry } = reference;
      if (
        entry.organizationId === fence.organizationId &&
        entry.agentId === fence.agentId &&
        binding.revision === fence.revision &&
        binding.executionId === fence.executionId &&
        binding.mcpEndpoint === fence.mcpEndpoint &&
        (fence.connectionId === undefined || binding.connectionId === fence.connectionId) &&
        (this.retained(key) || this.publications.get(fence.organizationId)?.has(key))
      )
        return structuredClone(binding);
    }
    return null;
  }

  public retainRun(runId: string, binding: RuntimeBinding): void {
    const key = referenceKey(binding);
    const existing = this.runs.get(runId);
    if (existing !== undefined && existing !== key) throw conflict();
    if (
      existing === undefined &&
      ![...this.publications.values()].some((references) => references.has(key))
    )
      throw unavailable();
    const reference = this.authorized(binding);
    this.readToken(reference.entry);
    this.runs.set(runId, key);
  }

  public releaseRun(runId: string): void {
    this.runs.delete(runId);
    this.collect();
  }

  public retainOperation(
    operationId: string,
    binding: RuntimeBinding,
    options?: { cleanup: true },
  ): void {
    const key = referenceKey(binding);
    const existing = this.operations.get(operationId);
    if (existing !== undefined && existing !== key) throw conflict();
    if (
      existing === undefined &&
      options?.cleanup !== true &&
      ![...this.publications.values()].some((references) => references.has(key))
    )
      throw unavailable();
    const reference = this.authorized(binding);
    this.readToken(reference.entry);
    this.operations.set(operationId, key);
  }

  public releaseOperation(operationId: string): void {
    this.operations.delete(operationId);
    this.collect();
  }

  public fetchFor(rawBinding: RuntimeBinding): typeof fetch {
    const binding = structuredClone(rawBinding);
    this.authorized(binding);
    return async (input, init) => {
      const reference = this.authorized(binding);
      let request: Request;
      let url: URL;
      let headers: Headers;
      try {
        const rawUrl = input instanceof Request ? input.url : String(input);
        url = new URL(rawUrl);
        const origin = new URL(binding.mcpEndpoint).origin;
        if (
          url.href !== rawUrl ||
          url.origin !== origin ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          (url.pathname !== "/mcp" &&
            url.pathname !== "/status" &&
            !privateRoute.test(url.pathname))
        )
          throw unavailable();
        request = new Request(input, { ...init, duplex: "half" } as RequestInit);
        if (request.headers.has("host")) throw unavailable();
        headers = new Headers();
        for (const [name, value] of request.headers) {
          if (ordinaryHeaders.has(name)) headers.set(name, value);
          if (
            name === "authorization" &&
            privateRoute.test(url.pathname) &&
            /^AntnestMaintenance [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(value)
          )
            headers.set(name, value);
        }
        headers.set(FENCE, binding.executionId);
        if (headers.get(FENCE) !== binding.executionId) throw unavailable();
      } catch {
        throw unavailable();
      }
      headers.set(HEADER, "Bearer " + this.readToken(reference.entry));
      // An explicit plain dispatcher bypasses environment proxy configuration.
      // The MCP endpoint supplies the trusted origin, never a model/tool target.
      return (await undiciFetch(url.toString(), {
        method: request.method,
        headers: Object.fromEntries(headers),
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
        dispatcher: this.dispatcher,
      })) as unknown as Response;
    };
  }

  public close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      try {
        await this.dispatcher.destroy();
      } finally {
        this.entries.clear();
        this.references.clear();
        this.publications.clear();
        this.runs.clear();
        this.operations.clear();
        this.preparing.clear();
        this.identities.clear();
        rmSync(this.directory, { recursive: true, force: true });
      }
    })();
    return this.closing;
  }

  private authorized(binding: RuntimeBinding): Reference {
    if (
      this.closed ||
      !runtimeConnectionIdSchema.safeParse(binding.connectionId).success ||
      !runtimeRevisionSchema.safeParse(binding.revision).success ||
      !runtimeMcpEndpointSchema.safeParse(binding.mcpEndpoint).success
    )
      throw unavailable();
    const key = referenceKey(binding);
    const reference = this.references.get(key);
    if (
      reference === undefined ||
      (!this.retained(key) &&
        ![...this.publications.values()].some((references) => references.has(key)))
    )
      throw unavailable();
    return reference;
  }

  private retained(key: string): boolean {
    return [...this.runs.values(), ...this.operations.values()].includes(key);
  }

  private verifyDirectory(path: string, expected: Stats): void {
    const stat = lstatSync(path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== this.uid ||
      stat.gid !== this.gid ||
      (stat.mode & 0o7777) !== 0o700 ||
      stat.dev !== expected.dev ||
      stat.ino !== expected.ino
    )
      throw unavailable();
  }

  private readToken(entry: Entry): string {
    let descriptor: number | undefined;
    try {
      this.verifyDirectory(this.directory, this.root);
      const directory = join(this.directory, entry.connectionId);
      this.verifyDirectory(directory, entry.directory);
      descriptor = openSync(
        join(directory, "antnest-runtime"),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const stat = fstatSync(descriptor);
      if (
        !stat.isFile() ||
        stat.uid !== this.uid ||
        stat.gid !== this.gid ||
        stat.nlink !== 1 ||
        (stat.mode & 0o7777) !== 0o600 ||
        stat.size < 43 ||
        stat.size > 86
      )
        throw unavailable();
      const bytes = Buffer.alloc(87);
      let size = 0;
      while (size < bytes.length) {
        const read = readSync(descriptor, bytes, size, bytes.length - size, null);
        if (read === 0) break;
        size += read;
      }
      const token = bytes.subarray(0, size).toString("utf8");
      if (
        size > 86 ||
        !runtimeTokenSchema.safeParse(token).success ||
        !timingSafeEqual(tokenDigest(token), entry.digest)
      )
        throw unavailable();
      return token;
    } catch {
      throw unavailable();
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  private collect(): void {
    const retained = new Set([...this.publications.values()].flatMap((keys) => [...keys]));
    for (const key of this.runs.values()) retained.add(key);
    for (const key of this.operations.values()) retained.add(key);
    for (const key of this.references.keys()) if (!retained.has(key)) this.references.delete(key);
    const used = new Set(
      [...this.references.values()].map((reference) => reference.entry.connectionId),
    );
    for (const ids of this.preparing.values()) for (const id of ids) used.add(id);
    for (const id of this.entries.keys()) if (!used.has(id)) this.removeEntry(id);
  }

  private removeEntry(id: string): void {
    try {
      rmSync(join(this.directory, id), { recursive: true, force: true });
      this.entries.delete(id);
    } catch {
      // Preserve ownership for another cleanup attempt; never report a sensitive path.
      this.options.reportCleanupFailure?.();
    }
  }
}

function referenceKey(binding: RuntimeBinding): string {
  return JSON.stringify([
    binding.connectionId,
    binding.revision,
    binding.executionId,
    binding.mcpEndpoint,
  ]);
}
function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token, "ascii").digest();
}
function sameIdentity(a: Identity, b: Identity): boolean {
  return (
    a.organizationId === b.organizationId &&
    a.agentId === b.agentId &&
    a.revision === b.revision &&
    timingSafeEqual(a.digest, b.digest)
  );
}
function identityOf(entry: Entry): Identity {
  return {
    organizationId: entry.organizationId,
    agentId: entry.agentId,
    revision: entry.revision,
    digest: entry.digest,
  };
}
