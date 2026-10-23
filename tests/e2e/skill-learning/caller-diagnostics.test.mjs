import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { callerAcpFlow } from "./caller-flow.mjs";

const own = `agent_${"a".repeat(32)}`;
const peer = `agent_${"b".repeat(32)}`;
const session = `session_${"c".repeat(32)}`;

async function harness(t, deletionFailure) {
  const output = await mkdtemp(join(tmpdir(), "antnest-caller-diagnostics-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const events = [];
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (request.url.startsWith("/api/v3/trace-summaries?")) {
      response.end(
        JSON.stringify({ summaries: [{ traceId: "d".repeat(32) }] }),
      );
    } else {
      assert.equal(request.url, `/api/traces/${"d".repeat(32)}`);
      events.push("jaeger-detail-failed");
      response.writeHead(503);
      response.end(JSON.stringify({ error: "diagnostic fixture unavailable" }));
    }
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  let deleted = false;
  const options = {
    config: {
      project: "antnest-caller-diagnostics",
      jaeger: `http://127.0.0.1:${server.address().port}`,
      credentials: join(output, "unused-credentials"),
      env: {
        ANTNEST_SERVICE_AUTH_UID: "1234",
        ANTNEST_SERVICE_AUTH_GID: "5678",
        ANTNEST_SERVICE_NETWORK_PREFIX: "10.244.7",
      },
    },
    fixture: {
      agentID: own,
      ownerID: "user_owner",
      template: { template_id: "template", revision: 1 },
      operation: async (id) => {
        events.push(id);
      },
      json: async (path) => {
        if (path === "/api/admin/agents")
          return {
            agent: { agent_id: peer },
            operation: { request_id: "create-peer" },
          };
        if (path === `/api/admin/agents/${peer}/delete`) {
          events.push("delete-peer");
          if (deletionFailure) throw deletionFailure;
          deleted = true;
          return { operation: { request_id: "delete-completed" } };
        }
        assert.equal(path, `/api/admin/agents/${peer}`);
        if (deleted) {
          events.push("deleted-state");
          return {
            lifecycle_state: "deleted",
            desired_state: "deleted",
            runtime_state: "absent",
          };
        }
        return {
          lifecycle_state: "created",
          activation_state: "enabled",
          desired_state: "enabled",
          runtime_state: "available",
          readiness: "ready",
          executable_execution_revision: 1,
          runtime: { runtime_revision: 1 },
        };
      },
    },
    docker: async (args) => {
      if (args[0] === "rm") return "";
      assert.equal(args[0], "run");
      if (args.at(-1).endsWith("/automatic-client.mjs"))
        return JSON.stringify({
          status: "skill_created",
          agent_id: peer,
          created_change_id: "change_peer",
        });
      assert(args.at(-1).endsWith("/caller-client.mjs"));
      return JSON.stringify({
        status: "active_caller_search_passed",
        session_id: session,
      });
    },
    sql: async (query) => {
      if (query.startsWith("SELECT sequence ||")) {
        events.push("deletion-projection");
        return "2|2";
      }
      if (query.startsWith("SELECT count(*) FROM skill_source_projections"))
        return "1";
      if (query.startsWith("SELECT count(*) FROM learning_changes"))
        return query.includes(own) ? "2" : "1";
      assert(query.startsWith("SELECT json_agg(json_build_object('run_id'"));
      events.push("business-run-checked");
      return JSON.stringify([
        {
          run_id: "run_actual",
          agent_id: own,
          state: "completed",
          stop_reason: "end_turn",
          tools: ["find_skill", "load_skill", "load_skill"].map((name) => ({
            name,
            source: "agent",
            source_id: "skill_registry",
            state: "completed",
            effect: "none",
            stopped: true,
          })),
        },
      ]);
    },
    signal: AbortSignal.timeout(20000),
    root: output,
    image: "fixture-only",
    formal: {},
    output,
  };
  return { options, events, output };
}

test("caller continues normal peer deletion after real Jaeger detail failures", async (t) => {
  const h = await harness(t);
  const result = await callerAcpFlow(h.options);
  assert.deepEqual(h.events, [
    "create-peer",
    "business-run-checked",
    "jaeger-detail-failed",
    "jaeger-detail-failed",
    "delete-peer",
    "delete-completed",
    "deleted-state",
    "deletion-projection",
  ]);
  assert.equal(result.trace_diagnostics.status, "warning");
  assert.deepEqual(
    result.trace_diagnostics.checks.map((row) => row.status),
    ["failed", "failed"],
  );
  assert.equal(Object.hasOwn(result, "trace"), false);
  assert.equal(Object.hasOwn(result, "peer_learning"), false);
  for (const row of result.trace_diagnostics.checks)
    assert.match(
      await readFile(join(h.output, row.failure_evidence), "utf8"),
      /Jaeger trace detail query failed/u,
    );
  const saved = JSON.parse(
    await readFile(join(h.output, "caller-flow.json"), "utf8"),
  );
  assert.equal(saved.peer_delete_request_id, "delete-completed");
});

test("caller still fails when peer deletion fails after Trace diagnostics", async (t) => {
  const failure = new Error("business deletion failed");
  const h = await harness(t, failure);
  await assert.rejects(callerAcpFlow(h.options), (error) => error === failure);
  assert.deepEqual(h.events.slice(-3), [
    "jaeger-detail-failed",
    "jaeger-detail-failed",
    "delete-peer",
  ]);
  await assert.rejects(readFile(join(h.output, "caller-flow.json")), {
    code: "ENOENT",
  });
});
