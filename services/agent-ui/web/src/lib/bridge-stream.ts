export type BridgeAgentView = {
  agentId: string;
  bridgeEpoch: string;
  promptCapabilities: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
  selectedSessionId: string | null;
  selectedView: Record<string, unknown> | null;
  streamCursor: string;
  [key: string]: unknown;
};

export type BridgeStreamState = {
  agentId: string;
  selectedSessionId: string | null;
  bridgeEpoch: string | null;
  projectionId: string | null;
  revision: number | null;
  view: BridgeAgentView | null;
};

export type BridgeEventResult = {
  action: "view" | "refresh" | "ignore" | "revoke";
  state: BridgeStreamState;
};

export function initialBridgeStream(agentId: string, selectedSessionId: string | null): BridgeStreamState {
  return {
    agentId, selectedSessionId, bridgeEpoch: null, projectionId: null,
    revision: null, view: null,
  };
}

export function bridgeViewForScope(raw: unknown, agentId: string, selectedSessionId: string | null): BridgeAgentView | null {
  return validView(raw, initialBridgeStream(agentId, selectedSessionId),
    isRecord(raw) && typeof raw.bridgeEpoch === "string" ? raw.bridgeEpoch : "",
    isRecord(raw) && typeof raw.streamCursor === "string" ? raw.streamCursor : "")
    ? raw : null;
}

export function applyBridgeEvent(state: BridgeStreamState, raw: unknown): BridgeEventResult {
  if (!isRecord(raw) || typeof raw.agentId !== "string" || raw.agentId !== state.agentId)
    return { action: "revoke", state: { ...state, view: null } };
  if (raw.type === "access_revoked")
    return { action: "revoke", state: { ...state, view: null } };
  if (!validEventHead(raw))
    return { action: "refresh", state };
  const sameProjection = state.bridgeEpoch === raw.bridgeEpoch &&
    state.projectionId === raw.projectionId;
  if (raw.type === "snapshot" || raw.type === "reset") {
    if (sameProjection && state.revision !== null && raw.toStreamRevision <= state.revision)
      return { action: "ignore", state };
    if (!validView(raw.view, state, raw.bridgeEpoch, raw.cursor))
      return { action: "refresh", state };
    return {
      action: "view",
      state: {
        ...state,
        bridgeEpoch: raw.bridgeEpoch,
        projectionId: raw.projectionId,
        revision: raw.toStreamRevision,
        view: raw.view,
      },
    };
  }
  if (!sameProjection || state.revision === null)
    return { action: "refresh", state };
  if (raw.toStreamRevision <= state.revision)
    return { action: "ignore", state };
  if (raw.fromStreamRevision !== state.revision ||
    raw.toStreamRevision !== state.revision + 1)
    return { action: "refresh", state };
  if (raw.type !== "operation" && raw.type !== "permission" && raw.type !== "delta")
    return { action: "refresh", state };
  return {
    action: "refresh",
    state: { ...state, revision: raw.toStreamRevision },
  };
}

function validEventHead(value: Record<string, unknown>): value is Record<string, unknown> & {
  bridgeEpoch: string;
  projectionId: string;
  fromStreamRevision: number;
  toStreamRevision: number;
  cursor: string;
} {
  return typeof value.bridgeEpoch === "string" && value.bridgeEpoch.length > 0 &&
    typeof value.projectionId === "string" && value.projectionId.length > 0 &&
    Number.isSafeInteger(value.fromStreamRevision) &&
    (value.fromStreamRevision as number) >= 0 &&
    Number.isSafeInteger(value.toStreamRevision) &&
    (value.toStreamRevision as number) >= (value.fromStreamRevision as number) &&
    typeof value.cursor === "string" && value.cursor.length > 0;
}

function validView(
  raw: unknown,
  state: BridgeStreamState,
  bridgeEpoch: string,
  cursor: string,
): raw is BridgeAgentView {
  if (!isRecord(raw) || raw.agentId !== state.agentId ||
    bridgeEpoch.length === 0 || cursor.length === 0 ||
    raw.bridgeEpoch !== bridgeEpoch || raw.selectedSessionId !== state.selectedSessionId ||
    raw.streamCursor !== cursor || !validCapabilities(raw.promptCapabilities))
    return false;
  if (state.selectedSessionId === null) return raw.selectedView === null;
  return isRecord(raw.selectedView) &&
    raw.selectedView.sessionId === state.selectedSessionId &&
    raw.selectedView.bridgeEpoch === bridgeEpoch;
}

function validCapabilities(value: unknown): boolean {
  return isRecord(value) && Object.entries(value).every(([name, enabled]) =>
    (name === "image" || name === "audio" || name === "embeddedContext") &&
    typeof enabled === "boolean");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
