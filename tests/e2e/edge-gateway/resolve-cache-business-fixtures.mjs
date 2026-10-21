import { bridgeOutageFixture } from "./resolve-cache-bridge-outage-fixtures.mjs";
import { outageRejectionFixture } from "./resolve-cache-outage-rejection-fixtures.mjs";
import { rebuildTraceFixture } from "./resolve-cache-rebuild-trace-fixtures.mjs";
import { recoveryFixture } from "./resolve-cache-recovery-fixtures.mjs";

const project = "antnest-lifecycle-abcd1234";
const epoch = Date.parse("2026-10-14T00:00:00Z");
const iso = (at) => new Date(epoch + at).toISOString();
const scope = (family, index) =>
  `${family}-0000-4000-8000-${String(index).padStart(12, "0")}`;
const traceFields = new Set(["trace_id", "traceID", "model_span_id"]);
const monotonicFields = new Set([
  "at",
  "started_at",
  "headers_at",
  "stop_started_at",
  "restart_started_at",
]);

function walk(value, visit, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  visit(value);
  for (const child of Object.values(value)) walk(child, visit, seen);
}

// Each source remains one object graph: a response and its retained reference
// receive the same transformation once, including after Trace IDs are removed.
function normalize(value, offset, replacements = new Map()) {
  walk(value, (row) => {
    for (const [key, original] of Object.entries(row)) {
      if (traceFields.has(key)) {
        delete row[key];
      } else if (typeof original === "string") {
        if (replacements.has(original)) row[key] = replacements.get(original);
        else if (key === "path") {
          for (const [prefix, id] of [
            ["/agents/", "agent-1"],
            ["/sessions/", "session-1"],
            ["sessionId=", "session-1"],
            ["/operations/", "intent-1"],
            ["/execution-audits/", "run-1"],
          ])
            if (replacements.has(id))
              row[key] = row[key].replaceAll(
                prefix + id,
                prefix + replacements.get(id),
              );
        }
      } else if (monotonicFields.has(key) && Number.isFinite(original)) {
        row[key] = original + offset;
      }
    }
  });
  return value;
}

function containerState(service, id, at, start, finish, running = true) {
  return {
    id,
    project,
    service,
    running,
    restarting: false,
    oom_killed: false,
    exit_code: 0,
    health: running ? "healthy" : "unhealthy",
    started_at: iso(start),
    finished_at: iso(finish),
    at,
    observed_at_ms: epoch + at,
  };
}

const owner = {
  user_id: "owner",
  membership_id: "membership",
  organization_id: "org",
  organization_role: "member",
  active: true,
};
const administrator = {
  user_id: "administrator",
  membership_id: "admin-membership",
  organization_id: "org",
  organization_role: "admin",
  active: true,
};

function sessionBody(principal) {
  return {
    principal: { ...principal },
    expires_at: iso(86400000),
    idle_expires_at: iso(82800000),
    activity_interval_ms: 30000,
  };
}

// Compose existing hand-authored histories, never an archived live run.
export function outageBusinessFixture() {
  const evidence = normalize(
    bridgeOutageFixture(),
    9000,
    new Map([
      ["agent-1", "agent"],
      ["session-1", "chat"],
      ["run-1", "run"],
      ["intent-1", "intent"],
      ["user-1", "owner"],
      ["organization-1", "org"],
      ["outage-project", project],
    ]),
  );
  const rejection = normalize(outageRejectionFixture(4).evidence, 0);
  const rows = new Map(rejection.http.map((row) => [row.label, row]));
  const warmScope = rows.get("warm-login").issued_credential_scope;
  const adminScope = rows.get("audit-login").issued_credential_scope;
  const prepScope = scope("60000000", 1);
  evidence.http = rejection.http;
  evidence.settings = rejection.settings;
  evidence.rejections = rejection.rejections;
  evidence.cold_agent = rejection.cold_agent;
  evidence.cold_agent_setup = rejection.cold_agent_setup;

  for (const label of [
    "cold-console-login",
    "cold-workspace-login",
    "warm-login",
    "audit-login",
  ]) {
    rows.get(label).body = sessionBody(
      ["cold-console-login", "audit-login"].includes(label)
        ? administrator
        : owner,
    );
  }
  const short = evidence.rejections.expired_session;
  Object.assign(short.before, {
    expires_at: iso(86400000),
    idle_expires_at: iso(1800000),
    last_used_at: iso(0),
    issued_at: iso(0),
  });
  Object.assign(short.after, short.before, {
    idle_expires_at: iso(short.at + short.idle_ms),
  });
  rows.get("short-idle-login").body = {
    ...sessionBody(owner),
    ...short.before,
  };
  for (const label of ["short-idle-warm", "short-idle-hit"])
    rows.get(label).body = { ...short.after };
  for (const observation of short.observations) {
    Object.assign(observation, short.after);
    observation.remaining_ms = short.at + short.idle_ms - observation.at;
  }
  evidence.session_deadlines = {
    owner: rows.get("warm-login").body,
    admin: rows.get("audit-login").body,
  };

  const http = (label, path, started_at, at, extra = {}) => {
    const row = {
      label,
      path,
      method: "GET",
      status: 200,
      credential_scope: warmScope,
      set_cookie_count: 0,
      cache_control: "no-store",
      started_at,
      at,
      body: {},
      ...extra,
    };
    evidence.http.push(row);
    return row;
  };
  http("prep-login", "/api/session/login", 495, 500, {
    method: "POST",
    credential_scope: null,
    issued_credential_scope: prepScope,
    set_cookie_count: 2,
    body: sessionBody(owner),
  });
  http(
    "prep-session-create",
    "/api/app/workspace/v1/agents/agent/sessions",
    595,
    600,
    {
      method: "POST",
      status: 201,
      credential_scope: prepScope,
      request: {},
      body: { sessionId: "chat" },
    },
  );
  const viewPath = "/api/app/workspace/v1/agents/agent/sessions/chat/view";
  http("prep-view", viewPath, 695, 700, {
    credential_scope: prepScope,
    body: { agentId: "agent", sessionId: "chat", turns: [] },
  });
  http("warm-workspace-view", viewPath, 9095, 9100, {
    body: { agentId: "agent", sessionId: "chat", turns: [] },
  });
  for (const row of [evidence.prompt, evidence.cancel]) {
    row.credential_scope = warmScope;
    row.cache_control = "no-store";
  }
  for (const row of [evidence.audit_before, evidence.audit]) {
    row.credential_scope = adminScope;
    row.cache_control = "no-store";
  }
  evidence.http.push(
    evidence.prompt,
    evidence.cancel,
    evidence.audit_before,
    evidence.audit,
  );
  evidence.stream.credential_scope = warmScope;
  http("recovered-workspace-view", viewPath, 16195, 16200, {
    body: structuredClone(evidence.stream.records.at(-1).view.selectedView),
  });

  const identityID = evidence.identity.before.id;
  evidence.identity = {
    before: containerState("identity-service", identityID, 9100, 0, -1000),
    stop_started_at: 9900,
    stop_started_at_ms: epoch + 9900,
    stopped: containerState(
      "identity-service",
      identityID,
      10000,
      0,
      9950,
      false,
    ),
    stopped_end: containerState(
      "identity-service",
      identityID,
      15050,
      0,
      9950,
      false,
    ),
    restart_started_at: 15100,
    restart_started_at_ms: epoch + 15100,
    after: containerState("identity-service", identityID, 15200, 15150, 9950),
    healthy: containerState("identity-service", identityID, 16000, 15150, 9950),
  };
  evidence.consumer_restarts = ["agent-acp-service", "agent-ui"].map(
    (service, index) => {
      const id = String(index + 1).repeat(64);
      return {
        service,
        started_at: 8000,
        started_at_ms: epoch + 8000,
        before: containerState(service, id, 7900, 0, -1000),
        after: containerState(service, id, 8400, 8300, 8250),
      };
    },
  );
  evidence.consumer_configuration = {
    synchronization: http(
      "fresh-configuration-acknowledgement",
      "/api/admin/execution-synchronization",
      8410,
      8430,
      {
        credential_scope: adminScope,
        body: {
          synchronization: {
            revision: 8,
            applied_revision: 8,
            applied_at: iso(8420),
          },
        },
      },
    ),
    state: http(
      "fresh-configuration-state",
      "/api/app/workspace/v1/agents/agent/view",
      8440,
      8460,
      {
        body: {
          agentId: "agent",
          availability: "ready",
          activeSessionId: null,
        },
      },
    ),
  };
  const original = evidence.runtime;
  Object.assign(original.container, {
    generation: 1,
    volume: "workspace",
    started_at: iso(0),
  });
  for (const key of ["started", "before_cancel", "quiescent"]) {
    original[key].container = structuredClone(original.container);
    Object.assign(original[key].status, { agent_id: "agent", generation: 1 });
  }

  const rebuild = normalize(
    rebuildTraceFixture({ status: 503, early: false }).evidence,
    20000,
    new Map([
      ["session", "chat"],
      ["project", project],
      ["admin-scope", adminScope],
    ]),
  );
  const preparation = rebuild.recovery_preparation;
  for (const side of [preparation.before, preparation.after]) {
    side.run.body = structuredClone(evidence.audit.body);
    side.inventory.body.items = [structuredClone(evidence.audit.body)];
    side.stored.record = structuredClone(evidence.run_storage.after.record);
  }
  const fresh = preparation.runtime;
  fresh.container = {
    ...original.container,
    id: "f".repeat(64),
    generation: 2,
    started_at: iso(fresh.observation.started_at - 1),
  };
  fresh.observation.container = fresh.container;
  fresh.observation.work.effects = original.quiescent.work.effects;
  fresh.observations = [fresh.observation];
  evidence.recovery_preparation = preparation;
  evidence.http.push(...preparation.responses);

  const replacements = new Map([
    ["user", "owner"],
    ["admin-scope", adminScope],
  ]);
  for (let index = 0; index < 4; index++) {
    replacements.set(
      scope("00000000", index + 1),
      scope("20000000", index + 1),
    );
    replacements.set(
      scope("10000000", index + 1),
      scope("30000000", index + 1),
    );
    replacements.set(`fresh-${index}`, scope("40000000", index + 1));
  }
  replacements.set("rotated-password-scope", scope("50000000", 1));
  const recovery = normalize(recoveryFixture(), 30000, replacements);
  for (const [index, row] of recovery.http.entries()) {
    row.label = `recovery-http-${index}`;
    row.cache_control ??= "no-store";
    if (row.credential_scope === undefined)
      row.credential_scope =
        row.path === "/api/session/login" ? null : adminScope;
    if (row.status === 401) row.body.code = "unauthenticated";
  }
  for (const entry of recovery.recovery.cases) {
    entry.agent_id = "agent";
    entry.owner_id = "owner";
    for (const login of [entry.login, entry.peer_login, entry.fresh_login]) {
      login.body.expires_at = iso(86400000);
      login.body.idle_expires_at = iso(82800000);
    }
    entry.stream.started_at_ms = epoch + entry.stream.started_at;
    entry.stream.joined = { at: entry.stream.closure.at + 10 };
    if (entry.restore) entry.restore.credential_scope = adminScope;
  }
  evidence.recovery = recovery.recovery;
  evidence.model_observations = [
    evidence.model_started,
    evidence.model_cancelled,
    ...recovery.model_observations,
  ];
  evidence.http.push(...recovery.http);
  const password = evidence.recovery.cases.find(
    (entry) => entry.name === "password",
  );
  evidence.stream.closure = {
    kind: "remote-end",
    at: password.trigger.at + 20,
  };
  evidence.stream.joined = { at: evidence.stream.closure.at + 10 };
  evidence.stream.started_at_ms = epoch + evidence.stream.started_at;
  const ui = evidence.consumer_restarts.find(
    (entry) => entry.service === "agent-ui",
  );
  evidence.ui_drain = {
    log_checked: true,
    forced_drain: false,
    log_sha256: "a".repeat(64),
    started_at: 40010,
    started_at_ms: epoch + 40010,
    before: containerState("agent-ui", ui.after.id, 40000, 8300, 8250),
    after: containerState("agent-ui", ui.after.id, 40020, 8300, 40015, false),
  };

  walk(evidence, (row) => {
    for (const key of traceFields) delete row[key];
    if (Number.isFinite(row.at)) row.observed_at_ms = epoch + row.at;
    if (row.path && Number.isFinite(row.at))
      row.server_date = new Date(epoch + row.at).toUTCString();
    if (
      row.method === "GET" &&
      row.status === 200 &&
      typeof row.path === "string"
    ) {
      const view =
        /^\/api\/app\/workspace\/v1\/agents\/([^/]+)(?:\/sessions\/([^/]+))?\/view$/u.exec(
          new URL(row.path, "http://fixture.invalid").pathname,
        );
      if (view) {
        row.body.agentId = decodeURIComponent(view[1]);
        if (view[2]) row.body.sessionId = decodeURIComponent(view[2]);
        row.body.bridgeEpoch =
          row.label === "prep-view" ? "ui-epoch-before" : "ui-epoch-after";
      }
    }
  });
  return evidence;
}
