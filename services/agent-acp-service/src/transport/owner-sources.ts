import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { finished } from "node:stream/promises";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { fields } from "../adapters/service-authentication.js";
import { strictObject } from "../adapters/strict-json.js";
import {
  controlBodyDigest,
  encodeOwnerControl,
  parseOwnerControl,
  type OwnerControlRequest,
} from "../application/owner-control-forwarding.js";
import { OWNER_FORWARD_HEADER } from "../application/owner-forwarding.js";
import type { SkillSources, SourceReadAuthority } from "../application/skill-sources.js";
import { DomainError } from "../domain/errors.js";
import {
  isExecutionAccessRevoked,
  type ExecutionAccessSnapshot,
  type ExecutionIdentity,
} from "../domain/execution-configuration.js";
import {
  SkillSourceError,
  skillProjectionSchema,
  type SkillProjection,
  type SkillSourceRecord,
} from "../domain/skill-source.js";
import { finishResponse, writeStateChunk } from "./agent-execution-state.js";
import { OWNER_CONTROL_PATHS } from "./owner-control.js";
import type { HttpOwnerForwardingOptions } from "./owner-http.js";
import type { RequestAuthentication } from "./request-authentication.js";
import { serveSkillSource, sourceFailure, type SourceOperation } from "./skill-sources.js";

type SourceContext = Extract<
  OwnerControlRequest,
  { operation: "source-inspect" | "source-artifact" }
>;
type Reply = { status: number; headers: Headers; bytes: Buffer };
type Original = {
  identities: readonly ExecutionIdentity[];
  cancellation: AbortController;
  joined: PromiseWithResolvers<void>;
};
const inspected = z.strictObject({ items: z.array(skillProjectionSchema).max(50) });
const sourceError = z.strictObject({
  error: z.strictObject({ code: z.string().min(1).max(100), message: z.string().max(1024) }),
});
const copiedHeaders = [
  "content-type",
  "content-length",
  "cache-control",
  "etag",
  "x-antnest-artifact-digest",
  "x-antnest-content-digest",
  "x-antnest-source-sequence",
  "retry-after",
  "www-authenticate",
];
// Fifty legal descriptions can expand sixfold when JSON escapes control bytes.
// ACP ZIP artifacts contain one <=16KiB SKILL.md and retain a separate bound.
const maximumInspectBytes = 256 * 1024;
const maximumArtifactBytes = 64 * 1024;
const unavailable = () => new SkillSourceError("source_unavailable");
const cancelled = (error: unknown, signal: AbortSignal) =>
  signal.aborted &&
  (error === signal.reason ||
    (error instanceof Error &&
      (error.name === "AbortError" || ("code" in error && error.code === "ABORT_ERR"))));
function sourceCancellation(error: unknown, signal: AbortSignal): boolean {
  if (cancelled(error, signal)) return true;
  return (
    error instanceof SkillSourceError &&
    error.cause !== undefined &&
    sourceCancellation(error.cause, signal)
  );
}
class SourceCleanupError extends AggregateError {}
class PeerSourceError extends Error {
  public constructor(public readonly reply: Reply) {
    super("Owner source request failed");
  }
}

/** Finite Registry reads retain the original actor scopes, owner and read gates. */
export class OwnerSourceTransport {
  private readonly originals = new Set<Original>();
  private readonly failures: Array<{ identities: readonly ExecutionIdentity[]; error: unknown }> =
    [];
  private closing: Promise<void> | undefined;

  public constructor(
    private readonly options: Omit<HttpOwnerForwardingOptions, "handles"> & {
      service: Pick<SkillSources, "inspect" | "artifact"> | undefined;
      authentication: RequestAuthentication;
      ready(): Promise<boolean>;
      report(error: unknown): void;
    },
  ) {}

  public revokeAccess(snapshot: ExecutionAccessSnapshot): Promise<void> {
    return this.interrupt((identity) => isExecutionAccessRevoked(snapshot, identity));
  }
  public close(): Promise<void> {
    return (this.closing ??= this.interrupt(() => true));
  }
  private async interrupt(matches: (identity: ExecutionIdentity) => boolean): Promise<void> {
    const originals = [...this.originals].filter((original) => original.identities.some(matches));
    for (const original of originals) original.cancellation.abort();
    await Promise.all(originals.map((original) => original.joined.promise));
    const failures = this.failures
      .filter((failure) => failure.identities.some(matches))
      .map((failure) => failure.error);
    if (failures.length) throw new AggregateError(failures, "Owner source cleanup failed");
  }

  public async forward(
    request: IncomingMessage,
    response: ServerResponse,
    operation: SourceOperation,
    signal: AbortSignal,
    deadline: number,
  ): Promise<boolean> {
    const resolve = this.options.resolver.resolveSource;
    if (resolve === undefined) return false;
    const agentIds =
      operation.route === "inspect"
        ? operation.input.sources.map((source) => source.agent_id)
        : [operation.input.skill_ref.agent_id];
    const identities = [...new Set(agentIds)].map((agentId) => ({
      organizationId: operation.input.organization_id,
      principalId: operation.input.actor_id,
      agentId,
    }));
    await this.own(request, response, identities, signal, async (lifetime) => {
      if (operation.route === "artifact") {
        const reply = await this.part(operation, identities[0]!, lifetime, deadline);
        await this.send(response, reply, lifetime);
        return;
      }
      const values = new Map<string, SkillProjection>();
      // Sequential groups share the same deadline and have no unjoined sibling
      // work on failure. Headers are sent only after every group succeeds.
      for (const identity of identities) {
        const sources = operation.input.sources.filter(
          (source) => source.agent_id === identity.agentId,
        );
        const group: SourceOperation = { route: "inspect", input: { ...operation.input, sources } };
        const reply = await this.part(group, identity, lifetime, deadline);
        const result = inspected.parse(strictObject(reply.bytes));
        for (const item of result.items) {
          const key = `${item.agent_id}/${item.name}`;
          if (
            item.organization_id !== identity.organizationId ||
            item.owner_id !== identity.principalId ||
            item.agent_id !== identity.agentId ||
            !item.active ||
            !sources.some((source) => source.name === item.name) ||
            values.has(key)
          )
            throw unavailable();
          values.set(key, item);
        }
      }
      const items = operation.input.sources.flatMap((source) => {
        const item = values.get(`${source.agent_id}/${source.name}`);
        return item === undefined ? [] : [item];
      });
      await this.send(response, this.json({ items }), lifetime);
    });
    return true;
  }

  private async part(
    operation: SourceOperation,
    identity: ExecutionIdentity,
    signal: AbortSignal,
    deadline: number,
  ): Promise<Reply> {
    signal.throwIfAborted();
    if (Date.now() >= deadline) throw unavailable();
    let resolved: Awaited<
      ReturnType<NonNullable<HttpOwnerForwardingOptions["resolver"]["resolveSource"]>>
    >;
    try {
      resolved = await this.options.resolver.resolveSource!(identity, deadline, signal);
    } catch (error) {
      if (error instanceof DomainError && error.code === "access_denied") {
        if (operation.route === "inspect") return this.json({ items: [] });
        throw new SkillSourceError("not_found");
      }
      throw error;
    }
    signal.throwIfAborted();
    if (Date.now() >= deadline) throw unavailable();
    const target: SourceContext = {
      operation: operation.route === "inspect" ? "source-inspect" : "source-artifact",
      caller: "skill-registry",
      request_id: resolved.request_id,
      deadline_at: new Date(deadline).toISOString(),
      membership_sha256: resolved.membership_sha256,
      source: resolved.source,
      target: resolved.target,
      publication: resolved.publication,
      identity,
      epoch: resolved.epoch,
      body_sha256: controlBodyDigest(operation.input),
      hop: 1,
    };
    if (target.target.member_id === this.options.registration.member_id) {
      const authority = await this.options.admit(target, signal);
      const reply = await this.local(operation, signal, authority);
      if (Date.now() >= deadline) throw unavailable();
      return reply;
    }
    const reply = await this.readPeer(target, operation, signal);
    if (reply.status !== 200) throw new PeerSourceError(reply);
    return reply;
  }

  public async handlePeer(
    request: IncomingMessage,
    response: ServerResponse,
    member: string,
    signal: AbortSignal,
    admitted: () => void,
  ): Promise<void> {
    try {
      const headers = fields(request).filter(
        (field) => field.name.toLowerCase() === OWNER_FORWARD_HEADER.toLowerCase(),
      );
      if (headers.length !== 1) throw unavailable();
      const target = parseOwnerControl(headers[0]!.value);
      if (
        (target.operation !== "source-inspect" && target.operation !== "source-artifact") ||
        request.method !== "POST" ||
        request.url !== OWNER_CONTROL_PATHS[target.operation] ||
        target.source.member_id !== member ||
        target.membership_sha256 !== this.options.peers.membership.sha256 ||
        !isDeepStrictEqual(target.target, this.options.registration)
      )
        throw unavailable();
      await this.own(request, response, [target.identity], signal, async (lifetime) => {
        const route = target.operation === "source-inspect" ? "inspect" : "artifact";
        const deadline = Date.parse(target.deadline_at);
        if (deadline <= Date.now() || deadline - Date.now() > 8500) throw unavailable();
        request.url = `/internal/skill-sources/${route}`;
        const authentication = await this.options.authentication.admitPeer(
          request,
          "skill-registry",
          false,
        );
        lifetime.throwIfAborted();
        if ("status" in authentication) throw unavailable();
        const invoke = async (operation: SourceOperation, current: AbortSignal) => {
          const identity = target.identity;
          const ids =
            operation.route === "inspect"
              ? operation.input.sources.map((key) => key.agent_id)
              : [operation.input.skill_ref.agent_id];
          if (
            controlBodyDigest(operation.input) !== target.body_sha256 ||
            operation.input.organization_id !== identity.organizationId ||
            operation.input.actor_id !== identity.principalId ||
            ids.some((id) => id !== identity.agentId)
          )
            throw unavailable();
          const authority = await this.options.admit(target, current);
          authority.assertCurrent();
          admitted();
          const service = this.options.service;
          if (service === undefined) throw unavailable();
          const bounded = AbortSignal.any([current, authority.signal]);
          try {
            const value =
              operation.route === "inspect"
                ? await service.inspect(operation.input, bounded, authority)
                : await service.artifact(operation.input, bounded, authority);
            bounded.throwIfAborted();
            authority.assertCurrent();
            return value;
          } catch (error) {
            // The public route maps failures to JSON. Retain an independent
            // late failure before that mapping so retirement cannot ACK it.
            this.retainLateFailure([identity], error, bounded);
            throw error;
          }
        };
        await serveSkillSource(
          request,
          response,
          route,
          {
            service: {
              inspect: (input, current) =>
                invoke({ route: "inspect", input }, current) as ReturnType<SkillSources["inspect"]>,
              artifact: (input, current) =>
                invoke({ route: "artifact", input }, current) as ReturnType<
                  SkillSources["artifact"]
                >,
            },
          },
          () => this.options.ready(),
          undefined,
          { signal: lifetime, deadline },
        );
      });
    } catch (error) {
      this.options.report(error);
      sourceFailure(response, error);
    }
  }

  private async local(
    operation: SourceOperation,
    signal: AbortSignal,
    authority: SourceReadAuthority,
  ): Promise<Reply> {
    const service = this.options.service;
    if (service === undefined) throw unavailable();
    authority.assertCurrent();
    const lifetime = AbortSignal.any([signal, authority.signal]);
    try {
      const reply =
        operation.route === "inspect"
          ? this.json(await service.inspect(operation.input, lifetime, authority))
          : this.artifact(await service.artifact(operation.input, lifetime, authority));
      lifetime.throwIfAborted();
      authority.assertCurrent();
      return reply;
    } catch (error) {
      this.retainLateFailure(
        [
          {
            organizationId: operation.input.organization_id,
            principalId: operation.input.actor_id,
            agentId: authority.fence.agentId,
          },
        ],
        error,
        lifetime,
      );
      throw error;
    }
  }
  private retainLateFailure(
    identities: readonly ExecutionIdentity[],
    error: unknown,
    signal: AbortSignal,
  ): void {
    if (signal.aborted && !sourceCancellation(error, signal))
      this.failures.push({ identities, error });
  }
  private json(value: unknown): Reply {
    return {
      status: 200,
      bytes: Buffer.from(JSON.stringify(value)),
      headers: new Headers({ "content-type": "application/json", "cache-control": "no-store" }),
    };
  }
  private artifact(value: SkillSourceRecord): Reply {
    return {
      status: 200,
      bytes: value.package.artifact,
      headers: new Headers({
        "content-type": "application/zip",
        "cache-control": "no-store",
        "content-length": String(value.package.artifact.length),
        etag: `"${value.package.artifactDigest}"`,
        "x-antnest-artifact-digest": value.package.artifactDigest,
        "x-antnest-content-digest": value.projection.content_digest,
        "x-antnest-source-sequence": String(value.projection.sequence),
      }),
    };
  }

  private async readPeer(
    target: SourceContext,
    operation: SourceOperation,
    signal: AbortSignal,
  ): Promise<Reply> {
    const member = this.options.peers.membership.members.find(
      (candidate) => candidate.member_id === target.target.member_id,
    );
    if (member === undefined) throw unavailable();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let reading: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
    let closed: Promise<void> | undefined;
    let cancelling: Promise<void> | undefined;
    let primary: unknown;
    let failed = false;
    let cleanupFailure: SourceCleanupError | undefined;
    let reply: Reply | undefined;
    const cancel = () => {
      if (reader !== undefined) {
        cancelling ??= Promise.resolve().then(() => reader!.cancel());
        void cancelling.catch(() => undefined);
      }
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      signal.throwIfAborted();
      const response = await this.options.peers.fetchFor(member.member_id)(
        new URL(OWNER_CONTROL_PATHS[target.operation], member.origin),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [OWNER_FORWARD_HEADER]: encodeOwnerControl(target),
          },
          body: JSON.stringify(operation.input),
          signal,
          redirect: "error",
        },
      );
      if (response.body !== null) {
        reader = response.body.getReader();
        closed = reader.closed;
        void closed.catch(() => undefined);
      }
      signal.throwIfAborted();
      if (
        reader === undefined ||
        (response.status !== 200 && (response.status < 400 || response.status > 599))
      )
        throw unavailable();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        reading = reader.read();
        const next = await reading;
        reading = undefined;
        signal.throwIfAborted();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > (operation.route === "inspect" ? maximumInspectBytes : maximumArtifactBytes))
          throw unavailable();
        chunks.push(next.value);
      }
      reply = { status: response.status, headers: response.headers, bytes: Buffer.concat(chunks) };
      if (reply.status !== 200 || operation.route === "inspect") {
        if (!/^application\/json(?:\s*;|$)/iu.test(reply.headers.get("content-type") ?? ""))
          throw unavailable();
        if (reply.status !== 200) sourceError.parse(strictObject(reply.bytes));
        else inspected.parse(strictObject(reply.bytes));
      } else {
        const digest = "sha256:" + createHash("sha256").update(reply.bytes).digest("hex");
        if (
          reply.headers.get("content-type") !== "application/zip" ||
          reply.headers.get("content-length") !== String(reply.bytes.length) ||
          reply.headers.get("etag") !== `"${digest}"` ||
          reply.headers.get("x-antnest-artifact-digest") !== digest ||
          reply.headers.get("x-antnest-content-digest") !== operation.input.expected_digest ||
          reply.headers.get("x-antnest-source-sequence") !==
            String(operation.input.skill_ref.sequence)
        )
          throw unavailable();
      }
    } catch (error) {
      primary = error;
      failed = true;
    } finally {
      cancel();
      const joined = await Promise.allSettled([reading, closed, cancelling]);
      signal.removeEventListener("abort", cancel);
      const errors = [
        ...new Set(
          joined.flatMap((value) =>
            value.status === "rejected" &&
            !(failed && value.reason === primary) &&
            !cancelled(value.reason, signal)
              ? [value.reason as unknown]
              : [],
          ),
        ),
      ];
      try {
        reader?.releaseLock();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length)
        cleanupFailure = new SourceCleanupError(
          failed ? [primary, ...errors] : errors,
          "Original source reader cleanup failed",
        );
    }
    if (cleanupFailure !== undefined) throw cleanupFailure;
    if (failed) throw primary;
    signal.throwIfAborted();
    if (reply === undefined || Date.now() >= Date.parse(target.deadline_at)) throw unavailable();
    return reply;
  }

  private async send(response: ServerResponse, reply: Reply, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    for (const name of copiedHeaders) {
      const value = reply.headers.get(name);
      if (value !== null) response.setHeader(name, value);
    }
    response.writeHead(reply.status);
    await writeStateChunk(response, reply.bytes, signal);
    await finishResponse(response, signal);
  }

  private async own(
    request: IncomingMessage,
    response: ServerResponse,
    identities: readonly ExecutionIdentity[],
    parent: AbortSignal,
    operation: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    const original: Original = {
      identities,
      cancellation: new AbortController(),
      joined: Promise.withResolvers<void>(),
    };
    this.originals.add(original);
    const signal = AbortSignal.any([parent, original.cancellation.signal]);
    const disconnected = () => {
      if (!response.writableFinished) original.cancellation.abort();
    };
    const interrupt = () => response.destroy();
    request.once("aborted", disconnected);
    response.once("close", disconnected);
    signal.addEventListener("abort", interrupt, { once: true });
    try {
      signal.throwIfAborted();
      if (this.closing !== undefined) throw unavailable();
      await operation(signal);
    } catch (error) {
      this.options.report(error);
      if (error instanceof SourceCleanupError) this.failures.push({ identities, error });
      if (error instanceof PeerSourceError && !signal.aborted)
        await this.send(response, error.reply, signal);
      else sourceFailure(response, error);
    } finally {
      if (!response.writableEnded && !response.destroyed) response.destroy();
      const sent = await Promise.allSettled([finished(response, { cleanup: true })]);
      if (!request.readableEnded) request.destroy();
      const received = await Promise.allSettled([finished(request, { cleanup: true })]);
      const errors = [...sent, ...received].flatMap((value) =>
        value.status === "rejected" &&
        !cancelled(value.reason, signal) &&
        !(
          value.reason instanceof Error &&
          "code" in value.reason &&
          value.reason.code === "ERR_STREAM_PREMATURE_CLOSE"
        )
          ? [value.reason as unknown]
          : [],
      );
      if (errors.length)
        this.failures.push({
          identities,
          error: new SourceCleanupError(errors, "Original source HTTP cleanup failed"),
        });
      signal.removeEventListener("abort", interrupt);
      request.off("aborted", disconnected);
      response.off("close", disconnected);
      this.originals.delete(original);
      original.joined.resolve();
    }
  }
}
