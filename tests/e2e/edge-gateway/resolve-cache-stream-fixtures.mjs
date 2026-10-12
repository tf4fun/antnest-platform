export function view(sessionId, cursor) {
  return {
    agentId: "agent-1",
    bridgeEpoch: "epoch-1",
    availability: "busy",
    promptCapabilities: { image: true },
    activeSessionId: "session-1",
    selectedSessionId: sessionId,
    selectedView:
      sessionId === null
        ? null
        : {
            sessionId,
            agentId: "agent-1",
            bridgeEpoch: "epoch-1",
            incarnation: "incarnation",
            viewRevision: 2,
            title: null,
            updatedAt: null,
            appendVersion: 1,
            outputWatermark: 2,
            historyState: "ready",
            historyToken: "history",
            streamCursor: "session-cut",
            turns: [],
            olderTurnsCursor: null,
            operations: [],
            permissions: [],
          },
    operations: [],
    permissions: [],
    streamCursor: cursor,
  };
}

export function reset(sessionId, revision) {
  return {
    type: "reset",
    agentId: "agent-1",
    bridgeEpoch: "epoch-1",
    projectionId: "projection-1",
    fromStreamRevision: revision - 1,
    toStreamRevision: revision,
    cursor: `cursor-${revision}`,
    view: view(sessionId, `cursor-${revision}`),
  };
}

export function delta() {
  return {
    type: "delta",
    agentId: "agent-1",
    bridgeEpoch: "epoch-1",
    projectionId: "projection-1",
    fromStreamRevision: 2,
    toStreamRevision: 3,
    fromCursor: "cursor-2",
    cursor: "cursor-3",
    sessionId: "session-1",
    incarnation: "incarnation",
    fromSessionViewRevision: 2,
    sessionViewRevision: 3,
    patch: [
      { op: "replace", path: "/selectedView/title", value: "Renamed" },
      { op: "replace", path: "/selectedView/viewRevision", value: 3 },
    ],
  };
}
