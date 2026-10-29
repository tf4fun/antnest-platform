import { z } from "zod";
import { strictObject } from "./strict-json.js";
import { ModelError } from "../ports/model.js";
import type {
  ExecutionCredentialResolver,
  ResolvedExecutionCredential,
} from "../ports/execution-credentials.js";

const RESOLVE_PATH = "/internal/execution-credentials/resolve";
const MAX_BODY_BYTES = 64 * 1024;
const TIMEOUT_MS = 5_000;
const identifier = z.string().min(1).max(200);

const scopeSchema = z.strictObject({
  organization_id: identifier,
  connection_id: identifier,
  credential_version: identifier,
});

const resolvedSchema = z.strictObject({
  organization_id: identifier,
  connection_id: identifier,
  credential_version: identifier,
  method: z.literal("api_key"),
  secret: z.string().min(1),
});

type DependencyFetcher = (input: URL, init: RequestInit) => Promise<Response>;

const unavailable = (): ModelError =>
  new ModelError("provider_unavailable", "Provider credential is unavailable", false);

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let fail!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    fail = () => reject(unavailable());
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", fail);
  }
}

export class ControllerExecutionCredentialsClient {
  private readonly origin: string;

  public constructor(
    origin: string,
    private readonly fetcher: DependencyFetcher,
  ) {
    const url = new URL(origin);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.pathname !== "/"
    )
      throw new Error("Execution Controller origin must be a bare HTTP(S) origin");
    this.origin = url.origin;
  }

  public async resolve(
    scope: { organization_id: string; connection_id: string; credential_version: string },
    signal: AbortSignal,
  ): Promise<ResolvedExecutionCredential> {
    if (!scopeSchema.safeParse(scope).success) throw unavailable();
    if (signal.aborted) throw unavailable();
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const combined = AbortSignal.any([signal, timeout]);
    try {
      const response = await abortable(
        this.fetcher(new URL(RESOLVE_PATH, this.origin), {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(scope),
          credentials: "omit",
          redirect: "error",
          cache: "no-store",
          signal: combined,
        }),
        combined,
      );
      signal.throwIfAborted();
      const type = response.headers.get("content-type");
      if (response.status !== 200 || response.redirected) {
        await abortable(response.body?.cancel() ?? Promise.resolve(), combined).catch(() => {});
        throw unavailable();
      }
      if (type === null || !/^\s*application\/json(?:\s*;|\s*$)/iu.test(type)) {
        await abortable(response.body?.cancel() ?? Promise.resolve(), combined).catch(() => {});
        throw unavailable();
      }
      const body = await readBounded(response, combined);
      signal.throwIfAborted();
      const decoded = strictObject(body);
      const parsed = resolvedSchema.safeParse(decoded);
      if (
        !parsed.success ||
        parsed.data.organization_id !== scope.organization_id ||
        parsed.data.connection_id !== scope.connection_id ||
        parsed.data.credential_version !== scope.credential_version
      )
        throw unavailable();
      return Object.freeze(parsed.data);
    } catch {
      throw unavailable();
    }
  }
}

async function readBounded(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
    await abortable(response.body?.cancel() ?? Promise.resolve(), signal).catch(() => {});
    throw unavailable();
  }
  if (response.body === null) throw unavailable();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let failed = true;
  try {
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw unavailable();
      chunks.push(value);
    }
    failed = false;
  } finally {
    if (failed) await abortable(reader.cancel(), signal).catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

export function executionCredentialResolver(
  client: ControllerExecutionCredentialsClient,
): ExecutionCredentialResolver {
  return (scope, signal) => client.resolve(scope, signal);
}
