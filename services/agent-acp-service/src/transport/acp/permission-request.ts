import { permissionChoices } from "../../domain/tool-permissions.js";
import type { PermissionRequest } from "../../ports/tool-permissions.js";
import { untilAborted } from "../../application/permission-connections.js";

export function v1Permission(request: PermissionRequest) {
  return {
    sessionId: request.sessionId,
    options: [...permissionChoices],
    toolCall: {
      toolCallId: request.call.id,
      title: request.tool.title ?? request.tool.name,
      name: request.call.name,
      status: "pending" as const,
      rawInput: request.call.arguments,
    },
  };
}

export function v2Permission(request: PermissionRequest) {
  const { toolCall, ...common } = v1Permission(request);
  return {
    ...common,
    title: `Allow ${toolCall.title}?`,
    subject: { type: "tool_call" as const, toolCall },
  };
}

export async function permissionRequest(
  send: () => Promise<unknown>,
  signal: AbortSignal,
  close: (error: Error) => void,
): Promise<unknown> {
  signal.throwIfAborted();
  let cleanup: ReturnType<typeof setTimeout> | undefined;
  const abort = () => {
    cleanup = setTimeout(
      () => close(new Error("Permission cancellation was not acknowledged")),
      1000,
    );
    cleanup.unref();
  };
  signal.addEventListener("abort", abort, { once: true });
  const operation = Promise.resolve()
    .then(() => {
      signal.throwIfAborted();
      return send();
    })
    .finally(() => {
      signal.removeEventListener("abort", abort);
      clearTimeout(cleanup);
    });
  return untilAborted(operation, signal);
}
