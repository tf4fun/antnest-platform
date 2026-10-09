import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { collectLearningTraces } from "./learning-trace.mjs";
import { until } from "../workspace-closeout/c4-setup.mjs";
import {
  assertAgentDeleted,
  waitForAgentReady,
} from "../../support/verification/agent-state.mjs";
import { searchJaegerTraces } from "../../support/jaeger-search.mjs";
import {
  assertCaptureDisabled,
  tag,
  traceTopology,
} from "../observability/trace-tree.mjs";
import { skillClientArgs } from "./client-container.mjs";
import { assertSourceActive } from "./source-projection-check.mjs";

const CALLER_GRANTS = [
  "acp-controller",
  "console-controller",
  "gateway-identity",
  "acp-registry",
];

export async function callerAcpFlow({
  config,
  fixture,
  docker,
  sql,
  signal,
  root,
  image,
  formal,
  output,
}) {
  await mkdir(output, { recursive: true, mode: 0o700 });
  const peer = await fixture.json("/api/admin/agents", {
    status: 202,
    body: {
      owner_user_id: fixture.ownerID,
      name: "DI3 automatic Skill source",
      template_id: fixture.template.template_id,
      template_revision: fixture.template.revision,
    },
  });
  const peerId = peer.agent.agent_id;
  assert.match(peerId, /^agent_[a-f0-9]{32}$/u);
  assert.notEqual(peerId, fixture.agentID);
  await fixture.operation(peer.operation.request_id);
  await waitForAgentReady(
    () => fixture.json(`/api/admin/agents/${peerId}`),
    signal,
  );
  const client = async (phase, env, script) => {
    const name = `${config.project}-caller-${phase}`;
    try {
      const text = await docker(
        [
          "run",
          "--name",
          name,
          ...skillClientArgs(config, {
            grants: script === "caller-client.mjs" ? CALLER_GRANTS : [],
          }),
          ...Object.entries(env).flatMap(([key, value]) => [
            "-e",
            `${key}=${value}`,
          ]),
          "-v",
          `${root}/tests:/app/tests:ro`,
          image,
          "node",
          `/app/tests/e2e/skill-learning/${script}`,
        ],
        true,
      );
      return JSON.parse(text.trim().split("\n").at(-1));
    } catch (error) {
      await writeFile(
        `${output}/caller-${phase}-failure.log`,
        await docker(["logs", name]).catch(() => "logs unavailable"),
        { mode: 0o600, flag: "wx" },
      );
      throw error;
    } finally {
      await docker(["rm", "-f", name]).catch(() => undefined);
    }
  };
  console.log(
    `Caller acceptance ${config.project}: second Agent automatic learning`,
  );
  const learned = await client(
    "peer-learn",
    {
      ANTNEST_E2E_AGENT_ID: peerId,
      ANTNEST_E2E_LEARNING_MODE: "create",
      ANTNEST_E2E_SKILL_CALLER_PEER: "true",
    },
    "automatic-client.mjs",
  );
  assert.equal(learned.status, "skill_created");
  assert.equal(learned.agent_id, peerId);
  const active = (agentId, sequence) =>
    assertSourceActive({
      sql,
      agentId,
      sequence,
      agentIds: [fixture.agentID, peerId],
    });
  await until(
    async () =>
      Number(
        await sql(
          `SELECT count(*) FROM skill_source_projections WHERE agent_id='${peerId}' AND active AND sequence=1 AND sent_sequence=1`,
        ),
      ) === 1,
    "peer metadata projection delivered",
    signal,
    90000,
  );
  await active(fixture.agentID, 2);
  await active(peerId, 1);
  console.log(
    `Caller acceptance ${config.project}: real active-Run find and both loads`,
  );
  const called = await client(
    "foreground",
    {
      ANTNEST_E2E_AGENT_ID: fixture.agentID,
      ANTNEST_E2E_PEER_AGENT_ID: peerId,
      ANTNEST_E2E_ACTOR_ID: fixture.ownerID,
      ANTNEST_E2E_CALLER_FORMAL: JSON.stringify(formal),
    },
    "caller-client.mjs",
  );
  assert.equal(called.status, "active_caller_search_passed");
  assert.match(called.session_id, /^session_[a-f0-9]{32}$/u);
  await active(fixture.agentID, 2);
  await active(peerId, 1);
  assert.equal(
    await sql(
      `SELECT count(*) FROM learning_changes WHERE agent_id='${fixture.agentID}'`,
    ),
    "2",
  );
  assert.equal(
    await sql(
      `SELECT count(*) FROM learning_changes WHERE agent_id='${peerId}'`,
    ),
    "1",
  );
  const runs = JSON.parse(
    await sql(
      `SELECT json_agg(json_build_object('run_id',r.id,'state',r.state,'stop_reason',r.stop_reason,'agent_id',s.agent_id,'tools',(SELECT json_agg(json_build_object('name',a.tool_name,'source',a.source,'source_id',a.source_id,'state',a.state,'effect',a.tool_effect_state,'stopped',a.runtime_call_stopped) ORDER BY a.started_at,a.id) FROM tool_attempts a WHERE a.run_id=r.id))) FROM runs r JOIN acp_sessions s ON s.id=r.session_id WHERE r.session_id='${called.session_id}'`,
    ),
  );
  assert.equal(runs.length, 1);
  const run = runs[0];
  assert.equal(run.agent_id, fixture.agentID);
  assert.equal(run.state, "completed");
  assert.equal(run.stop_reason, "end_turn");
  assert.deepEqual(
    run.tools.map((tool) => tool.name),
    ["find_skill", "load_skill", "load_skill"],
  );
  assert(
    run.tools.every(
      (tool) =>
        tool.source === "agent" &&
        tool.source_id === "skill_registry" &&
        tool.state === "completed" &&
        tool.effect === "none" &&
        tool.stopped,
    ),
  );
  // The default SDK batch period is five seconds. Read the completed Trace once
  // after the acceptance buffer; early detail polling can persist Jaeger warnings.
  await delay(6000, undefined, { signal });
  const traces = await searchJaegerTraces(
    config.jaeger,
    new URLSearchParams({
      service: "agent-acp-service",
      operation: "agent.run",
      tags: JSON.stringify({ "antnest.run.id": run.run_id }),
      lookback: "30m",
      limit: "20",
    }),
    { signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) },
  );
  assert.equal(traces.length, 1, "completed caller Run Trace must be exported");
  const trace = traces[0];
  let topologyError;
  try {
    traceTopology(trace);
  } catch (error) {
    topologyError = error.message;
  }
  await writeFile(
    `${output}/caller-trace-observation.json`,
    JSON.stringify({ trace, topology_error: topologyError }),
    { mode: 0o600, flag: "wx" },
  );
  assert.equal(
    topologyError,
    undefined,
    "caller Trace must have complete parents",
  );
  const topology = traceTopology(trace);
  assertCaptureDisabled(trace);
  const search = trace.spans.filter(
    (span) => span.operationName === "skill.discovery.search",
  );
  const loads = trace.spans.filter(
    (span) => span.operationName === "skill.discovery.load",
  );
  assert.equal(search.length, 1);
  assert.equal(loads.length, 2);
  assert.equal(
    trace.spans.filter((span) => span.operationName === "skill.source.observe")
      .length,
    2,
    "both peer source checks must join the calling Run Trace",
  );
  for (const span of [...search, ...loads]) {
    assert.equal(tag(span, "run.id"), run.run_id);
    const parent = topology.parent(span);
    assert.equal(parent.operationName, "mcp.tools.call");
    assert.equal(tag(parent, "mcp.source_id"), "skill_registry");
  }
  const formalLoad = loads.find(
    (span) => tag(span, "skill.source.kind") === "registry",
  );
  const peerLoad = loads.find(
    (span) => tag(span, "skill.source.kind") === "agent",
  );
  assert(formalLoad && peerLoad);
  assert.equal(tag(formalLoad, "skill.id"), formal.skill_id);
  assert.equal(tag(formalLoad, "skill.version"), formal.version);
  assert.equal(tag(formalLoad, "skill.content_digest"), formal.content_digest);
  assert.equal(tag(peerLoad, "skill.source.agent_id"), peerId);
  assert.equal(tag(peerLoad, "skill.source.sequence"), 1);
  assert.equal(
    tag(peerLoad, "skill.content_digest"),
    called.peer_projection.content_digest,
  );
  for (const span of trace.spans.filter(
    (node) => node.operationName === "skill.source.observe",
  )) {
    assert.equal(
      tag(span, "antnest.agent_id"),
      peerId,
      "active caller must never inspect its own source",
    );
    assert.equal(tag(span, "antnest.skill.source_sequence"), 1);
    const sourceServer = topology.parent(span);
    assert.equal(topology.service(sourceServer), "agent-acp-service");
    assert(
      [
        "HTTP POST /internal/skill-sources/inspect",
        "HTTP POST /internal/skill-sources/artifact",
      ].includes(sourceServer.operationName),
    );
    const sourceClient = topology.parent(sourceServer);
    assert.equal(topology.service(sourceClient), "skill-registry");
    assert.equal(sourceClient.operationName, "HTTP POST agent-acp-service");
    const registryServer = topology.parent(sourceClient);
    assert.equal(topology.service(registryServer), "skill-registry");
    assert(
      [
        "HTTP POST /internal/skill-discovery/search",
        "HTTP POST /internal/skill-discovery/load",
      ].includes(registryServer.operationName),
    );
    const registryClient = topology.parent(registryServer);
    assert.equal(topology.service(registryClient), "agent-acp-service");
    assert.equal(registryClient.operationName, "HTTP POST skill_registry");
    assert(
      [search[0].spanID, peerLoad.spanID].includes(
        topology.parent(registryClient).spanID,
      ),
      "source access must belong to the actual find/load operation",
    );
  }
  assert(
    !JSON.stringify(trace).includes("For the fixture task, inspect the target"),
  );
  await writeFile(`${output}/caller-trace.json`, JSON.stringify(trace), {
    flag: "wx",
    mode: 0o600,
  });
  const peerLearning = await collectLearningTraces(
    config,
    peerId,
    [learned.created_change_id],
    signal,
    { fileSuffix: "-caller-peer" },
  );
  assert.equal(peerLearning.summaries[0].debug, false);
  assert.equal(peerLearning.summaries[0].modelCalls, 1);
  const deleted = await fixture.json(`/api/admin/agents/${peerId}/delete`, {
    status: 202,
    body: {},
  });
  const operation = deleted.operation ?? deleted;
  await fixture.operation(operation.request_id);
  assertAgentDeleted(await fixture.json(`/api/admin/agents/${peerId}`));
  await until(
    async () =>
      (await sql(
        `SELECT sequence || '|' || sent_sequence FROM skill_source_projections WHERE agent_id='${peerId}' AND NOT active`,
      )) === "2|2",
    "peer deletion removes its mapping before remaining source checks",
    signal,
    90000,
  );
  const report = {
    ...called,
    run,
    peer_learning: peerLearning.summaries,
    trace: {
      trace_id: trace.traceID,
      span_count: trace.spans.length,
      searches: 1,
      loads: 2,
      peer_observations: 2,
      own_observations: 0,
      complete_parents: true,
      capture_disabled: true,
    },
    peer_delete_request_id: operation.request_id,
    own_projection_remains_active: true,
  };
  await writeFile(`${output}/caller-flow.json`, JSON.stringify(report), {
    mode: 0o600,
    flag: "wx",
  });
  console.log(
    `Caller acceptance ${config.project}: identities, actual Trace and normal peer deletion passed`,
  );
  return report;
}
