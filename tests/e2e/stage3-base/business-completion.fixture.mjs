import { runtimeCommandId } from "./contracts.mjs";

export const privateCanary = "PRIVATE-STAGE3-COMPLETION-FIXTURE";
const resource = (kind, index) =>
  `${kind}_${index.toString(16).padStart(32, "0")}`;
const stamp = (at) => ({ unixMs: 1_792_617_000_000 + at, monotonicMs: at });

function logout(agentId, sessionId, version) {
  const base = 1_792_617_000_000;
  const credentialScope = `00000000-0000-4000-8000-${version.toString().padStart(12, "0")}`;
  const principal = {
    user_id: resource("user", 1),
    organization_id: resource("org", 1),
    membership_id: resource("membership", 1),
    system_role: "user",
    organization_role: "member",
    active: true,
    organization_slug: "stage3-fixture",
    organization_name: privateCanary,
  };
  const sdkRequests = [
    { requestId: "0", method: "initialize" },
    { requestId: "1", method: "session/new" },
  ];
  const view = {
    agentId,
    bridgeEpoch: "bridge-fixture",
    availability: "ready",
    promptCapabilities: {},
    activeSessionId: null,
    selectedSessionId: sessionId,
    selectedView: {
      agentId,
      sessionId,
      bridgeEpoch: "bridge-fixture",
      title: null,
      updatedAt: null,
      incarnation: "incarnation-fixture",
      viewRevision: 0,
      appendVersion: 0,
      outputWatermark: 0,
      historyToken: "history-fixture",
      streamCursor: "cursor-fixture",
      historyState: "ready",
      turns: [],
      olderTurnsCursor: null,
      operations: [],
      permissions: [],
    },
    operations: [],
    permissions: [],
    streamCursor: "cursor-fixture",
  };
  const reset = {
    type: "reset",
    agentId,
    bridgeEpoch: "bridge-fixture",
    projectionId: "projection-fixture",
    fromStreamRevision: 0,
    toStreamRevision: 0,
    cursor: "cursor-fixture",
    view,
  };
  return {
    transport: "http-sse",
    agentId,
    sessionId,
    credentialScope,
    reason: "revoked",
    startedAt: base + 1000,
    closedAt: base + 1040,
    silent: true,
    localClose: false,
    authorizationCauseVerified: false,
    protocolVersion: version,
    protocolClientClosedLocally: true,
    principal,
    checkpoint: {
      at: 1000,
      observed_at_ms: base + 1000,
      agentId,
      sessionId,
      reason: "revoked",
      expiresAt: base + 43_200_000,
      idleExpiresAt: base + 1_800_000,
      browserRequests: 0,
      sdkRequests: structuredClone(sdkRequests),
      issuance: { startedMono: 500, completedMono: 550 },
      stream: {
        started_at: 800,
        started_at_ms: base + 800,
        headers_at: 850,
        server_date: new Date(base).toUTCString(),
        status: 200,
        set_cookie_count: 0,
        credential_scope: credentialScope,
        path: `/api/app/workspace/v1/agents/${agentId}/events?sessionId=${sessionId}`,
        frames: [
          { at: 900, raw: `event: reset\ndata: ${JSON.stringify(reset)}\n\n` },
        ],
        events: [{ at: 901, raw: reset, action: "view" }],
      },
    },
    closure: { kind: "transport-end", at: 1040, observed_at_ms: base + 1040 },
    sdkRequests: structuredClone(sdkRequests),
    cause: {
      kind: "logout",
      path: "/api/session",
      method: "DELETE",
      status: 204,
      credentialScope,
      principal: structuredClone(principal),
      startedAt: base + 1010,
      completedAt: base + 1020,
      startedMono: 1010,
      completedMono: 1020,
      serverDate: new Date(base + 1010).toUTCString(),
    },
    denial: {
      method: "POST",
      status: 401,
      code: "unauthenticated",
      credentialScope,
      path: `/api/app/workspace/v1/agents/${agentId}/sessions/${sessionId}/prompts`,
      startedAt: base + 1050,
      completedAt: base + 1060,
      startedMono: 1050,
      completedMono: 1060,
      serverDate: new Date(base + 1050).toUTCString(),
      noStore: true,
      setCookieCount: 0,
      intentId: `00000000-0000-4000-9000-${version.toString().padStart(12, "0")}`,
    },
  };
}

function initialization(version) {
  return {
    protocolVersion: version,
    ...(version === 1
      ? {
          agentInfo: { name: privateCanary, version: "1" },
          agentCapabilities: {},
        }
      : { info: { name: privateCanary, version: "1" }, capabilities: {} }),
    _meta: { "antnest.dev/errors": { version: 1 } },
  };
}

function connection(
  agentId,
  phase,
  sessionId,
  version,
  transport,
  mode,
  ordinal,
) {
  const setup = { cwd: "/workspace", mcpServers: [] };
  const settings = {
    configOptions: [],
    ...(version === 1
      ? {
          modes: {
            currentModeId: "auto",
            availableModes: [{ id: "auto", name: "Auto" }],
          },
        }
      : {}),
  };
  const definitions =
    mode === "execute"
      ? [
          ["new", "new"],
          ["prompt", "prompt"],
        ]
      : mode === "new"
        ? [["new", "new"]]
        : [
            ["list", "list"],
            [version === 1 ? "load" : "resume", "replay"],
            ["resume", "resume"],
          ];
  const first = {
    requestId: "0",
    method: "initialize",
    boundary: "private-acp",
    version,
    protocolVersion: version,
    agentId,
    transport,
    inputSessionID: null,
    kind: "request",
    outcome: "succeeded",
    label: `${version === 2 ? "v2-ws" : transport === "http" ? "v1-http" : "v1-ws"}:initialize`,
    initializationResult: initialization(version),
  };
  const evidence = definitions.map(([name, label], index) => {
    const params =
      name === "new"
        ? structuredClone(setup)
        : name === "list"
          ? {}
          : name === "prompt"
            ? { sessionId, prompt: [{ type: "text", text: phase }] }
            : {
                ...structuredClone(setup),
                sessionId,
                ...(version === 2 && label === "replay"
                  ? { replayFrom: { type: "start" } }
                  : {}),
              };
    const result =
      name === "new"
        ? { sessionId, ...structuredClone(settings) }
        : name === "list"
          ? {
              sessions: [
                { sessionId, cwd: "/workspace", title: null, updatedAt: null },
              ],
            }
          : name === "prompt"
            ? version === 1
              ? { stopReason: "end_turn" }
              : { messageId: resource("message", ordinal + 1) }
            : structuredClone(settings);
    const requestId = String(index + 1);
    return {
      requestId,
      method: `session/${name}`,
      ...(name === "list" ? {} : { sessionId }),
      inputSessionID: ["new", "list"].includes(name) ? null : sessionId,
      boundary: "private-acp",
      agentId,
      version,
      protocolVersion: version,
      transport,
      kind: name === "prompt" ? "ordinary" : "request",
      label: `${phase}:${label}`,
      outcome: "succeeded",
      requestReceipt: { requestId, params, result },
      ...(name === "prompt" ? { phase } : {}),
    };
  });
  const rows = [first, ...evidence];
  const result = {
    version,
    agent_id: agentId,
    transport,
    initialization: first,
    evidence,
    raw_frames: rows.map((row) => ({
      jsonrpc: "2.0",
      id: Number(row.requestId),
      result: structuredClone(
        row.initializationResult ?? row.requestReceipt.result,
      ),
    })),
    closed: true,
  };
  if (transport === "websocket") {
    result.requests = rows.map((row) => ({
      requestId: row.requestId,
      method: row.method,
      ...(row.inputSessionID === null ? {} : { sessionId: row.inputSessionID }),
    }));
  } else {
    const connectionID = `00000000-0000-4000-a000-${(ordinal + 1).toString().padStart(12, "0")}`;
    const requests = [];
    let activeSession = null;
    const wire = (method, rpc = undefined) => {
      const index = requests.length;
      const at = 2000 + ordinal * 100 + index * 10;
      const init = rpc?.method === "initialize";
      const cancelled = !init && method !== "DELETE";
      const receipt = {
        index,
        method,
        connectionID: init ? null : connectionID,
        sessionID: activeSession,
        status: init || method === "GET" ? 200 : 202,
        bodyOutcome: cancelled ? "cancelled" : "eof",
        bytes: init ? 500 : method === "GET" ? 100 : 0,
        failed: false,
        wireStarted: true,
        started: stamp(at),
        events: [
          { kind: "headers", ...stamp(at + 1) },
          { kind: cancelled ? "cancel" : "eof", ...stamp(at + 2) },
          { kind: "body_closed", ...stamp(at + 3) },
        ],
        rpcMethod: rpc?.method ?? null,
        requestID: rpc ? Number(rpc.requestId) : null,
        rpcSessionID: rpc?.inputSessionID ?? null,
        responseConnectionID: init ? connectionID : null,
        ended: stamp(at + 3),
      };
      requests.push(receipt);
      if (rpc)
        Object.assign(rpc, {
          httpRequestIndex: index,
          connectionID: receipt.connectionID,
        });
    };
    wire("POST", first);
    wire("GET");
    for (const row of evidence) {
      wire("POST", row);
      if (row.method !== "session/list" && activeSession === null) {
        activeSession = sessionId;
        wire("GET");
      }
    }
    wire("DELETE");
    const closeAt = requests.at(-1).started.monotonicMs;
    for (const receipt of requests) {
      if (receipt.bodyOutcome !== "cancelled") continue;
      receipt.events = [
        receipt.events[0],
        { kind: "cancel", ...stamp(closeAt + 1) },
        { kind: "body_closed", ...stamp(closeAt + 2) },
      ];
      receipt.ended = stamp(closeAt + 2);
    }
    result.http_connection = {
      initialized: true,
      closing: true,
      streamJoined: true,
      pendingRequests: 0,
      requests,
      failures: [],
    };
    for (const row of rows)
      row.httpConnection = structuredClone(result.http_connection);
  }
  return result;
}

export function stage3BusinessFixture(profile = "base") {
  const agentId = resource("agent", 1);
  const sessions = new Map();
  const session = (phase) => {
    if (!sessions.has(phase))
      sessions.set(phase, resource("session", sessions.size + 1));
    return sessions.get(phase);
  };
  const connections = [];
  const add = (phase, version, transport, mode) =>
    connections.push(
      connection(
        agentId,
        phase,
        session(phase),
        version,
        transport,
        mode,
        connections.length,
      ),
    );
  for (const [phase, version, transport] of [
    ["v1-baseline", 1, "websocket"],
    ["v2-baseline", 2, "websocket"],
    ["http-baseline", 1, "http"],
  ]) {
    add(phase, version, transport, "execute");
    add(phase, version, transport, "replay");
  }
  const extra =
    profile === "registry-outage"
      ? "registry-outage"
      : profile === "offline-reuse"
        ? "offline-reuse"
        : null;
  if (extra) {
    add(extra, 1, "websocket", "execute");
    add(extra, 1, "websocket", "replay");
  }
  add("v1-baseline", 1, "websocket", "replay");
  add("after-rebuild", 2, "websocket", "execute");
  add("after-rebuild", 2, "websocket", "replay");
  for (const version of [1, 2]) {
    add(`logout-v${version}`, version, "websocket", "new");
    add(`logout-v${version}`, version, "websocket", "replay");
  }
  const kinds = [
    "create",
    "disable",
    "enable",
    ...(profile === "offline-reuse" ? ["rebuild"] : []),
    "rebuild",
    "delete",
  ];
  const lifecycle = kinds.map((kind, index) => ({
    kind,
    agentId,
    requestId: `lifecycle-fixture-${index}-${kind}`,
    ...(["enable", "rebuild"].includes(kind) ? { skillPreparation: true } : {}),
    ...(profile === "restart-rebuild" && kind === "rebuild"
      ? { updateRestart: { fencedBeforeForward: true } }
      : {}),
    ...(profile === "registry-outage" && kind === "rebuild"
      ? { registryOutage: true }
      : {}),
  }));
  const runtime_operations = lifecycle.map((row, index) => ({
    kind: row.kind,
    request_id: runtimeCommandId(
      row.requestId,
      `runtime_${
        {
          create: "initialize",
          disable: "disable",
          enable: "enable",
          rebuild: "update",
          delete: "delete",
        }[row.kind]
      }`,
    ),
    target_revision: resource("rtv", index + 1),
    completed: true,
  }));
  const phases = [
    "v1-baseline",
    "v2-baseline",
    "http-baseline",
    ...(extra ? [extra] : []),
    "after-rebuild",
  ];
  const provider_requests = phases.flatMap((phase) =>
    ["tool", "reply"].map((stage) => ({
      phase,
      stage,
      ...(profile !== "base" && phase === "v1-baseline" && stage === "reply"
        ? { registry_network_denied: true }
        : {}),
    })),
  );
  const business = {
    resource_id_contract: "passed",
    status: "business_passed",
    agent_id: agentId,
    deleted: true,
    resources_joined: true,
    lifecycle_kinds: kinds,
    runtime_operations,
    transports: ["v1-ws", "v2-ws", "v1-http"],
    model_requests: provider_requests.length,
    provider_rotated: true,
    build_snapshot_preserved: true,
    rebuilt_workspace_preserved: true,
    revocations: [1, 2].map((version) => ({
      version,
      rejected: true,
      transport: "http-sse",
      denial_status: 401,
      recovered_empty: true,
    })),
    ...(profile === "base"
      ? {}
      : {
          immutable_skill_versions: [1, 2],
          registry_network_denial: {
            service_name: true,
            actual_ipv4_via_antnest0: true,
          },
        }),
    ...(profile === "restart-rebuild"
      ? {
          fenced_rebuild_restart: {
            status: "fenced_rebuild_restart_recovered",
            request_id: lifecycle.find((row) => row.kind === "rebuild")
              .requestId,
            controller_restarted: true,
            runtime_controller_restarted: true,
            admission_closed_during_restart: true,
          },
        }
      : {}),
    ...(profile === "registry-outage"
      ? {
          registry_outage: {
            status: "registry_outage_recovered",
            source_runtime_revision: resource("rtv", 3),
            preparation_state_while_offline: "retry_wait",
            source_run_completed: true,
            first_http_status: 503,
          },
        }
      : {}),
    ...(profile === "offline-reuse"
      ? {
          offline_skill_reuse: {
            status: "offline_skill_reuse_passed",
            source_runtime_revision: resource("rtv", 3),
            rebuilt_runtime_revision: resource("rtv", 4),
            skill_set_digest: "1".repeat(64),
          },
        }
      : {}),
  };
  const logouts = [1, 2].map((version) => ({
    ...logout(agentId, session(`logout-v${version}`), version),
    closingLifecycle: structuredClone(lifecycle.at(-1)),
  }));
  return {
    business,
    inventory: {
      requests: structuredClone(
        connections.flatMap((row) => [row.initialization, ...row.evidence]),
      ),
      provider_requests,
      lifecycle,
      connections,
    },
    logouts,
    cleanup: {
      entry_status: 0,
      client_status: 0,
      archive_status: 0,
      cleanup_status: 0,
    },
  };
}
