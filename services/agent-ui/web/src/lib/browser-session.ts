/** Browser delivery hints detect replacement; only Gateway validation authorizes work. */
export type SessionMetadata = {
  expires_at: string;
  idle_expires_at: string;
  activity_interval_ms: number;
};
export type BrowserSession = SessionMetadata & {
  principal: {
    user_id: string; organization_id: string; membership_id: string;
    organization_slug: string; organization_name: string;
    system_role: "admin" | "user"; organization_role: "admin" | "member"; active: boolean;
  };
};
export type BrowserAccount = {
  user_id: string; organization_id: string; membership_id: string;
  email: string; display_name: string; source: "local" | "scim";
  local_password_available: boolean;
};
export type SessionInventory = {
  sessions: Array<{
    id: string; organization_id: string; organization_slug: string; organization_name: string;
    created_at: string; last_active_at: string; idle_expires_at: string; expires_at: string;
    user_agent_hint: string; current: boolean;
  }>;
  next_after_id?: string;
};
export type SessionRevocation = { revoked_count: number; current_revoked: boolean };
export type BrowserRequest = Readonly<{ generation: symbol; hint: string | undefined }>;
export type SessionEvent = { type: "validation_required" | "transition" } |
  { type: "ended"; reason: "expired" | "signed_out" } |
  { type: "transition_failed"; message: string } |
  { type: "ready"; session: BrowserSession };

export class BrowserSessionChanged extends Error {
  constructor() {
    super("The browser session changed. Validate the current session before trying again.");
    this.name = "BrowserSessionChanged";
  }
}
export class BrowserSessionError extends Error {
  readonly status: number | undefined;
  readonly code: string;
  constructor(message: string, status: number | undefined, code: string) {
    super(message);
    this.name = "BrowserSessionError";
    this.status = status;
    this.code = code;
  }
}

type Options = { csrf: () => string | undefined; fetch?: typeof fetch; timeoutMs?: number };
type RequestOptions = { method?: "GET" | "POST" | "DELETE"; body?: unknown;
  headers?: HeadersInit; signal?: AbortSignal; unvalidated?: boolean; writer?: "password" | "logout" };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validMetadata(value: unknown): value is SessionMetadata {
  return record(value) && typeof value.expires_at === "string" && typeof value.idle_expires_at === "string" &&
    Number.isFinite(Date.parse(value.expires_at)) && Number.isFinite(Date.parse(value.idle_expires_at)) &&
    Date.parse(value.idle_expires_at) <= Date.parse(value.expires_at) &&
    Number.isInteger(value.activity_interval_ms) && Number(value.activity_interval_ms) >= 1 && Number(value.activity_interval_ms) <= 30_000;
}
function validSession(value: unknown): value is BrowserSession {
  if (!record(value)) return false;
  const principal = value.principal;
  if (!validMetadata(value) || !record(principal)) return false;
  return principal.active === true &&
    [principal.user_id, principal.organization_id, principal.membership_id,
      principal.organization_slug, principal.organization_name].every(item => typeof item === "string" && item.trim() !== "") &&
    ["admin", "user"].includes(String(principal.system_role)) &&
    ["admin", "member"].includes(String(principal.organization_role));
}
const invalidResponse = () => new BrowserSessionError("The server returned invalid session details.", 502, "invalid_response");

/** One instance per mounted application, never shared between SSR requests. */
export class BrowserSessionClient {
  private generation = Symbol();
  private validatedHint: string | undefined;
  private validationPending = false;
  private readonly controllers = new Set<AbortController>();
  private readonly listeners = new Set<(event: SessionEvent) => void>();
  private readonly proofs = new WeakMap<object, BrowserRequest>();
  private readonly fetcher: typeof fetch;
  private readonly csrf: Options["csrf"];
  private readonly timeoutMs: number;

  constructor(options: Options) {
    this.fetcher = options.fetch ?? ((...args) => globalThis.fetch(...args));
    this.csrf = options.csrf;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }
  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private emit(event: SessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }
  private cancel(): void {
    this.generation = Symbol();
    for (const controller of this.controllers) controller.abort(new BrowserSessionChanged());
    this.controllers.clear();
  }
  requireValidation(): void {
    if (this.validationPending) return;
    this.validationPending = true;
    this.validatedHint = undefined;
    this.cancel();
    this.emit({ type: "validation_required" });
  }
  dispose(): void {
    this.validatedHint = undefined;
    this.validationPending = false;
    this.cancel();
  }
  capture(unvalidated = false): BrowserRequest {
    const hint = this.csrf() || undefined;
    if (!unvalidated && (!hint || hint !== this.validatedHint)) {
      this.requireValidation();
      throw new BrowserSessionChanged();
    }
    return { generation: this.generation, hint };
  }
  current(request: BrowserRequest): boolean {
    if (request.generation !== this.generation) return false;
    if (request.hint !== (this.csrf() || undefined)) {
      this.requireValidation();
      return false;
    }
    return true;
  }
  assert(request: BrowserRequest): void {
    if (!this.current(request)) throw new BrowserSessionChanged();
  }
  onCancel(request: BrowserRequest, cancel: () => void): () => void {
    const controller = new AbortController();
    controller.signal.addEventListener("abort", cancel, { once: true });
    if (this.current(request)) this.controllers.add(controller);
    else controller.abort(new BrowserSessionChanged());
    return () => {
      this.controllers.delete(controller);
      controller.signal.removeEventListener("abort", cancel);
    };
  }
  track<T>(value: T, request: BrowserRequest): T {
    this.assert(request);
    if (typeof value === "object" && value !== null) this.proofs.set(value, request);
    return value;
  }
  responseCurrent(value: unknown): boolean {
    if (typeof value !== "object" || value === null) return false;
    const proof = this.proofs.get(value);
    return proof !== undefined && this.current(proof);
  }
  end(request: BrowserRequest, reason: "expired" | "signed_out" = "expired"): void {
    if (!this.current(request)) return;
    this.validatedHint = undefined;
    this.validationPending = false;
    this.cancel();
    this.emit({ type: "ended", reason });
  }
  async read(signal?: AbortSignal): Promise<BrowserSession> {
    const before = this.capture(true);
    const raw = await this.request("/api/session", { signal, unvalidated: true });
    this.assert(before);
    signal?.throwIfAborted();
    if (!validSession(raw)) throw invalidResponse();
    if (!before.hint) {
      this.end(before);
      throw new BrowserSessionError("Sign in again to restore browser session verification.", 401, "session_delivery_missing");
    }
    this.cancel();
    this.validatedHint = before.hint;
    this.validationPending = false;
    this.track(raw, this.capture());
    this.emit({ type: "ready", session: raw });
    return raw;
  }
  account(signal?: AbortSignal): Promise<{ account: BrowserAccount }> {
    return this.request("/api/session/account", { signal }) as Promise<{ account: BrowserAccount }>;
  }
  async activity(signal: AbortSignal): Promise<SessionMetadata> {
    const before = this.capture();
    const raw = await this.request("/api/session/activity", { method: "POST", body: {}, signal });
    this.assert(before);
    signal.throwIfAborted();
    if (!validMetadata(raw)) throw invalidResponse();
    return this.track(raw, before);
  }
  sessions(afterID?: string, signal?: AbortSignal): Promise<SessionInventory> {
    return this.request(`/api/session/sessions?limit=50${afterID ? `&after_id=${encodeURIComponent(afterID)}` : ""}`, { signal }) as Promise<SessionInventory>;
  }
  async revoke(mode: "others" | "all", signal?: AbortSignal): Promise<SessionRevocation> {
    const before = this.capture();
    const raw = await this.request("/api/session/sessions/revoke", { method: "POST", body: { mode }, signal,
      headers: { "Idempotency-Key": crypto.randomUUID() } });
    this.assert(before);
    signal?.throwIfAborted();
    if (!record(raw) || !Number.isInteger(raw.revoked_count) || Number(raw.revoked_count) < 0 || typeof raw.current_revoked !== "boolean") throw invalidResponse();
    const result = this.track(raw as SessionRevocation, before);
    if (result.current_revoked) this.end(before, "signed_out");
    return result;
  }
  async password(current_password: string, new_password: string, signal?: AbortSignal): Promise<BrowserSession> {
    const before = this.capture();
    await this.request("/api/session/password", { method: "POST", body: { current_password, new_password }, signal, writer: "password" });
    if (before.generation !== this.generation) throw new BrowserSessionChanged();
    // The writer may have replaced Cookies; validate the browser's current delivery,
    // including another tab's possible replacement, before publishing any principal.
    this.dispose();
    const transition = this.capture(true);
    this.emit({ type: "transition" });
    // The auth owner outlives the old form. Closing that form must not abort
    // validation of credentials that the successful writer already replaced.
    let replacement: BrowserSession;
    try { replacement = await this.read(); }
    catch (cause) {
      if (this.current(transition) && !(cause instanceof BrowserSessionChanged)) this.emit({
        type: "transition_failed", message: cause instanceof Error ? cause.message : "Session verification failed.",
      });
      throw cause;
    }
    signal?.throwIfAborted();
    return replacement;
  }
  async logout(signal?: AbortSignal): Promise<void> {
    const before = this.capture();
    await this.request("/api/session", { method: "DELETE", signal, writer: "logout" });
    if (before.generation !== this.generation) throw new BrowserSessionChanged();
    signal?.throwIfAborted();
    if (this.csrf() && this.csrf() !== before.hint) {
      this.requireValidation();
      throw new BrowserSessionChanged();
    }
    this.end(this.capture(true), "signed_out");
  }
  private async request(path: string, options: RequestOptions = {}): Promise<unknown> {
    const before = this.capture(options.unvalidated);
    const controller = new AbortController();
    this.controllers.add(controller);
    const callerAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", callerAbort, { once: true });
    if (options.signal?.aborted) callerAbort();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    let abort!: () => void;
    const interrupted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", abort, { once: true });
    });
    const method = options.method ?? "GET";
    const headers = new Headers(options.headers);
    headers.set("Accept", "application/json");
    if (method !== "GET") {
      if (before.hint) headers.set("X-Antnest-CSRF-Token", before.hint);
      if (options.body !== undefined) headers.set("Content-Type", "application/json");
    }
    let cookieTransition = false;
    const assertResponse = () => {
      if (before.generation !== this.generation) throw new BrowserSessionChanged();
      controller.signal.throwIfAborted();
      if (!cookieTransition) this.assert(before);
      if (options.writer === "logout" && this.csrf() && this.csrf() !== before.hint) {
        this.requireValidation();
        throw new BrowserSessionChanged();
      }
    };
    try {
      assertResponse();
      const result = await Promise.race([interrupted, (async () => {
        const response = await this.fetcher(path, { method, credentials: "same-origin", cache: "no-store", headers,
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }), signal: controller.signal });
        cookieTransition = Boolean(options.writer && (response.ok || options.writer === "logout" && response.status === 401));
        assertResponse();
        if (options.writer === "logout" && (response.ok || response.status === 401)) {
          await response.body?.cancel();
          return undefined;
        }
        if (response.status === 204) {
          if (options.writer === "password") {
            this.controllers.delete(controller);
            this.requireValidation();
          }
          throw invalidResponse();
        }
        let body: unknown;
        try { body = await response.json(); }
        catch {
          assertResponse();
          this.controllers.delete(controller);
          if (cookieTransition) this.requireValidation();
          if (response.status === 401) this.end(before);
          throw invalidResponse();
        }
        assertResponse();
        if (!response.ok) {
          this.controllers.delete(controller);
          if (response.status === 401) this.end(before);
          const error = record(body) ? body : {};
          throw new BrowserSessionError(typeof error.message === "string" ? error.message : "Session request failed.", response.status,
            typeof error.code === "string" ? error.code : "session_request_failed");
        }
        return cookieTransition ? body : this.track(body, before);
      })()]);
      assertResponse();
      return result;
    } catch (cause) {
      if (cause instanceof BrowserSessionError || cause instanceof BrowserSessionChanged) throw cause;
      this.assert(before);
      if (timedOut) throw new BrowserSessionError("Session request timed out.", undefined, "session_request_timeout");
      if (controller.signal.aborted) throw controller.signal.reason;
      throw new BrowserSessionError("Session connection failed.", undefined, "session_network_error");
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
      options.signal?.removeEventListener("abort", callerAbort);
      controller.signal.removeEventListener("abort", abort);
    }
  }
}
