import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { collectTrace } from "../observability/collect.mjs";
import { readAdmissionEvidence } from "./admission-evidence.mjs";
import { inspectAccessTrace } from "../identity-closeout/agent-access-evidence.mjs";
import { inspectRunTrace } from "./run-trace.mjs";
import { connectOwner } from "./acp.mjs";
import { inspectProbe, inspectTargetHistory } from "./network-evidence.mjs";
import {
  networkFixture,
  physicalIdentity,
  tunnelIP,
  flushTraceProducers,
  runtimeExitEvidence,
} from "./network-support.mjs";

export async function runNetwork({
  config,
  docker,
  signal,
  api,
  json,
  principal,
  agentBody,
  command,
  resources,
  ready,
}) {
  const fixture = await networkFixture(config, docker);
  const owner = new GatewayClient(config.gateway);
  await owner.request("/api/session/login", {
    body: {
      organization_slug: "stage3",
      email: "lifecycle-owner@example.com",
      password: "lifecycle-owner-password",
    },
  });
  const agents = [];
  for (const name of ["Network Agent A", "Network Agent B"]) {
    const created = await command("create", undefined, { ...agentBody, name });
    const initial = await ready(created.agentID);
    agents.push({
      id: created.agentID,
      initial,
      ip: tunnelIP(initial.container),
    });
  }
  const [a, b] = agents;
  assert.notEqual(a.ip, b.ip);
  const exec = (agent, script) =>
    docker([
      "exec",
      "--user",
      "1000:1000",
      agent.initial.container.Id,
      "sh",
      "-c",
      script,
    ]);
  const sentinel = randomUUID();
  for (const agent of agents)
    await exec(
      agent,
      `printf '%s' '${sentinel}' > /workspace/.c3-network-sentinel`,
    );
  const policies = [];
  const policy = async (agent, action) => {
    const path = `/api/admin/agents/${agent.id}/network-policy`;
    const before = await json(path);
    const options = {
      method: "PUT",
      body: { action, expected_resource_version: before.resource_version },
      headers: {
        "Idempotency-Key": randomUUID(),
        "X-Antnest-Expected-Principal": principal,
      },
    };
    const response = await api(path, options);
    assert.equal(response.body.action, action);
    const saved = await json(path);
    assert.equal(saved.action, action);
    assert.equal(saved.resource_version, response.body.resource_version);
    assert.equal(saved.attachment.state, "open");
    policies.push({ traceID: response.traceID, agentID: agent.id, action });
    return { path, options, response: response.body };
  };
  await policy(a, "allow_all");
  const bAllow = await policy(b, "allow_all");
  const probes = [],
    clients = [],
    pending = [];
  const start = async (agent, phase, target) => {
    signal.throwIfAborted();
    const input = { phase, nonce: randomUUID(), ...(target ? { target } : {}) };
    const client = connectOwner(config.gateway, agent.id, owner.cookie, signal);
    clients.push(client);
    await client.initialize();
    const sessionId = (
      await client.request("new", { cwd: "/workspace", mcpServers: [] })
    ).sessionId;
    // Separate WebSocket roots keep each Run's trace evidence unambiguous.
    const promise = client
      .request(
        "prompt",
        { sessionId, prompt: [{ type: "text", text: JSON.stringify(input) }] },
        65000,
      )
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    pending.push(promise);
    const probe = { input, agent, promise, client, sessionId };
    probes.push(probe);
    return probe;
  };
  const finish = async (probe) => {
    const { value, error } = await probe.promise;
    signal.throwIfAborted();
    assert(
      !error,
      `${probe.input.phase}: ACP prompt failed: ${error?.data?.code ?? "unknown"}`,
    );
    assert.equal(value.stopReason, "end_turn");
    const text = probe.client.updates
      .filter(
        (n) =>
          n.sessionId === probe.sessionId &&
          n.update.sessionUpdate === "agent_message_chunk",
      )
      .map((n) => n.update.content.text ?? "")
      .join("");
    assert.equal(text, `${probe.input.phase} checked`);
    probe.client.close();
    console.error(`Network ${probe.input.phase}: real ACP tool completed`);
  };
  const hold = async (agent, phase) => {
    const probe = await start(agent, phase);
    for (let i = 0; i < 100; i++) {
      if (
        (await exec(
          agent,
          `if [ -f /workspace/.c3-network-${probe.input.nonce} ]; then printf held; fi`,
        )) === "held"
      )
        return probe;
      await delay(100, undefined, { signal });
    }
    throw new Error(`${phase}: real socket barrier not reached`);
  };
  let evidence;
  const traceRequests = [];
  try {
    await finish(await start(a, "allowed"));
    const heldA = await hold(a, "held-a"),
      heldB = await hold(b, "held-b");
    const originalA = await fixture.conntrack(a.ip),
      originalB = await fixture.conntrack(b.ip);
    for (const tuples of [originalA, originalB])
      assert.equal(tuples.filter((t) => t.state === "ESTABLISHED").length, 1);
    const denied = await policy(a, "deny_all");
    console.error(
      "Network deny ACK: checking original connections and reverse push",
    );
    assert.deepEqual(
      await fixture.conntrack(a.ip),
      [],
      "deny ACK retained A's original conntrack",
    );
    assert.deepEqual(
      await fixture.conntrack(b.ip),
      originalB,
      "A denial changed B's original conntrack",
    );
    const conflict = await json(bAllow.path, {
      ...bAllow.options,
      status: 409,
      body: {
        action: "deny_all",
        expected_resource_version: bAllow.response.resource_version - 1,
      },
      headers: { ...bAllow.options.headers, "Idempotency-Key": randomUUID() },
    });
    assert.equal(conflict.code, "resource_version_conflict");
    assert.deepEqual(
      await fixture.conntrack(b.ip),
      originalB,
      "stale conflict disrupted B",
    );
    for (const held of [heldA, heldB])
      assert.deepEqual(
        await fixture.control(`/push/${held.input.nonce}`, "POST"),
        { pushed: held.input.nonce },
      );
    for (const held of [heldA, heldB])
      await exec(
        held.agent,
        `touch /workspace/.c3-network-release-${held.input.nonce}`,
      );
    await finish(heldA);
    await finish(heldB);
    await finish(await start(a, "denied"));
    assert.deepEqual(await json(denied.path, denied.options), denied.response);
    await policy(a, "allow_all");
    await finish(await start(a, "restored"));
    await finish(await start(a, "private", fixture.ip));
    const response = await fetch(`${config.model}/status`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    });
    assert.equal(response.status, 200);
    const model = await response.json();
    assert.deepEqual(model.errors, []);
    assert.equal(model.requests.length, probes.length * 2);
    const reports = [];
    for (const probe of probes) {
      const calls = model.requests.filter((r) => r.phase === probe.input.phase);
      assert.deepEqual(
        calls.map((c) => c.stage),
        ["tool", "reply"],
      );
      reports.push(inspectProbe(calls[1].report, probe.input, fixture.ip));
      assert.equal(calls[0].trace_id, calls[1].trace_id);
      traceRequests.push({ calls, agentID: probe.agent.id });
    }
    const expected = probes
      .filter((p) => ["allowed", "held-a", "held-b"].includes(p.input.phase))
      .map((p) => p.input);
    expected.push(
      { ...heldB.input, phase: "held-b-next" },
      probes.find((p) => p.input.phase === "restored").input,
    );
    const history = await fixture.control();
    inspectTargetHistory(history, expected, fixture.peer);
    assert.deepEqual(history.pushed, [heldA.input.nonce, heldB.input.nonce]);
    for (const agent of agents) {
      assert.deepEqual(
        physicalIdentity(await ready(agent.id)),
        physicalIdentity(agent.initial),
        "policy update changed Runtime identity/configuration",
      );
      assert.equal(
        await exec(agent, "cat /workspace/.c3-network-sentinel"),
        sentinel,
      );
    }
    evidence = {
      profile: "lifecycle-real-network",
      agents: 2,
      reports,
      old_connection_revoked: true,
      other_agent_same_connection_preserved: true,
      unsolicited_denied_push_blocked: true,
      runtime_unchanged: true,
      target_requests: history.requests.length,
    };
  } finally {
    for (const client of clients) client.close();
    for (const promise of pending) await promise;
  }
  const admissionEvidence = new Map();
  for (const agent of agents) {
    const since = new Date(Date.now() - 1000).toISOString();
    admissionEvidence.set(
      agent.id,
      await readAdmissionEvidence(config, docker, agent.id),
    );
    await command("delete", agent.id, {});
    assert.deepEqual(await resources(agent.id), {
      containers: [],
      volumes: [],
    });
    await runtimeExitEvidence(
      config,
      docker,
      agent.initial.container.Id,
      since,
    );
  }
  const producersStopped = await flushTraceProducers(config, docker);
  const traces = [],
    policyTraces = [];
  for (const { calls, agentID } of traceRequests)
    traces.push(
      await collectTrace(
        config.jaeger,
        calls[0].trace_id,
        (trace) =>
          inspectRunTrace(
            trace,
            calls,
            ["stage3-model-secret", "lifecycle-owner-password"],
            agentID,
            admissionEvidence.get(agentID),
            "bash",
          ),
        signal,
      ),
    );
  for (const item of policies)
    policyTraces.push(
      await collectTrace(
        config.jaeger,
        item.traceID,
        (trace) => inspectPolicyTrace(trace, item),
        signal,
      ),
    );
  signal.throwIfAborted();
  return {
    ...evidence,
    traces,
    policy_traces: policyTraces,
    trace_producers_stopped: producersStopped,
    runtimes_cleanly_exited: agents.length,
    deleted_before_teardown: true,
  };
}

export function inspectPolicyTrace(trace, item) {
  const tag = (s, key) => s.tags?.find((t) => t.key === key)?.value;
  const spans = trace?.spans?.filter(
    (s) =>
      trace.processes[s.processID]?.serviceName === "antnest-runtime-egress" &&
      s.operationName ===
        "HTTP PUT /internal/agent-policy-assignments/{agent_id}" &&
      tag(s, "http.request.method") === "PUT",
  );
  assert.equal(spans?.length, 1);
  assert.equal(
    tag(spans[0], "http.route"),
    "/internal/agent-policy-assignments/{agent_id}",
  );
  assert.equal(tag(spans[0], "antnest.agent.id"), item.agentID);
  const status = tag(spans[0], "http.response.status_code");
  assert(
    status === 200 || status === "200",
    "Egress policy RPC did not succeed",
  );
  assert.notEqual(tag(spans[0], "error"), true);
  return {
    action: item.action,
    ...inspectAccessTrace(
      trace,
      {
        traceID: item.traceID,
        service: "antnest-runtime-egress",
        operation: "HTTP PUT /internal/agent-policy-assignments/{agent_id}",
        spanID: spans[0].spanID,
        via: ["admin-console", "agent-controller"],
      },
      ["stage3-model-secret", "lifecycle-owner-password"],
    ),
  };
}
