import { isDeepStrictEqual } from "node:util";
import { DomainError } from "../domain/errors.js";
import {
  parsePeerIdentityRequest,
  parsePeerPublicationRequest,
  peerDeadline,
} from "../application/peer-request.js";
import { parsePeerIdentityReceipt, parsePeerPublicationReceipt } from "../domain/peer-receipt.js";
import type {
  AgentPeers,
  PeerIdentityRequest,
  PeerPublicationRequest,
} from "../ports/agent-peers.js";
import type { PeerAuthentication } from "./peer-authentication.js";
import { strictObject } from "./strict-json.js";

const media = /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/iu;
const unavailable = () =>
  new DomainError("configuration_unavailable", "Peer HTTP operation failed");

export class HttpAgentPeers implements AgentPeers {
  private readonly bindings = new Map<string, { origin: string; send: typeof fetch }>();

  public constructor(
    private readonly authentication: Pick<
      PeerAuthentication,
      "memberId" | "membership" | "fetchFor"
    >,
  ) {
    for (const member of authentication.membership.members) {
      if (member.member_id !== authentication.memberId)
        this.bindings.set(member.member_id, {
          origin: member.origin,
          send: authentication.fetchFor(member.member_id),
        });
    }
  }

  public identify(
    memberId: string,
    input: PeerIdentityRequest,
    signal: AbortSignal,
  ): Promise<unknown> {
    return this.request("identity", memberId, input, signal);
  }

  public publish(
    memberId: string,
    input: PeerPublicationRequest,
    signal: AbortSignal,
  ): Promise<unknown> {
    return this.request("publication", memberId, input, signal);
  }

  private async request(
    operation: "identity" | "publication",
    memberId: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    const request =
      operation === "identity"
        ? parsePeerIdentityRequest(input)
        : parsePeerPublicationRequest(input);
    const target = "target" in request ? request.target.member_id : request.target_member_id;
    const binding = this.bindings.get(memberId);
    if (
      binding === undefined ||
      target !== memberId ||
      request.source.member_id !== this.authentication.memberId ||
      request.membership_sha256 !== this.authentication.membership.sha256
    )
      throw unavailable();
    const expiresAt = peerDeadline(request.deadline_at);
    const remaining = expiresAt - Date.now();
    if (remaining > 10000) throw new DomainError("invalid_request", "Invalid peer deadline");
    if (remaining <= 0)
      throw new DomainError("deadline_exceeded", "Peer request deadline exceeded");
    signal.throwIfAborted();
    const body = JSON.stringify(request);
    if (Buffer.byteLength(body) > 16384)
      throw new DomainError("invalid_request", "Peer request is too large");
    const path =
      operation === "identity"
        ? "/internal/acp-peer/identity"
        : "/internal/acp-peer/publications/apply";
    const maximum = operation === "identity" ? 8192 : 16 * 1024 * 1024;
    const controller = new AbortController();
    const lifetime = AbortSignal.any([signal, controller.signal]);
    const completion = { timedOut: false };
    const timer = setTimeout(() => {
      completion.timedOut = true;
      controller.abort();
    }, remaining);
    timer.unref();
    const failures: unknown[] = [];
    const failed = (error: unknown) => {
      if (!failures.includes(error)) failures.push(error);
    };
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let reading: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
    let cancelling: Promise<void> | undefined;
    let closed: Promise<void> | undefined;
    let result: unknown;
    const cancel = () => {
      if (reader === undefined || cancelling !== undefined) return;
      try {
        cancelling = reader.cancel().catch(failed);
      } catch (error) {
        failed(error);
        cancelling = Promise.resolve();
      }
    };
    lifetime.addEventListener("abort", cancel, { once: true });
    try {
      lifetime.throwIfAborted();
      const response = await binding.send(new URL(path, binding.origin).toString(), {
        method: "POST",
        body,
        signal: lifetime,
        redirect: "error",
        cache: "no-store",
        credentials: "omit",
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
      if (response.body !== null) {
        reader = response.body.getReader();
        closed = reader.closed.catch(failed);
      }
      lifetime.throwIfAborted();
      if (
        response.status !== 200 ||
        !media.test(response.headers.get("content-type") ?? "") ||
        reader === undefined
      )
        throw unavailable();
      const length = response.headers.get("content-length");
      if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maximum))
        throw unavailable();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        reading = reader.read();
        const chunk = await reading;
        reading = undefined;
        lifetime.throwIfAborted();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > maximum) throw unavailable();
        chunks.push(chunk.value);
      }
      const raw = strictObject(Buffer.concat(chunks));
      if ("challenge" in request) {
        const receipt = parsePeerIdentityReceipt(raw);
        if (
          receipt.request_id !== request.request_id ||
          receipt.membership_sha256 !== request.membership_sha256 ||
          receipt.challenge !== request.challenge ||
          receipt.registration.member_id !== memberId
        )
          throw unavailable();
        result = receipt;
      } else {
        const receipt = parsePeerPublicationReceipt(raw);
        if (
          receipt.request_id !== request.request_id ||
          receipt.membership_sha256 !== request.membership_sha256 ||
          !isDeepStrictEqual(receipt.registration, request.target) ||
          !isDeepStrictEqual(receipt.publication, request.publication)
        )
          throw unavailable();
        result = receipt;
      }
    } catch (error) {
      failed(error);
    } finally {
      controller.abort();
      cancel();
      // Own the original fetch, read and cancellation; a timeout is not a cleanup receipt.
      if (reading !== undefined) await reading.catch(failed);
      if (cancelling !== undefined) await cancelling;
      if (closed !== undefined) await closed;
      if (reader !== undefined) {
        try {
          reader.releaseLock();
        } catch (error) {
          failed(error);
        }
      }
      lifetime.removeEventListener("abort", cancel);
      clearTimeout(timer);
    }
    const expired = signal.aborted || completion.timedOut || Date.now() >= expiresAt;
    if (failures.length > 0 || result === undefined || expired) {
      const error = expired
        ? new DomainError("deadline_exceeded", "Peer request deadline exceeded")
        : unavailable();
      if (failures.length > 0)
        error.cause = new AggregateError(failures, "Peer HTTP operation and cleanup failed");
      throw error;
    }
    return result;
  }
}
