import type { BridgeScope } from "../bridge/registry.ts";
import { HistoryCapacityError } from "../bridge/compact-transcript.ts";
import { OperationReconciliationTimeoutError } from "../bridge/operations.ts";
import { ViewCursorError, type ViewPager } from "../bridge/view-pager.ts";
import { bridgeCapacityResponse, error, json, routeParts, trustedScope } from "./command-routes.ts";

type AuthorizedHistory = { pager: ViewPager; release(): void };

export function createHistoryHandler(dependencies: {
  authorize(scope: BridgeScope, sessionId: string): Promise<AuthorizedHistory>;
}): (request: Request) => Promise<Response | null> {
  return async (request) => {
    const parts = routeParts(new URL(request.url).pathname);
    if (parts === null) return null;
    const [agentId, sessionId, resource, turnId, action, itemId, tail] = parts;
    const turnsPage = turnId === undefined && action === undefined;
    const turnContent =
      turnId !== undefined && action === "content" && itemId === undefined;
    const processPage =
      turnId !== undefined && action === "process" && itemId === undefined;
    const processContent =
      turnId !== undefined &&
      action === "process" &&
      itemId !== undefined &&
      tail === "content";
    if (
      agentId === undefined ||
      sessionId === undefined ||
      resource !== "turns" ||
      request.method !== "GET" ||
      !(turnsPage || turnContent || processPage || processContent)
    )
      return null;
    const scope = trustedScope(request);
    if (scope === null)
      return error(
        401,
        "unauthenticated",
        "Trusted identity is missing",
        "login",
      );
    if (scope.agentId !== agentId)
      return error(403, "access_denied", "Agent access denied", "none");
    let authorized: AuthorizedHistory;
    try {
      authorized = await dependencies.authorize(scope, sessionId);
    } catch (cause) {
      const capacity = bridgeCapacityResponse(cause);
      if (capacity !== null) return capacity;
      if (cause instanceof OperationReconciliationTimeoutError)
        return error(504, "workspace_deadline_exceeded", "Operation reconciliation timed out", "retry_read");
      if (cause instanceof HistoryCapacityError)
        return error(
          429,
          "history_capacity_exceeded",
          "Session history exceeds Bridge capacity",
          "retry_read",
        );
      return error(
        503,
        "upstream_unavailable",
        "Session history is unavailable",
        "retry_read",
      );
    }
    try {
      const values = new URL(request.url).searchParams.getAll("cursor");
      if (
        values.length > 1 ||
        ((turnContent || processContent) && values.length !== 1)
      )
        return error(
          422,
          "invalid_cursor",
          "One content cursor is required",
          "refresh",
        );
      if (turnsPage) {
        const page =
          values.length === 0
            ? authorized.pager.recentTurns()
            : authorized.pager.turnsAt(values[0]!);
        return json({ items: page.items, nextCursor: page.olderTurnsCursor,
          newerCursor: page.newerTurnsCursor });
      }
      if (turnContent)
        return json(authorized.pager.contentPage(values[0]!, turnId));
      if (processPage)
        return json(authorized.pager.processPage(turnId!, values[0]));
      return json(
        authorized.pager.processContentPage(values[0]!, turnId!, itemId!),
      );
    } catch (cause) {
      if (cause instanceof ViewCursorError)
        return error(409, "stale_cursor", "History cursor is stale", "refresh");
      return error(
        503,
        "history_unavailable",
        "Session history is unavailable",
        "retry_read",
      );
    } finally {
      authorized.release();
    }
  };
}
