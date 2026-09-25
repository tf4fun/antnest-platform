// Browser-safe workspace DTO validation and patching. No Node or ACP runtime imports.
import { z } from "zod";

const id = z.string().min(1).max(200);
const revision = z.number().int().nonnegative().safe();
const cursor = z.string().min(1).max(4096);
const content = z.object({ type: z.string().min(1) }).passthrough();
const error = z.strictObject({ code: z.string().min(1), message: z.string().min(1), requestId: id, operationId: id.optional(),
  retryable: z.boolean(), recovery: z.enum(["none", "login", "refresh", "retry_read", "query_operation"]) });
const operation = z.strictObject({ operationId: id, sessionId: id,
  phase: z.enum(["dispatching", "accepted", "running", "awaiting_permission", "cancelling", "completed", "failed", "cancelled", "uncertain"]),
  acceptance: z.enum(["bridge", "acp", "unknown"]), runId: id.optional(),
  outputWatermark: revision.optional(), stopReason: z.string().nullable().optional(),
  errorClass: z.string().max(128).nullable().optional(), error: error.optional(),
}).refine((value) => value.acceptance !== "acp" ||
  (value.runId !== undefined && value.outputWatermark !== undefined));
const permission = z.strictObject({ permissionId: id, sessionId: id, generation: revision,
  toolCall: z.strictObject({ toolCallId: id, title: z.string().optional(), kind: z.string().optional(), rawInput: z.unknown().optional() }),
  options: z.array(z.strictObject({ optionId: id, name: z.string().min(1),
    kind: z.enum(["allow_once", "allow_always", "reject_once", "reject_always"]) })).min(1),
});
const processItem = z.strictObject({ id, kind: z.enum(["thought", "tool", "plan", "notice"]),
  summary: z.string(), status: z.enum(["pending", "running", "completed", "failed", "unknown"]),
  content: z.array(content), contentCursor: cursor.nullable(),
  toolSections: z.strictObject({ inputIndex: revision.optional(), outputIndex: revision.optional(),
    detailStartIndex: revision }).optional(),
}).refine((value) => (value.kind === "tool") === (value.toolSections !== undefined));
const turn = z.strictObject({ turnId: id, outcome: z.enum(["running", "completed", "failed", "cancelled", "unknown"]),
  prompt: z.array(content), finalResponse: z.array(content), contentCursor: cursor.nullable(),
  contentSection: z.enum(["prompt", "finalResponse"]).nullable(),
  processVersion: revision, processCount: revision,
  liveProcessDelta: z.strictObject({ fromVersion: revision,
    items: z.array(z.strictObject({ index: revision, item: processItem })).min(1).max(10) }).optional(),
}).refine((value) => (value.contentCursor === null) === (value.contentSection === null) &&
  (value.liveProcessDelta === undefined || value.outcome === "running" &&
  value.liveProcessDelta.fromVersion < value.processVersion &&
  value.liveProcessDelta.items.every(({ index }) => index < value.processCount) &&
  new Set(value.liveProcessDelta.items.map(({ index }) => index)).size === value.liveProcessDelta.items.length));
const session = z.strictObject({ agentId: id, sessionId: id, title: z.string().max(512).nullable(),
  updatedAt: z.string().max(64).nullable(), bridgeEpoch: id, incarnation: id,
  viewRevision: revision, appendVersion: revision.nullable(), outputWatermark: revision.nullable(),
  historyToken: cursor.nullable(), streamCursor: cursor,
  historyState: z.enum(["cold", "loading", "ready", "reconciling", "blocked"]),
  turns: z.array(turn).max(21), olderTurnsCursor: cursor.nullable(), operations: z.array(operation),
  permissions: z.array(permission), configOptions: z.array(z.record(z.string(), z.unknown())).optional(),
  configurationToken: cursor.nullable().optional(), usage: z.record(z.string(), z.unknown()).nullable().optional(),
}).refine((value) => value.historyState !== "blocked" ||
  (value.historyToken === null && value.olderTurnsCursor === null && (value.configurationToken ?? null) === null))
  .refine((value) => new Set(value.turns.map((item) => item.turnId)).size === value.turns.length &&
    value.operations.every((item) => item.sessionId === value.sessionId) &&
    value.permissions.every((item) => item.sessionId === value.sessionId));
const agent = z.strictObject({ agentId: id, bridgeEpoch: id, availability: z.enum(["ready", "busy", "offline"]),
  promptCapabilities: z.strictObject({ image: z.boolean().optional(), audio: z.boolean().optional(), embeddedContext: z.boolean().optional() }),
  activeSessionId: id.nullable(), selectedSessionId: id.nullable(), selectedView: session.nullable(),
  operations: z.array(operation), permissions: z.array(permission), streamCursor: cursor,
}).refine((value) => value.selectedSessionId === null ? value.selectedView === null :
  value.selectedView?.sessionId === value.selectedSessionId && value.selectedView?.agentId === value.agentId &&
  value.selectedView?.bridgeEpoch === value.bridgeEpoch);

export type AgentView = z.infer<typeof agent>;
export type Patch = { op: "add" | "replace"; path: string; value: unknown } | { op: "remove"; path: string };
export type DeltaBody = { type: "delta"; sessionId: string | null; incarnation: string | null;
  fromSessionViewRevision: number | null; sessionViewRevision: number | null; patch: Patch[] };
const agentFields = new Set(["availability", "activeSessionId", "promptCapabilities", "operations", "permissions"]);
const sessionFields = new Set(["title", "updatedAt", "viewRevision", "appendVersion", "outputWatermark", "historyToken",
  "historyState", "turns", "olderTurnsCursor", "operations", "permissions", "configOptions", "configurationToken", "usage"]);
const forbidden = new Set(["__proto__", "constructor", "prototype"]);

export function validAgentView(value: unknown): value is AgentView {
  return agent.safeParse(value).success;
}

export function applyAgentDelta(previous: AgentView, event: Record<string, unknown>): AgentView | null {
  if (event.sessionId !== previous.selectedSessionId || event.fromCursor !== previous.streamCursor ||
    typeof event.cursor !== "string" || !Array.isArray(event.patch) ||
    event.patch.length < 1 || event.patch.length > 128) return null;
  const before = previous.selectedView;
  if (before === null ? event.incarnation !== null || event.fromSessionViewRevision !== null || event.sessionViewRevision !== null :
    event.incarnation !== before.incarnation || event.fromSessionViewRevision !== before.viewRevision ||
    !Number.isSafeInteger(event.sessionViewRevision) || (event.sessionViewRevision as number) < before.viewRevision) return null;
  try {
    let next: unknown = previous;
    for (const patch of event.patch) {
      if (!record(patch) || !["add", "replace", "remove"].includes(String(patch.op)) ||
        typeof patch.path !== "string" || patch.path.length > 2048 ||
        Object.keys(patch).some((key) => !["op", "path", "value"].includes(key)) ||
        (patch.op === "remove" ? Object.hasOwn(patch, "value") : !Object.hasOwn(patch, "value"))) return null;
      const path = pointer(patch.path);
      if (!(agentFields.has(path[0]!) || path[0] === "selectedView" && sessionFields.has(path[1]!))) return null;
      next = patchAt(next, path, patch as Patch);
    }
    const view = { ...(next as AgentView), streamCursor: event.cursor };
    if (!validAgentView(view) || view.agentId !== previous.agentId || view.bridgeEpoch !== previous.bridgeEpoch ||
      view.selectedSessionId !== previous.selectedSessionId ||
      view.selectedView?.viewRevision !== (event.sessionViewRevision ?? undefined)) return null;
    if (before && view.selectedView && (
      view.selectedView.incarnation !== before.incarnation ||
      (before.appendVersion !== null && (view.selectedView.appendVersion ?? -1) < before.appendVersion) ||
      (before.outputWatermark !== null && (view.selectedView.outputWatermark ?? -1) < before.outputWatermark))) return null;
    return view;
  } catch { return null; }
}

function pointer(path: string): string[] {
  if (!path.startsWith("/") || /~(?:[^01]|$)/u.test(path)) throw new Error("Invalid JSON pointer");
  const tokens = path.slice(1).split("/").map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
  if (tokens.some((token) => !token || forbidden.has(token))) throw new Error("Unsafe JSON pointer");
  return tokens;
}

function patchAt(value: unknown, path: string[], patch: Patch): unknown {
  if (!Array.isArray(value) && !record(value)) throw new Error("Missing patch parent");
  const [key, ...rest] = path;
  if (Array.isArray(value)) {
    const index = key === "-" && rest.length === 0 && patch.op === "add" ? value.length :
      key !== undefined && /^(0|[1-9][0-9]*)$/u.test(key) ? Number(key) : -1;
    if (!Number.isSafeInteger(index) || index < 0 || index > value.length ||
      (index === value.length && (rest.length > 0 || patch.op !== "add"))) throw new Error("Invalid array position");
    const copy = value.slice();
    if (rest.length) copy[index] = patchAt(value[index], rest, patch);
    else if (patch.op === "add") copy.splice(index, 0, patch.value);
    else if (patch.op === "remove") copy.splice(index, 1);
    else copy[index] = patch.value;
    return copy;
  }
  if (key === undefined || (!Object.hasOwn(value, key) && (rest.length > 0 || patch.op !== "add")))
    throw new Error("Missing patch target");
  const copy = { ...value };
  if (rest.length) copy[key] = patchAt(value[key], rest, patch);
  else if (patch.op === "remove") delete copy[key];
  else copy[key] = patch.value;
  return copy;
}

export function diffAgentViews(previous: AgentView, next: AgentView): DeltaBody | null {
  if (previous.agentId !== next.agentId || previous.bridgeEpoch !== next.bridgeEpoch ||
    previous.selectedSessionId !== next.selectedSessionId || previous.selectedView?.incarnation !== next.selectedView?.incarnation)
    return null;
  const patch: Patch[] = [];
  const emit = (entry: Patch) => { patch.push(entry); if (patch.length > 128) throw new Error("Reset needed"); };
  const diff = (before: unknown, after: unknown, path: string) => {
    if (before === after) return;
    if (Array.isArray(before) && Array.isArray(after)) {
      for (let index = 0; index < Math.min(before.length, after.length); index++) diff(before[index], after[index], `${path}/${index}`);
      for (let index = before.length - 1; index >= after.length; index--) emit({ op: "remove", path: `${path}/${index}` });
      for (let index = before.length; index < after.length; index++) emit({ op: "add", path: `${path}/-`, value: after[index] });
    } else if (record(before) && record(after)) {
      for (const key of Object.keys(before)) if (!Object.hasOwn(after, key)) emit({ op: "remove", path: `${path}/${escapeKey(key)}` });
      for (const key of Object.keys(after)) {
        const child = `${path}/${escapeKey(key)}`;
        if (!Object.hasOwn(before, key)) emit({ op: "add", path: child, value: after[key] });
        else diff(before[key], after[key], child);
      }
    } else emit({ op: "replace", path, value: after });
  };
  try {
    for (const field of agentFields) diff(previous[field as keyof AgentView], next[field as keyof AgentView], `/${field}`);
    if (previous.selectedView && next.selectedView) for (const field of sessionFields) {
      const key = field as keyof NonNullable<AgentView["selectedView"]>;
      if (!Object.hasOwn(previous.selectedView, key) && Object.hasOwn(next.selectedView, key))
        emit({ op: "add", path: `/selectedView/${field}`, value: next.selectedView[key] });
      else if (Object.hasOwn(previous.selectedView, key) && !Object.hasOwn(next.selectedView, key))
        emit({ op: "remove", path: `/selectedView/${field}` });
      else diff(previous.selectedView[key], next.selectedView[key], `/selectedView/${field}`);
    }
  } catch { return null; }
  return { type: "delta", sessionId: next.selectedSessionId, incarnation: next.selectedView?.incarnation ?? null,
    fromSessionViewRevision: previous.selectedView?.viewRevision ?? null,
    sessionViewRevision: next.selectedView?.viewRevision ?? null, patch };
}

function escapeKey(key: string): string {
  if (!key || forbidden.has(key)) throw new Error("Unsafe patch key");
  return key.replaceAll("~", "~0").replaceAll("/", "~1");
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
