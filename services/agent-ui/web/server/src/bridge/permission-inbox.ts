import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk/unstable";

const maxPending = 64;
const maxVisibleInputBytes = 256 * 1024;
const correlationId = z.string().min(1).max(200);
const requestCorrelation = z.strictObject({
  version: z.literal(1),
  runId: correlationId,
  toolCallId: correlationId,
});
const resolutionNotice = z.strictObject({
  version: z.literal(1),
  runId: correlationId,
  toolCallId: correlationId,
  reason: z.enum(["permission_resolved", "permission_timeout"]),
});

export type PendingPermission = {
  permissionId: string;
  sessionId: string;
  generation: number;
  toolCall: {
    toolCallId: string;
    title?: string;
    kind?: string;
    rawInput?: unknown;
  };
  options: Array<{ optionId: string; name: string; kind: string }>;
};

type Entry = {
  view: PendingPermission;
  finish: (optionId?: string) => void;
  correlation?: { runId: string; toolCallId: string };
};

export class PermissionDecisionError extends Error {
  public readonly code: "permission_stale" | "permission_conflict";
  public constructor(
    message: string,
    code: "permission_stale" | "permission_conflict" = "permission_conflict",
  ) {
    super(message);
    this.name = "PermissionDecisionError";
    this.code = code;
  }
}

export class PermissionInbox {
  private readonly entries = new Map<string, Entry>();
  private nextGeneration = 1;
  private readonly changed: (items: PendingPermission[]) => void;
  private readonly retainWork: () => () => void;

  public constructor(dependencies: {
    changed(items: PendingPermission[]): void;
    retainWork(): () => void;
  }) {
    this.changed = dependencies.changed;
    this.retainWork = dependencies.retainWork;
  }

  public get pending(): PendingPermission[] {
    return [...this.entries.values()].map(({ view }) => structuredClone(view));
  }

  public request(
    request: RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    if (signal.aborted)
      return Promise.resolve({ outcome: { outcome: "cancelled" } });
    if (this.entries.size >= maxPending)
      throw new PermissionDecisionError("Permission inbox is at capacity");
    if (this.nextGeneration >= Number.MAX_SAFE_INTEGER)
      throw new PermissionDecisionError("Permission generation is exhausted");
    const permissionId = randomUUID();
    const generation = this.nextGeneration++;
    const view = project(request, permissionId, generation);
    const releaseWork = this.retainWork();
    return new Promise((resolve) => {
      const abort = () => finish();
      const finish = (optionId?: string) => {
        if (!this.entries.delete(permissionId)) return;
        signal.removeEventListener("abort", abort);
        releaseWork();
        this.publish();
        resolve({
          outcome:
            optionId === undefined
              ? { outcome: "cancelled" }
              : { outcome: "selected", optionId },
        });
      };
      this.entries.set(permissionId, {
        view,
        finish,
        correlation: correlate(request),
      });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) finish();
      else this.publish();
    });
  }

  public decide(
    permissionId: string,
    generation: number,
    optionId: string,
  ): void {
    const entry = this.entries.get(permissionId);
    if (entry === undefined || entry.view.generation !== generation)
      throw new PermissionDecisionError(
        "Permission request is no longer current",
        "permission_stale",
      );
    if (!entry.view.options.some((option) => option.optionId === optionId))
      throw new PermissionDecisionError("Permission option was not advertised");
    entry.finish(optionId);
  }

  public resolve(sessionId: string, payload: unknown): void {
    const parsed = resolutionNotice.safeParse(payload);
    if (!parsed.success) return;
    const { runId, toolCallId } = parsed.data;
    for (const entry of [...this.entries.values()])
      if (
        entry.view.sessionId === sessionId &&
        entry.correlation?.runId === runId &&
        entry.correlation.toolCallId === toolCallId
      )
        entry.finish();
  }

  public clear(): void {
    for (const entry of [...this.entries.values()]) entry.finish();
  }

  private publish(): void {
    try {
      this.changed(this.pending);
    } catch {
      // A failed observer cannot choose a permission outcome for the user.
    }
  }
}

function correlate(
  request: RequestPermissionRequest,
): { runId: string; toolCallId: string } | undefined {
  const meta = (request as { _meta?: Record<string, unknown> })._meta?.[
    "antnest.dev/permission-request"
  ];
  const parsed = requestCorrelation.safeParse(meta);
  if (!parsed.success || parsed.data.toolCallId !== request.toolCall.toolCallId)
    return undefined;
  return { runId: parsed.data.runId, toolCallId: parsed.data.toolCallId };
}

function project(
  request: RequestPermissionRequest,
  permissionId: string,
  generation: number,
): PendingPermission {
  const toolCall = request.toolCall;
  const visible = {
    toolCallId: toolCall.toolCallId,
    ...(typeof toolCall.title === "string" ? { title: toolCall.title } : {}),
    ...(typeof toolCall.kind === "string" ? { kind: toolCall.kind } : {}),
  };
  let rawInput: unknown;
  if (toolCall.rawInput !== undefined) {
    const encoded = JSON.stringify(toolCall.rawInput);
    if (
      encoded !== undefined &&
      Buffer.byteLength(encoded) <= maxVisibleInputBytes
    )
      rawInput = structuredClone(toolCall.rawInput);
  }
  return {
    permissionId,
    sessionId: request.sessionId,
    generation,
    toolCall: rawInput === undefined ? visible : { ...visible, rawInput },
    options: request.options.map(({ optionId, name, kind }) => ({
      optionId,
      name,
      kind,
    })),
  };
}
