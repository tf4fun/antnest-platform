import { CALLER_CONTEXT_HEADER, type CallerClaims } from "../adapters/caller-context.ts";

export type Delegation = { token: string; claims: CallerClaims };
const requests = new WeakMap<Headers, Delegation>();
const scopes = new WeakMap<object, { current: Delegation }>();

// Called only after native HTTP workload and signature admission.
export function bindAuthenticatedRequest(request: Request, delegation: Delegation): void {
  requests.set(request.headers, delegation);
}
export function verifiedRequestContext(headers: Headers): Delegation | undefined {
  return requests.get(headers);
}
export function copyAuthenticatedRequest(source: Request, target: Request): void {
  const context = requests.get(source.headers);
  if (context) requests.set(target.headers, context);
}
export function bindScopeContext(scope: object, delegation: Delegation): void {
  scopes.set(scope, { current: delegation });
}
export function refreshScopeContext(target: object, source: object): void {
  const next = scopes.get(source)?.current;
  if (!next) return;
  const previous = scopes.get(target);
  if (!previous) { bindScopeContext(target, next); return; }
  if (previous.current.claims.sub !== next.claims.sub || previous.current.claims.org !== next.claims.org ||
    previous.current.claims.agt !== next.claims.agt) throw new Error("caller_context_scope_conflict");
  if (next.claims.iat >= previous.current.claims.iat && next.claims.exp >= previous.current.claims.exp)
    previous.current = next;
}
export function scopeHeaders(scope: object, consumer: string): Record<string, string> {
  const context = scopes.get(scope)?.current;
  if (!context || !context.claims.aud.some(value => value === consumer) ||
    Math.floor(Date.now() / 1000) >= context.claims.exp + 30)
    throw new Error("caller_context_invalid");
  return { [CALLER_CONTEXT_HEADER]: context.token };
}
