import assert from "node:assert/strict";
import { readProcesses } from "./process.mjs";
import { runtimeBinding } from "./current-evidence.mjs";

const clone = (value) => structuredClone(value);
const setup = { cwd: "/workspace", mcpServers: [] };
const processLine = "41 (bash) S 1 41 0\n";
const revokedTraceID = "9".repeat(32);

export function workspaceBusinessFixture() {
  const events = [],
    observations = [],
    requests = [],
    clients = [],
    watches = [];
  const principal = { organization_id: "org", user_id: "owner" };
  const state = {
    generation: 1,
    created: false,
    disabled: false,
    deleted: false,
    revoked: false,
    networkState: "open",
    cancelAlive: false,
    cancelled: false,
    offlineAlive: false,
    offlineReleased: false,
    probeRejected: false,
    sessions: [],
    providers: [],
    runs: [],
    runEvents: {},
    lifecycle: [],
    lifecycleEvents: [],
    held: [],
    persisted: [],
    business: {},
    deniedConnections: [],
    offboarding: null,
    revocationBegin: null,
    revocation: null,
    time: 1000,
  };
  const now = () => ++state.time;
  const view = (
    availability,
    activeSession = null,
    reason = null,
    allowed = true,
  ) => ({
    agent_id: "agent",
    access_allowed: allowed,
    availability,
    active_session_id: activeSession,
    configuration_revision: allowed
      ? String(state.generation).repeat(64)
      : null,
    unavailable_reason: reason,
  });
  state.execution = view("ready");
  const emit = (value) => {
    state.execution = clone(value);
    for (const watch of watches)
      if (!watch.closed) watch.states.push(clone(value));
  };
  const scoped = (agentID, browser, actualPrincipal) => {
    assert.equal(agentID, "agent");
    assert.strictEqual(browser, owner);
    assert.deepEqual(actualPrincipal, principal);
  };
  const observed = () => ({
    agent: {
      agent_id: "agent",
      owner_user_id: "owner",
      lifecycle_state: "created",
      activation_state: "enabled",
      desired_state: "enabled",
      runtime_state: "available",
      executable_execution_revision: `execution-${state.generation}`,
      runtime: { runtime_revision: `runtime-${state.generation}` },
    },
    container: {
      Id: `runtime-container-${state.generation}`,
      Config: {
        Labels: {
          "io.antnest.agent-id": "agent",
          "io.antnest.runtime-generation": String(state.generation),
        },
      },
      State: { Running: true, Health: { Status: "healthy" } },
    },
    volume: "workspace",
    skillVolume: "skills",
    receiverVolume: `receiver-${state.generation}`,
  });
  function provider(phase, stage) {
    state.providers.push({
      phase,
      stage,
      received_at_ms: now(),
      trace_id: (100 + state.providers.length).toString(16).padStart(32, "0"),
      model_span_id: (100 + state.providers.length)
        .toString(16)
        .padStart(16, "0"),
    });
  }
  function addRun(phase) {
    const cancelled = phase === "c4-cancel";
    const suffix = phase.slice(3);
    const run = {
      run_id: `run-${suffix}`,
      agent_id: "agent",
      session_id: cancelled ? "S1" : "S2",
      principal_id: "owner",
      input: [{ type: "text", text: phase }],
      execution_snapshot: {
        executionRevision: `execution-${state.generation}`,
      },
      state: cancelled ? "unresolved" : "completed",
      terminal_class: cancelled ? "unresolved" : "completed",
      executor_state: "quiescent",
      tool_effect_state: cancelled ? "unknown" : "settled",
      error_class: cancelled ? "cancelled_tool_outcome_unknown" : null,
      unknown_effect_source: cancelled ? "runtime_mcp" : null,
      stop_reason: cancelled ? null : "end_turn",
    };
    state.runs.push(run);
    state.runEvents[run.run_id] = {
      items: [
        {
          run_id: run.run_id,
          sequence: 1,
          kind: "tool_call",
          payload: {
            toolCallId: `tool-${suffix}`,
            status: cancelled ? "failed" : "completed",
            content: [{ type: "text", text: `${phase} durable history` }],
          },
        },
      ],
      next_cursor: null,
    };
  }
  function answer(client, text) {
    client.updates.push({
      sessionId: "S2",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    });
  }
  function record(client, method, params) {
    const row = {
      agentId: "agent",
      connectionTraceID: client.connectionTraceID,
      clientSpanID: client.clientSpanID,
      transport: "websocket",
      protocolVersion: 1,
      kind: "request",
      method,
      requestId: String(client.requests.length + 1),
      requestParams: clone(params),
      inputSessionID: params.sessionId ?? null,
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    };
    client.requests.push(row);
    requests.push(row);
    events.push(["request", client.index, method, clone(params)]);
    return row;
  }
  function completed(row, result) {
    row.outcome = "completed";
    row.requestResult = clone(result);
    row.response = { id: row.requestId, result: clone(result) };
    if (result.sessionId) row.sessionId = result.sessionId;
    return clone(result);
  }
  function rejected(row, code) {
    const error = new Error(`Operation reported ${code}`);
    error.code = -32020;
    error.data = { code, retryable: false };
    row.outcome = "rejected";
    row.rejection = code;
    row.rejectionReceipt = { rpcCode: -32020, code, retryable: false };
    row.response = {
      id: row.requestId,
      error: {
        code: error.code,
        message: error.message,
        data: clone(error.data),
      },
    };
    return error;
  }
  function endWatch(watch, kind, bodyOutcome) {
    if (!watch.closed) {
      watch.closed = true;
      watch.closure = {
        traceID: watch.traceID,
        kind,
        observedAt: now(),
        receivedEvents: watch.states.length,
      };
      watch.bodyOutcome = bodyOutcome;
      events.push(["watch-close", watch.index, kind]);
    }
  }
  function makeClient() {
    const index = clients.length + 1;
    if (index > 5 || state.revoked)
      assert.fail("unexpected successful Workspace connection");
    const sequence = [
      ["new", "new", "c4-cancel"],
      ["load", "agent_busy", "runtime_barrier_required"],
      ["load", "c4-offline"],
      ["load"],
      ["load", "c4-rebuilt", "access_denied"],
    ][index - 1];
    let cursor = 0,
      pending;
    const client = {
      index,
      connectionTraceID: String(index).repeat(32),
      clientSpanID: String(index).repeat(16),
      requests: [],
      updates: [],
      notificationReceipts: [],
      disconnectReceipts: [],
      closed: false,
      localCloseError: new Error(`fixture connection ${index} local close`),
      async initialize() {
        assert.fail("fixture opener already initialized the connection");
      },
      async request(method, params) {
        if (client.closed)
          assert.fail("request on a closed fixture connection");
        const step = sequence[cursor++];
        if (!step) assert.fail("unexpected Workspace business request");
        if (step === "new" || step === "load") {
          assert.equal(method, step);
          assert.deepEqual(
            params,
            step === "new" ? setup : { ...setup, sessionId: "S2" },
          );
          const row = record(client, `session/${method}`, params);
          if (step === "new") {
            const sessionId = `S${state.sessions.length + 1}`;
            state.sessions.push(sessionId);
            return completed(row, { sessionId });
          }
          if (state.offlineReleased) answer(client, "c4-offline completed");
          return completed(row, {});
        }
        assert.equal(method, "prompt");
        const phase = step.startsWith("c4-") ? step : "must-not-execute";
        assert.deepEqual(params, {
          sessionId: step === "c4-cancel" ? "S1" : "S2",
          prompt: [{ type: "text", text: phase }],
        });
        const row = record(client, "session/prompt", params);
        if (
          ["agent_busy", "runtime_barrier_required", "access_denied"].includes(
            step,
          )
        ) {
          if (step === "agent_busy")
            assert(state.cancelAlive && !state.cancelled);
          if (step === "runtime_barrier_required") assert(state.cancelled);
          if (step === "access_denied") {
            assert(state.revoked);
            state.probeRejected = true;
          }
          throw rejected(row, step);
        }
        provider(step, "tool");
        emit(view("busy", params.sessionId));
        if (step === "c4-rebuilt") {
          provider(step, "reply");
          addRun(step);
          answer(client, "c4-rebuilt completed");
          emit(view("ready"));
          return completed(row, { stopReason: "end_turn" });
        }
        if (step === "c4-cancel") state.cancelAlive = true;
        else state.offlineAlive = true;
        const deferred = Promise.withResolvers();
        pending = { ...deferred, phase: step, row };
        row.outcome = "pending";
        return deferred.promise;
      },
      async notify(method, params) {
        if (index !== 2 || cursor !== 2 || state.cancelled)
          assert.fail("unexpected Workspace notification");
        assert.equal(method, "cancel");
        assert.deepEqual(params, { sessionId: "S1" });
        events.push(["notify", index, "session/cancel", clone(params)]);
        client.notificationReceipts.push({
          agentId: "agent",
          connectionTraceID: client.connectionTraceID,
          clientSpanID: client.clientSpanID,
          method: "session/cancel",
          sessionId: "S1",
          origin: "notify",
          index: 0,
          status: "write_completed",
          wireObserved: true,
          writeOutcome: "completed",
        });
        state.cancelAlive = false;
        state.cancelled = true;
        addRun("c4-cancel");
        emit(view("offline", null, "runtime_barrier_required"));
      },
      async disconnectPending(phase) {
        if (!pending || pending.phase !== phase || client.closed)
          assert.fail("unexpected pending Workspace disconnect");
        const current = pending;
        pending = undefined;
        current.row.outcome = "failed";
        current.row.failure = client.localCloseError.message;
        current.row.response_absent = true;
        client.disconnectReceipts.push({
          phase,
          sessionId: current.row.sessionId,
          requestId: current.row.requestId,
          connectionTraceID: client.connectionTraceID,
        });
        events.push(["disconnect", index, phase]);
        current.reject(client.localCloseError);
        return client.closeAndWait();
      },
      isLocalCloseError(error) {
        return error === client.localCloseError;
      },
      async closeAndWait() {
        if (!client.closed) {
          client.closed = true;
          if (pending) {
            pending.reject(client.localCloseError);
            pending = undefined;
          }
          events.push(["client-close", index]);
        }
        return client.snapshot();
      },
      snapshot() {
        return clone({
          agentId: "agent",
          connectionTraceID: client.connectionTraceID,
          closed: client.closed,
          initialization: client.requests[0],
          evidence: client.requests.slice(1),
          notifications: client.notificationReceipts,
          deliberate_disconnects: client.disconnectReceipts,
        });
      },
    };
    clients.push(client);
    events.push(["open", index]);
    const initialization = record(client, "initialize", { protocolVersion: 1 });
    completed(initialization, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
    });
    return client;
  }
  function makeWatch() {
    const index = watches.length + 1;
    if (index > 2) assert.fail("unexpected Workspace watch");
    const watch = {
      index,
      traceID: String(index + 5).repeat(32),
      clientSpanID: String(index + 5).repeat(16),
      states: [clone(state.execution)],
      closed: false,
      closure: null,
      assertOpen() {
        assert(!watch.closed, "fixture watch already closed");
      },
      async wait(predicate, after = 0) {
        const value = watch.states.slice(after).find(predicate);
        if (!value) assert.fail("expected Workspace state was not recorded");
        events.push(["watch-wait", index, after, clone(value)]);
        return value;
      },
      async waitClosed() {
        assert(watch.closed, "fixture watch has not reached EOF");
        return clone(watch.closure);
      },
      async closeAndWait() {
        endWatch(watch, "local-close", "cancelled");
        return watch.snapshot();
      },
      snapshot() {
        return clone({
          agentId: "agent",
          traceID: watch.traceID,
          clientSpanID: watch.clientSpanID,
          events: watch.states,
          closure: watch.closure,
          joined: watch.closed,
          body_outcome: watch.bodyOutcome,
        });
      },
    };
    watches.push(watch);
    events.push(["watch", index]);
    return watch;
  }
  const owner = {
    accessToken: "original-session",
    cookies: new Map([["antnest_session", "original-session"]]),
    async request(path, options) {
      if (path !== "/api/session/login")
        assert.fail("unexpected owner request");
      assert.deepEqual(options.body, {
        organization_slug: "stage3",
        email: "lifecycle-owner@example.com",
        password: "lifecycle-owner-password",
      });
      events.push(["login", clone(options.body)]);
      return clone({
        status: 200,
        traceID: "a".repeat(32),
        body: { principal },
      });
    },
  };
  const input = {
    config: {
      project: "antnest-lifecycle-12345678",
      evidence: "/fixture/evidence",
    },
    signal: new AbortController().signal,
    principal: encodeURIComponent(JSON.stringify(["org", "admin"])),
    agentBody: {
      owner_user_id: "owner",
      template_id: "template",
      template_revision: 7,
    },
    traceSecrets: [],
    async ready(agentID) {
      assert.equal(agentID, "agent");
      events.push(["ready", state.generation]);
      return clone(observed());
    },
    async command(kind, agentID, body, expectation = {}) {
      const expectedKind = ["create", "rebuild", "rebuild", "delete"][
        state.lifecycle.length
      ];
      if (kind !== expectedKind)
        assert.fail("unexpected Workspace lifecycle command");
      assert.equal(agentID, kind === "create" ? undefined : "agent");
      if (kind === "create") assert.deepEqual(body, input.agentBody);
      else if (kind === "rebuild")
        assert.deepEqual(body, {
          template_id: "template",
          template_revision: 7,
        });
      else assert.deepEqual(body, {});
      const row = {
        kind,
        agentID: "agent",
        requestID: `lifecycle-${state.lifecycle.length + 1}`,
        traceID: String(state.lifecycle.length + 1).repeat(32),
        expectation: clone(expectation),
      };
      state.lifecycle.push(row);
      events.push(["command", kind, clone(body), clone(expectation)]);
      if (kind === "create") state.created = true;
      if (kind === "rebuild") {
        if (state.generation === 2)
          emit(view("offline", null, "agent_unavailable"));
        state.generation++;
        emit(view("ready"));
      }
      if (kind === "delete") state.deleted = true;
      state.lifecycleEvents.push({
        event_id: row.requestID,
        event_type:
          kind === "create"
            ? "agent_created"
            : kind === "delete"
              ? "agent_deleted"
              : "agent_rebuilt",
        trace_id: row.traceID,
        operation_request_id: row.requestID,
      });
      return clone(row);
    },
    async resources(agentID) {
      assert.equal(agentID, "agent");
      if (state.deleted) return { containers: [], volumes: [] };
      if (state.disabled)
        return { containers: [], volumes: ["workspace", "skills"] };
      return clone({
        containers: [observed().container],
        volumes: ["workspace", "skills", `receiver-${state.generation}`],
      });
    },
    async json(path) {
      events.push(["json", path]);
      if (path === "/api/admin/execution-audits?agent_id=agent&limit=100")
        return clone({
          items: state.runs.map(({ run_id, session_id, agent_id }) => ({
            run_id,
            session_id,
            agent_id,
          })),
          next_cursor: null,
        });
      const audit =
        /^\/api\/admin\/execution-audits\/([^/?]+)(\/events\?limit=100)?$/u.exec(
          path,
        );
      if (audit) {
        const run = state.runs.find((row) => row.run_id === audit[1]);
        if (!run) assert.fail("unknown fixture Run");
        return clone(audit[2] ? state.runEvents[run.run_id] : run);
      }
      if (path === "/api/admin/agents/agent") {
        const agent = observed().agent;
        if (state.disabled) {
          agent.activation_state = "disabled";
          agent.desired_state = "disabled";
          agent.runtime_state = "absent";
          delete agent.executable_execution_revision;
          delete agent.runtime;
        }
        return clone(agent);
      }
      if (path === "/api/admin/agents/agent/events?limit=100")
        return clone({ events: state.lifecycleEvents });
      if (path === "/api/admin/agents/agent/network-policy")
        return { attachment: { state: state.networkState } };
      assert.fail(`unexpected fixture JSON path ${path}`);
    },
    async api(path, options) {
      if (path !== "/api/admin/directory/users/owner/active")
        assert.fail("unexpected fixture API request");
      assert.deepEqual(options.body, { active: false });
      assert(state.revocationBegin, "revocation baseline was not recorded");
      events.push(["api", path, clone(options)]);
      state.revoked = true;
      state.disabled = true;
      state.networkState = "closed";
      emit(view("offline", null, "access_denied", false));
      endWatch(watches[1], "transport-end", "eof");
      state.lifecycleEvents.push(
        {
          event_id: "owner-revoked",
          event_type: "agent_owner_revoked",
          trace_id: revokedTraceID,
        },
        {
          event_id: "automatic-disable",
          event_type: "agent_disabled",
          trace_id: revokedTraceID,
          operation_request_id: "automatic-disable-request",
        },
      );
      events.push(["automatic-disable", "automatic-disable-request"]);
      return {
        status: 200,
        body: { user_id: "owner", active: false },
        headers: new Headers({ "x-antnest-trace-id": revokedTraceID }),
        traceID: revokedTraceID,
      };
    },
    async docker(args) {
      assert.deepEqual(args.slice(0, 3), ["exec", "--user", "1000:1000"]);
      assert.equal(args[3], `runtime-container-${state.generation}`);
      assert.deepEqual(args.slice(4, 6), ["sh", "-c"]);
      assert.equal(args.length, 7);
      const shell = args[6];
      events.push(["docker", args[3], shell]);
      if (
        shell ===
        "if [ -f /workspace/.c4-cancel-started ]; then cat /workspace/.c4-cancel-started; fi"
      ) {
        assert(state.cancelAlive);
        return "41";
      }
      if (
        shell ===
        "if [ -f /workspace/.c4-offline-started ]; then cat /workspace/.c4-offline-started; fi"
      ) {
        assert(state.offlineAlive);
        return "51";
      }
      if (shell === "kill -0 41") {
        assert(state.cancelAlive);
        return "";
      }
      if (shell === "kill -0 51") {
        assert(state.offlineAlive);
        return "";
      }
      if (shell === "cat /proc/41/stat") return processLine;
      if (shell === readProcesses) return state.cancelAlive ? processLine : "";
      if (shell === "base64 -w 0 /workspace/.c4-cancel-effects")
        return Buffer.from("started\n").toString("base64");
      if (shell === "base64 -w 0 /workspace/.c4-offline-effects") {
        assert(state.offlineReleased);
        return Buffer.from("started\nfinished\n").toString("base64");
      }
      if (shell === "touch /workspace/.c4-offline-release") {
        assert(state.offlineAlive && !state.offlineReleased);
        state.offlineAlive = false;
        state.offlineReleased = true;
        provider("c4-offline", "reply");
        addRun("c4-offline");
        emit(view("ready"));
        return "";
      }
      assert.fail(`unexpected fixture Docker shell ${shell}`);
    },
  };
  const work = {
    record(name, value) {
      assert(!Object.hasOwn(state.business, name));
      state.business[name] = clone(value);
    },
    owner: () => owner,
    login(browser, response, agent, agentID) {
      scoped(agentID, browser, response.body.principal);
      events.push(["bind-login", agent.agent_id]);
      return clone(principal);
    },
    remember(client, method, annotation = {}) {
      const row = client.requests
        .filter((item) => item.method === method)
        .at(-1);
      if (!row) assert.fail("fixture has no matching actual request");
      const value = {
        ...clone(row),
        kind: "request",
        label: `workspace-${observations.length}-${method}`,
        ...clone(annotation),
      };
      observations.push(value);
      return value;
    },
    async binding(value) {
      const match = /^runtime-container-([1-3])$/u.exec(value.container.Id);
      if (!match) assert.fail("unknown fixture Runtime");
      const generation = Number(match[1]);
      return runtimeBinding(value, {
        agent_id: "agent",
        generation,
        execution_id: `process-${generation}`,
        status: "ready",
        test_features: [],
      });
    },
    async persist(name, value) {
      if (
        ![
          "cancelled-audit",
          "offline-audit",
          "rebuilt-audit",
          "offboarding",
          "model",
        ].includes(name)
      )
        assert.fail("unexpected fixture persistence");
      state.persisted.push({ name, value: clone(value) });
      events.push(["persist", name, clone(value)]);
    },
    modelState: async () => clone(state.providers),
    async open(agentID, browser, actualPrincipal) {
      scoped(agentID, browser, actualPrincipal);
      return makeClient();
    },
    async watch(agentID, browser, actualPrincipal) {
      scoped(agentID, browser, actualPrincipal);
      return makeWatch();
    },
    async state(agentID, browser, actualPrincipal) {
      scoped(agentID, browser, actualPrincipal);
      return clone(state.execution);
    },
    async closeWatch(watch) {
      watch.assertOpen();
      watch.stopWindow = { start: now() };
      await watch.closeAndWait();
      watch.stopWindow.end = now();
    },
    hold(promise) {
      state.held.push(promise);
      events.push(["hold", state.held.length]);
      return promise;
    },
    beginRevocation(watch) {
      assert.strictEqual(watch, watches[1]);
      watch.assertOpen();
      const baseline = {
        traceID: watch.traceID,
        clientSpanID: watch.clientSpanID,
        observedAt: now(),
        receivedEvents: watch.states.length,
      };
      state.revocationBegin = clone(baseline);
      events.push(["begin-revocation", clone(baseline)]);
      return clone(baseline);
    },
    async revoked(watch, traceID) {
      assert.equal(traceID, revokedTraceID);
      await watch.waitClosed();
      state.revocation = {
        traceID,
        terminal: clone(watch.states.at(-1)),
        closure: clone(watch.closure),
        body_outcome: watch.bodyOutcome,
      };
      events.push(["revoked", clone(state.revocation)]);
    },
    async denyNewConnection(agentID, browser, actualPrincipal, { after }) {
      scoped(agentID, browser, actualPrincipal);
      assert(state.revoked && state.probeRejected);
      assert.equal(after, state.revocationBegin.observedAt);
      const receipt = {
        status: 401,
        body: {
          code: "unauthenticated",
          message: "Authentication failed",
          retryable: false,
        },
        traceID: "8".repeat(32),
        clientSpanID: "8".repeat(16),
        response_trace_id: null,
        startedAt: now(),
      };
      state.deniedConnections.push(clone(receipt));
      events.push(["denied-connection", clone(receipt)]);
      return clone(receipt);
    },
    offboarding(expected) {
      state.offboarding = clone(expected);
      events.push(["offboarding", clone(expected)]);
    },
  };
  return {
    input,
    work,
    events,
    observations,
    requests,
    clients,
    watches,
    state,
  };
}
