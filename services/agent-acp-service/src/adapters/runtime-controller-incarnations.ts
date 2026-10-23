import {
  OwnerIncarnationError,
  parseOwnerRegistration,
  type OwnerRegistration,
  type OwnerRegistrationRequest,
} from "../application/owner-incarnation.js";
import { parseOwnerInspection, type OwnerInspection } from "../application/owner-inspection.js";
import type { ServiceAuthentication } from "./service-authentication.js";
import { strictObject } from "./strict-json.js";

const MAX_REQUEST_BYTES = 4 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024;
const MAX_TIMEOUT_MS = 10_000;
const JSON_MEDIA = /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/iu;

type Options = {
  origin: string;
  authentication: ServiceAuthentication;
  timeoutMs?: number;
};

export class OwnerRegistrationAttemptError extends OwnerIncarnationError {
  public constructor(
    public readonly retryable: boolean,
    public readonly cleanupFailed = false,
  ) {
    super("acp_registration_unavailable");
  }
}

export class OwnerInspectionAttemptError extends OwnerIncarnationError {
  public constructor(
    public readonly retryable: boolean,
    public readonly cleanupFailed = false,
  ) {
    super("acp_registry_unavailable");
  }
}

export class RuntimeControllerIncarnations {
  private readonly endpoint: string;
  private readonly send: typeof fetch;
  private readonly timeoutMs: number;

  public constructor(options: Options) {
    try {
      const timeoutMs = options.timeoutMs === undefined ? MAX_TIMEOUT_MS : options.timeoutMs;
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS)
        throw new Error();
      const origin = new URL(options.origin);
      if (
        !["http:", "https:"].includes(origin.protocol) ||
        !origin.hostname ||
        origin.username ||
        origin.password ||
        origin.search ||
        origin.hash ||
        origin.pathname !== "/"
      )
        throw new Error();
      this.endpoint = new URL("/internal/acp-incarnations/register", origin).toString();
      this.send = options.authentication.fetchFor("runtime-controller", origin.origin);
      this.timeoutMs = timeoutMs;
    } catch {
      throw new Error("acp_incarnation_client_configuration_invalid");
    }
  }

  public async register(
    input: OwnerRegistrationRequest,
    signal: AbortSignal,
  ): Promise<OwnerRegistration> {
    return this.exchange("register", signal, () => {
      const original = registrationRequest(input);
      return {
        endpoint: this.endpoint,
        method: "POST",
        body: JSON.stringify(original),
        parse: (value) => {
          const receipt = parseOwnerRegistration(value);
          if (
            receipt.member_id !== original.member_id ||
            receipt.incarnation_id !== original.incarnation_id
          )
            throw new OwnerIncarnationError("acp_registration_unavailable");
          return receipt;
        },
      };
    });
  }

  public async inspect(expected: OwnerRegistration, signal: AbortSignal): Promise<OwnerInspection> {
    return this.exchange("inspect", signal, () => {
      const original = parseOwnerRegistration(expected);
      return {
        endpoint: new URL(original.registration_id, this.endpoint).toString(),
        method: "GET",
        parse: (value) => parseOwnerInspection(value, original),
      };
    });
  }

  private async exchange<T>(
    operation: "register" | "inspect",
    signal: AbortSignal,
    prepare: () => {
      endpoint: string;
      method: "POST" | "GET";
      body?: string;
      parse(value: Record<string, unknown>): T;
    },
  ): Promise<T> {
    const controller = new AbortController();
    const requestSignal = AbortSignal.any([signal, controller.signal]);
    const completion = { timedOut: false, bodyFailed: false, cancellationFailed: false };
    let failed = false;
    let cleanupFailed = false;
    let rejected = false;
    let result: T | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let reading: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
    let cancelling: Promise<void> | undefined;
    let bodyClosed: Promise<void> | undefined;
    let bodyError: unknown;
    let cancellationError: unknown;
    const cancelBody = (): void => {
      if (reader === undefined || cancelling !== undefined) return;
      try {
        cancelling = reader.cancel().catch((error: unknown) => {
          completion.cancellationFailed = true;
          cancellationError = error;
        });
      } catch (error) {
        completion.cancellationFailed = true;
        cancellationError = error;
        cancelling = Promise.resolve();
      }
    };
    requestSignal.addEventListener("abort", cancelBody, { once: true });
    const timer = setTimeout(() => {
      completion.timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    try {
      requestSignal.throwIfAborted();
      const request = prepare();
      if (request.body !== undefined && Buffer.byteLength(request.body, "utf8") > MAX_REQUEST_BYTES)
        throw new OwnerIncarnationError("acp_registration_unavailable");
      requestSignal.throwIfAborted();
      const response = await this.send(request.endpoint, {
        method: request.method,
        headers: {
          ...(request.body === undefined ? {} : { "Content-Type": "application/json" }),
          "Cache-Control": "no-store",
        },
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        ...(request.body === undefined ? {} : { body: request.body }),
        signal: requestSignal,
      });
      if (response.body !== null) {
        reader = response.body.getReader();
        bodyClosed = reader.closed.catch((error: unknown) => {
          completion.bodyFailed = true;
          bodyError = error;
        });
      }
      requestSignal.throwIfAborted();
      rejected =
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 408 &&
        response.status !== 429;
      if (
        response.status !== 200 ||
        !JSON_MEDIA.test(response.headers.get("content-type") ?? "") ||
        reader === undefined
      )
        throw new OwnerIncarnationError("acp_registration_unavailable");
      const declared = response.headers.get("content-length");
      if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES))
        throw new OwnerIncarnationError("acp_registration_unavailable");
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        reading = reader.read();
        const chunk = await reading;
        reading = undefined;
        requestSignal.throwIfAborted();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_RESPONSE_BYTES)
          throw new OwnerIncarnationError("acp_registration_unavailable");
        chunks.push(chunk.value);
      }
      result = request.parse(strictObject(Buffer.concat(chunks)));
    } catch {
      failed = true;
    } finally {
      // Abort starts cancellation; completion still requires the original read
      // and the reader's actual cancellation to settle before releasing its lock.
      controller.abort();
      cancelBody();
      if (reading !== undefined) {
        try {
          await reading;
        } catch {
          failed = true;
        }
      }
      if (cancelling !== undefined) await cancelling;
      if (bodyClosed !== undefined) await bodyClosed;
      // Cancelling an already errored stream repeats its original error.
      // Its independently joined closed receipt distinguishes that from a new
      // cancellation failure, which must still stop further attempts.
      if (
        completion.cancellationFailed &&
        (!completion.bodyFailed || cancellationError !== bodyError)
      )
        cleanupFailed = true;
      if (reader !== undefined) {
        try {
          reader.releaseLock();
        } catch {
          cleanupFailed = true;
        }
      }
      requestSignal.removeEventListener("abort", cancelBody);
      clearTimeout(timer);
    }
    const unavailable = (retryable: boolean, incompleteCleanup = false): OwnerIncarnationError =>
      operation === "register"
        ? new OwnerRegistrationAttemptError(retryable, incompleteCleanup)
        : new OwnerInspectionAttemptError(retryable, incompleteCleanup);
    if (cleanupFailed) throw unavailable(false, true);
    if (rejected) throw unavailable(false);
    if (signal.aborted || completion.timedOut) throw new OwnerIncarnationError("deadline_exceeded");
    if (failed || result === undefined) throw unavailable(true);
    return result;
  }
}

function registrationRequest(value: unknown): OwnerRegistrationRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new OwnerIncarnationError("acp_registration_unavailable");
  const fields = ["member_id", "incarnation_id", "registration_nonce"];
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(String(key))))
    throw new OwnerIncarnationError("acp_registration_unavailable");
  const record = value as Record<string, unknown>;
  const { member_id: memberId, incarnation_id: incarnationId, registration_nonce: nonce } = record;
  if (
    typeof memberId !== "string" ||
    memberId.length < 1 ||
    memberId.length > 64 ||
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.exec(memberId)?.[0] !== memberId ||
    typeof incarnationId !== "string" ||
    incarnationId.length !== 36 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(incarnationId) ||
    typeof nonce !== "string" ||
    nonce.length !== 64 ||
    !/^[0-9a-f]{64}$/u.test(nonce)
  )
    throw new OwnerIncarnationError("acp_registration_unavailable");
  return { member_id: memberId, incarnation_id: incarnationId, registration_nonce: nonce };
}
