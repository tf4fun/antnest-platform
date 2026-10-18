import assert from "node:assert/strict";
import test from "node:test";
import { shutdownPrivateEvidenceFixture } from "./shutdown-private-evidence.fixture.mjs";
const url = new URL("./shutdown-private-evidence.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
test("Shutdown admission proves four actual requests, same empty Session, both watches and original maintenance inventory", async (t) => {
  assert.equal(typeof implementation.shutdownPrivateAdmission, "function");
  const result = await shutdownPrivateEvidenceFixture(t),
    original = structuredClone(result);
  const admission = implementation.shutdownPrivateAdmission(result);
  assert.equal(admission.accepted_exit, 0);
  assert.equal(admission.strict_exit, 2);
  assert.deepEqual(admission.inventory, {
    connections: 2,
    initializations: 2,
    business_requests: 2,
    login_sessions: 1,
    private_state_watches: 2,
    maintenance_watch_closures: 2,
    lifecycle_admissions: 2,
    runs: 0,
    provider_requests: 0,
    runtime_tool_calls: 0,
  });
  assert.deepEqual(result, original);
});
test("Shutdown admission binds the original public socket diagnostic to its exact maintenance closure and cancellation Trace", async (t) => {
  const original = await shutdownPrivateEvidenceFixture(t, {
    publicCancellation: true,
  });
  const watch = original.private_shutdown.public_watches[0];
  watch.transport_diagnostics = [
    {
      traceID: watch.traceID,
      observedAt: watch.closure.observedAt,
      name: "TypeError",
      message: "terminated",
      cause_code: "UND_ERR_SOCKET",
      cause_message: "other side closed",
      reason: "shutdown-public-remote-socket-end",
      raw_error:
        "TypeError: terminated\n[cause]: SocketError: other side closed",
    },
  ];
  assert.equal(
    implementation.shutdownPrivateAdmission(original).accepted_exit,
    0,
  );
  for (const [name, mutate] of [
    [
      "foreign trace",
      (r, d) => {
        d.traceID = "e".repeat(32);
      },
    ],
    [
      "unknown reason",
      (r, d) => {
        d.reason = "any-error";
      },
    ],
    [
      "different error",
      (r, d) => {
        d.name = "Error";
      },
    ],
    [
      "different message",
      (r, d) => {
        d.message = "different";
      },
    ],
    [
      "different cause",
      (r, d) => {
        d.cause_code = "OTHER";
      },
    ],
    [
      "different socket failure",
      (r, d) => {
        d.cause_message = "other failure";
      },
    ],
    [
      "early socket error",
      (r, d) => {
        d.observedAt = r.private_shutdown.stop.startedAt - 1;
      },
    ],
    [
      "late socket error",
      (r, d) => {
        d.observedAt = r.watch_closures[0].observedAt + 1;
      },
    ],
    [
      "missing original error",
      (r, d) => {
        d.raw_error = "";
      },
    ],
    [
      "duplicate diagnostic",
      (r, d) => {
        r.private_shutdown.public_watches[0].transport_diagnostics.push(d);
      },
    ],
    [
      "local close diagnostic",
      (r, d) => {
        r.private_shutdown.public_watches[1].transport_diagnostics.push(d);
      },
    ],
    [
      "missing diagnostic inventory",
      (r) => {
        delete r.private_shutdown.public_watches[0].transport_diagnostics;
      },
    ],
    [
      "missing original cancellation",
      (r) => {
        Object.assign(r.watch_traces[0], {
          error_spans: 0,
          cancellation_error_spans: 0,
          strict_trace: "passed",
        });
      },
    ],
  ]) {
    const result = structuredClone(original);
    mutate(
      result,
      result.private_shutdown.public_watches[0].transport_diagnostics[0],
    );
    assert.throws(
      () => implementation.shutdownPrivateAdmission(result),
      undefined,
      name,
    );
  }
});
test("Shutdown admission rejects incomplete work, changed authority, missing original notifications and unowned diagnostics", async (t) => {
  assert.equal(typeof implementation.shutdownPrivateAdmission, "function");
  const original = await shutdownPrivateEvidenceFixture(t);
  for (const [name, mutate] of [
    ["missing initialization", (r) => r.request_traces.shift()],
    [
      "extra request",
      (r) =>
        r.private_connections[0].evidence.push(
          r.private_connections[0].evidence[0],
        ),
    ],
    [
      "new login",
      (r) => r.private_shutdown.logins.push(r.private_shutdown.logins[0]),
    ],
    [
      "changed Session",
      (r) => {
        r.private_shutdown.delegations[2].session_digest = "f".repeat(64);
      },
    ],
    [
      "foreign owner",
      (r) => {
        r.private_shutdown.logins[0].principal.user_id = "foreign";
      },
    ],
    [
      "different ACP Session",
      (r) => {
        r.private_connections[1].evidence[0].sessionId = "foreign";
      },
    ],
    [
      "missing history",
      (r) => {
        r.private_connections[1].updates = [];
      },
    ],
    [
      "forged history",
      (r) => {
        r.private_connections[1].raw_frames =
          r.private_connections[1].raw_frames.filter(
            (f) => f.method !== "session/update",
          );
      },
    ],
    [
      "changed metadata",
      (r) => {
        r.private_connections[1].updates.find(
          (x) => x.update.sessionUpdate === "session_info_update",
        ).update.title = "changed";
      },
    ],
    ["missing lifecycle", (r) => r.traces.pop()],
    [
      "local ACP close",
      (r) => {
        r.private_shutdown.remote_acp_close.localClose = true;
      },
    ],
    [
      "early ACP close",
      (r) => {
        r.private_shutdown.remote_acp_close.at = 1999;
      },
    ],
    [
      "different ACP code",
      (r) => {
        r.private_shutdown.remote_acp_close.code = 1000;
      },
    ],
    [
      "replaced app",
      (r) => {
        r.restarted_inventory[0].id = "replacement";
      },
    ],
    [
      "changed Runtime",
      (r) => {
        r.private_shutdown.states[1].container.Id = "replacement";
      },
    ],
    [
      "replaced receiver",
      (r) => {
        r.private_shutdown.transport_after.rows[1].Id = "replacement";
      },
    ],
    [
      "new Run",
      (r) =>
        r.private_shutdown.idle[1].audits.items.push({ run_id: "unexpected" }),
    ],
    [
      "model invocation",
      (r) => r.private_shutdown.final_model.requests.push({ unexpected: true }),
    ],
    [
      "changed event journal",
      (r) => r.private_shutdown.histories[1].events.push({ sequence: 2 }),
    ],
    [
      "missing remote state EOF",
      (r) => {
        r.private_state_watches[0].body_outcome = "cancelled";
      },
    ],
    [
      "reopened watch disconnected",
      (r) => {
        r.private_state_watches[1].closure.kind = "transport-end";
      },
    ],
    [
      "public watch unjoined",
      (r) => {
        r.private_shutdown.public_watches[1].joined = false;
      },
    ],
    ["missing public trace", (r) => r.watch_traces.shift()],
    [
      "missing original shutdown error",
      (r) => {
        Object.assign(r.watch_traces[1], {
          error_spans: 0,
          raw_error_inventory: [],
          owned_error_spans: [],
          strict_trace: "passed",
        });
      },
    ],
    [
      "wrong private watch kind",
      (r) => {
        r.watch_traces[1].kind = "request";
      },
    ],
    [
      "wrong private watch server",
      (r) => {
        r.watch_traces[1].server_span_id = "e".repeat(16);
      },
    ],
    [
      "missing initial inventory",
      (r) => {
        delete r.private_shutdown.platform_inventory.initial;
      },
    ],
    [
      "missing stopped inventory",
      (r) => {
        delete r.private_shutdown.platform_inventory.stopped;
      },
    ],
    [
      "missing restarted inventory",
      (r) => {
        delete r.private_shutdown.platform_inventory.restarted;
      },
    ],
    [
      "changed workspace bytes",
      (r) => {
        r.private_shutdown.workspace.after += "changed";
      },
    ],
    [
      "missing original membership",
      (r) => {
        r.private_shutdown.membership_logs.restarted = "";
      },
    ],
    [
      "remaining Runtime resource",
      (r) => {
        r.private_shutdown.deletion.resources.containers.push("retained");
      },
    ],
    [
      "private trace not owned",
      (r) => {
        r.watch_traces[1].owned_error_spans[0].reason = "blanket-cancellation";
      },
    ],
    [
      "extra public errors",
      (r) => {
        r.watch_traces[0].error_spans++;
      },
    ],
    [
      "unknown warning",
      (r) => {
        r.watch_traces[0].warning_count = 1;
        r.watch_traces[0].warnings = ["unknown internal warning"];
        r.watch_traces[0].strict_trace = "failed";
      },
    ],
    [
      "unjoined exporter",
      (r) => {
        r.private_cleanup_completed = false;
      },
    ],
    [
      "original collection failure",
      (r) => r.private_collection_errors.push("original failure"),
    ],
  ]) {
    const result = structuredClone(original);
    mutate(result);
    let rejected = false;
    try {
      rejected =
        implementation.shutdownPrivateAdmission(result).accepted_exit !== 0;
    } catch {
      rejected = true;
    }
    assert(rejected, name);
  }
});
test("Shutdown public summary retains original topology results and removes private identity, bodies and inventory", () => {
  assert.equal(typeof implementation.shutdownPublicResult, "function");
  const input = {
    profile: "shutdown",
    operations: 2,
    request_traces: [{ trace_id: "public-trace" }],
    private_shutdown: { private: "sensitive" },
    private_connections: [{ private: "sensitive" }],
    private_state_watches: [{ private: "sensitive" }],
    private_collection_errors: ["sensitive"],
    private_cleanup_completed: true,
    stop_observation: { private: "sensitive" },
    restarted_inventory: [{ private: "sensitive" }],
  };
  const original = structuredClone(input),
    result = implementation.shutdownPublicResult(input);
  assert.deepEqual(input, original);
  assert(!JSON.stringify(result).includes("sensitive"));
  assert.deepEqual(result.request_traces, input.request_traces);
});
