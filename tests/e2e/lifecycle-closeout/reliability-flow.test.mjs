import assert from "node:assert/strict";
import test from "node:test";
import { runReliability } from "./reliability-flow.mjs";
import {
  cancelDeleteRequestID,
  gcDeleteRequestID,
  gcScheduledEventID,
} from "./reliability-evidence.mjs";

// Strict injected fixture: every external effect goes through the scripted
// docker/api/json/resources/ready surfaces; no real Docker, services or DB.
// mutate(state) is applied immediately before runReliability for counterexamples.
async function scenario(mutate) {
  const calls = { api: [], json: [], docker: [], exec: [] };
  const state = {
    createSeq: 0,
    agents: new Map(),
    operations: new Map(),
    events: new Map(),
    held: false,
    egressStopped: false,
    proxyStatus: {
      armed: false,
      agent_id: "",
      request_id: "",
      held: 0,
      records: [],
    },
  };
  const event = (agentID, type, requestID, data = {}) => {
    const list = state.events.get(agentID) ?? [];
    list.push({
      event_id: `event-${list.length + 1}`,
      global_sequence: list.length + 1,
      aggregate_sequence: list.length + 1,
      agent_id: agentID,
      event_type: type,
      operation_request_id: requestID,
      data,
    });
    state.events.set(agentID, list);
  };
  const docker = async (args, long = false, options = {}) => {
    calls.docker.push(args.join(" "));
    assert.equal(
      typeof long,
      "boolean",
      "docker must receive a boolean long flag",
    );
    if (args.join(" ").includes("reliability-proxy")) {
      assert.equal(
        options.timeoutMS,
        10000,
        "proxy controls must be bounded at 10s",
      );
      assert("signal" in options, "proxy controls must receive a signal");
    }
    const joined = args.join(" ");
    if (joined.includes("reliability-proxy") && joined.includes("ps"))
      return "proxy-id\n";
    if (joined.includes(" ps ") && joined.includes("-aq")) return "service-1\n";
    if (joined.startsWith("exec proxy-id node -e")) {
      calls.exec.push(joined);
      if (joined.includes("/__test/arm")) state.proxyStatus.armed = true;
      if (joined.includes("/__test/release")) {
        state.proxyStatus.armed = false;
        state.proxyStatus.held = 0;
      }
      return JSON.stringify(state.proxyStatus);
    }
    if (joined.includes("psql")) {
      if (joined.includes("egress")) {
        return JSON.stringify(
          state.openEgress
            ? {
                allocation_state: "active",
                attachment_state: "open",
                keys_absent: false,
                attachment_safe: false,
              }
            : {
                allocation_state: "quarantined",
                attachment_state: "closed",
                keys_absent: true,
                attachment_safe: true,
              },
        );
      }
      return JSON.stringify({
        request_id: args[args.length - 1] ?? "request",
        source_failed_create_request_id: "request-create-1",
        child_request_id: "request-runtime-child",
        phase: "runtime_initialize",
      });
    }
    if (joined.includes("stop")) {
      state.egressStopped = true;
      return "";
    }
    if (joined.includes("start")) {
      state.egressStopped = false;
      return "";
    }
    if (joined.includes("inspect")) {
      const isProxy = joined.includes("proxy-id");
      return JSON.stringify([
        {
          Id: isProxy ? "proxy-id" : "service-1",
          Config: {
            Labels: isProxy
              ? {
                  "com.docker.compose.project": "antnest-lifecycle-deadbeef",
                  "com.docker.compose.service": "reliability-proxy",
                }
              : {},
          },
          State: { Running: true, Health: { Status: "healthy" } },
        },
      ]);
    }
    if (joined.includes("compose") || joined.includes("up")) return "";
    return "";
  };
  const api = async (path, options = {}) => {
    calls.api.push(path);
    const mergedHeaders = new Headers({
      "Idempotency-Key": "gateway-generated-key",
      ...options.headers,
    });
    const key = mergedHeaders.get("Idempotency-Key");
    assert(
      key && !key.includes(","),
      "the Gateway must receive exactly one Idempotency-Key",
    );
    if (options.status === 202 && key && state.byKey?.has(key)) {
      return { status: 202, body: state.byKey.get(key) };
    }
    if (options.status === 202) {
      if (path.includes("lifecycle-operation/cancel")) {
        const agentID = path.split("/")[4];
        const record = state.proxyStatus.records[0];
        if (record) record.delivery = "caller_disconnected";
        state.proxyStatus.held = 0;
        const cancelled = state.operations.get(
          `request-create-${state.createSeq}`,
        );
        if (cancelled) {
          cancelled.state = "failed";
          cancelled.error_code = "lifecycle_cancelled";
        }
        state.held = false;
        (state.deleted ??= new Set()).add(agentID);
        const agent = state.agents.get(agentID);
        if (agent) {
          event(
            agentID,
            "agent_lifecycle_cancelled",
            cancelled?.request_id ?? "request",
            { failure_code: "lifecycle_cancelled" },
          );
          const childID = cancelDeleteRequestID(cancelled?.request_id ?? "");
          event(agentID, "agent_delete_requested", childID);
          event(agentID, "agent_deleted", childID);
          state.operations.set(childID, {
            request_id: childID,
            agent_id: agentID,
            kind: "delete",
            state: "completed",
            phase: "drain",
          });
        }
        return { status: 202, body: { request_id: "request-cancel" } };
      }
      if (path === "/api/admin/agents") {
        const agentID = `agent-${++state.createSeq}`;
        const requestID = `request-create-${state.createSeq}`;
        const agent = {
          agent_id: agentID,
          lifecycle_state: "not_created",
          desired_state: "enabled",
          readiness: "preparing",
          failure_stage: "",
          failure_code: "",
          aggregate_sequence: 1,
        };
        state.agents.set(agentID, agent);
        state.events.set(agentID, []);
        event(agentID, "agent_create_requested", requestID);
        state.operations.set(requestID, {
          request_id: requestID,
          agent_id: agentID,
          kind: "create",
          state: "running",
          phase: "drain",
        });
        if (state.proxyStatus.armed) {
          state.held = true;
          // The held effect: the create produces a real completed
          // initialize receipt that stays held for the frozen selection.
          state.proxyStatus.agent_id = agentID;
          state.proxyStatus.request_id = "request-runtime-child";
          state.proxyStatus.held = 1;
          state.proxyStatus.records = [
            {
              agent_id: agentID,
              request_id: "request-runtime-child",
              status: 200,
              target_revision: "rtv-1",
              delivery: "held",
            },
          ];
        }
        const seqNo = state.createSeq;
        if (seqNo === 3) {
          const op = state.operations.get(requestID);
          op.state = "completed";
          agent.lifecycle_state = "created";
          agent.readiness = "ready";
          agent.executable_execution_revision = `exec-${agentID}`;
          event(agentID, "agent_ready", requestID);
          return { status: 202, body: { agent, operation: op } };
        }
        setTimeout(() => {
          const op = state.operations.get(requestID);
          if (op.state !== "running") return; // cancelled ops are durable
          const phase = seqNo === 4 ? "runtime_initialize" : "network_ensure";
          op.state = "failed";
          op.phase = phase;
          op.error_code = "phase_deadline_exceeded";
          agent.failure_stage = phase;
          agent.failure_code = "phase_deadline_exceeded";
          agent.lifecycle_state = "not_created";
          event(agentID, "agent_build_failed", requestID, {
            failure_code: "phase_deadline_exceeded",
            failure_stage: phase,
          });
          if (seqNo === 4) {
            const deleteID = gcDeleteRequestID(requestID);
            const eventID = gcScheduledEventID(requestID);
            state.events.get(agentID).push({
              event_id: eventID,
              global_sequence: state.events.get(agentID).length + 1,
              aggregate_sequence: state.events.get(agentID).length + 1,
              agent_id: agentID,
              event_type: "agent_gc_scheduled",
              operation_request_id: deleteID,
              data: {
                create_request_id: requestID,
                delete_request_id: deleteID,
              },
            });
            event(agentID, "agent_delete_requested", deleteID);
            event(agentID, "agent_deleted", deleteID);
            state.operations.set(deleteID, {
              request_id: deleteID,
              agent_id: agentID,
              kind: "delete",
              state: "completed",
              phase: "drain",
            });
            (state.deleted ??= new Set()).add(agentID);
          }
        }, 0);
        const admitted = { agent, operation: state.operations.get(requestID) };
        if (key) (state.byKey ??= new Map()).set(key, admitted);
        return { status: 202, body: admitted };
      }
      const requestID = `request-mutation-${state.createSeq}-${calls.api.length}`;
      const agentID = path.split("/")[4] ?? "agent-1";
      const isDelete = path.endsWith("delete");
      const op = {
        request_id: requestID,
        agent_id: agentID,
        kind: isDelete ? "delete" : "rebuild",
        state: "running",
        phase: "drain",
      };
      state.operations.set(requestID, op);
      setTimeout(() => {
        op.state = "completed";
        if (isDelete) {
          event(agentID, "agent_delete_requested", requestID);
          event(agentID, "agent_deleted", requestID);
          (state.deleted ??= new Set()).add(agentID);
        }
      }, 0);
      return { status: 202, body: op };
    }
    if (options.status === 202 || (options.status ?? []).includes?.(202)) {
      return { status: 202, body: {} };
    }
    if ((options.status ?? []).includes?.(404)) {
      const requestID = path.split("/").pop();
      state.childReads = (state.childReads ?? 0) + 1;
      const op = state.operations.get(requestID);
      return op
        ? { status: 200, body: op }
        : { status: 404, body: { code: "not_found" } };
    }
    const expected = options.status ?? 200;
    assert(
      expected === 200 || (Array.isArray(expected) && expected.includes(200)),
      `unexpected status ${options.status} for ${path}`,
    );
    return { status: 200, body: {} };
  };
  const json = async (path) => {
    calls.json.push(path);
    if (path.startsWith("/api/admin/operations/")) {
      const requestID = path.split("/").pop();
      return state.operations.get(requestID) ?? null;
    }
    if (path.includes("/events")) {
      const agentID = path.split("/")[4];
      return { events: state.events.get(agentID) ?? [] };
    }
    if (path.startsWith("/api/admin/agents/")) {
      const agentID = path.split("/")[4];
      return (
        state.agents.get(agentID) ?? {
          agent_id: agentID,
          lifecycle_state: "created",
          readiness: "ready",
        }
      );
    }
    return {};
  };
  const resources = async (agentID) => {
    if (state.deleted?.has(agentID)) return { containers: [], volumes: [] };
    const agent = state.agents.get(agentID);
    if (state.mutateControl && agentID === "agent-3" && state.controlSeen) {
      return {
        containers: [{ Id: "container-replaced", Mounts: [] }],
        volumes: ["v1", "v2", "v3"],
      };
    }
    if (agentID === "agent-3") state.controlSeen = true;
    if (agent?.lifecycle_state === "created" || state.held) {
      const volumes = {
        workspace: `antnest-workspace-${agentID}`,
        skills: `antnest-skills-${agentID}`,
        receiver: `antnest-receiver-${agentID}`,
      };
      return {
        containers: [
          {
            Id: `container-${agentID}`,
            Mounts: [
              {
                Type: "volume",
                Name: volumes.workspace,
                Destination: "/workspace",
                RW: true,
              },
              {
                Type: "volume",
                Name: volumes.skills,
                Destination: "/skills",
                RW: false,
              },
              {
                Type: "volume",
                Name: volumes.receiver,
                Destination: "/run/antnest-auth",
                RW: false,
              },
            ],
          },
        ],
        volumes: Object.values(volumes),
      };
    }
    return { containers: [], volumes: [] };
  };
  const ready = async (agentID) => ({
    agent: { agent_id: agentID, readiness: "ready" },
    container: { Id: `container-${agentID}` },
    volume: `v-${agentID}-1`,
  });
  const config = {
    project: "antnest-lifecycle-deadbeef",
    compose: (args) => ["compose", ...args],
    env: { ANTNEST_SERVICE_NETWORK_PREFIX: "10.241.0" },
  };
  mutate?.(state);
  const result = await runReliability({
    config,
    docker,
    signal: undefined,
    api,
    json,
    agentBody: { template_id: "template-1", template_revision: 1 },
    resources,
    ready,
  });
  assert.equal(result.profile, "lifecycle-reliability");
  assert(Array.isArray(result.cases) && result.cases.length >= 1);
  assert(
    state.childReads > 0,
    "the deterministic child poll must observe the operation",
  );
  // Proxy controls must go through owned docker exec, never host fetch.
  assert(
    calls.docker.some(
      (call) => call.includes("ps") && call.includes("reliability-proxy"),
    ),
    "proxy must be resolved via owned compose ps",
  );
  assert(
    calls.api.every((path) => path.startsWith("/api/admin/")),
    "all admissions must use the admin API",
  );
  return { state, calls };
}

test("runReliability walks the settled cases through injected fixtures", () =>
  scenario());

test("runReliability rejects a GC-mutated ready control Agent", async () => {
  await assert.rejects(
    scenario((state) => {
      const original = state.agents.get;
      state.agents.get = (id) => {
        const agent = original.call(state.agents, id);
        return agent;
      };
      // Replace the control Agent's physical container after its first snapshot.
      state.mutateControl = true;
    }),
    /GC changed a ready Agent/,
  );
});

test("runReliability rejects a surviving open Egress allocation", async () => {
  await assert.rejects(
    scenario((state) => {
      state.openEgress = true;
    }),
    /all tunnel keys must be gone/,
  );
});
