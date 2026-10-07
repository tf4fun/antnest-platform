import assert from "node:assert/strict";
import { connectACP } from "../identity-closeout/acp-connection.mjs";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { member, until } from "../workspace-closeout/c4-setup.mjs";
import { serviceCalls } from "./service-calls.mjs";

const callerId = process.env.ANTNEST_E2E_AGENT_ID;
const peerId = process.env.ANTNEST_E2E_PEER_AGENT_ID;
const ownerId = process.env.ANTNEST_E2E_ACTOR_ID;
const formal = JSON.parse(process.env.ANTNEST_E2E_CALLER_FORMAL);
for (const id of [callerId, peerId]) assert.match(id, /^agent_[a-f0-9]{32}$/u);
assert.notEqual(callerId, peerId);
const client = new GatewayClient("http://edge-gateway:8080");
const login = (await client.request("/api/session/login", { body: member }))
  .body;
assert.equal(login.principal.user_id, ownerId);
console.log("Caller fixture: authenticated owner");
const scope = {
  organization_id: login.principal.organization_id,
  actor_id: ownerId,
};

// Stop new review work for this test Run using the normal owner policy API.
// Applied personal content and its projection remain active, verified below.
const services = serviceCalls();
const policy = await services.learningPolicy(callerId, {
  organization_id: scope.organization_id,
  principal_id: ownerId,
});
const changed = await services.setLearningPolicy(callerId, member, {
  request_id: "caller-foreground-policy-off",
  organization_id: scope.organization_id,
  actor_principal_id: ownerId,
  expected_revision: policy.revision,
  mode: "off",
  scope: policy.scope,
  pinned_paths: policy.pinned_paths,
  limits: policy.limits,
});
assert.equal(changed.mode, "off");
console.log(
  "Caller fixture: subsequent reviews disabled without removing content",
);

const candidates = await until(
  async () => {
    const response = await services.registrySearch({
      ...scope,
      query: "fixture-procedure",
    });
    if (response.status !== 200) return null;
    const items = (await response.json()).items;
    const own = items.find(
      (item) =>
        item.skill_ref.kind === "agent" && item.skill_ref.agent_id === callerId,
    );
    const peer = items.find(
      (item) =>
        item.skill_ref.kind === "agent" && item.skill_ref.agent_id === peerId,
    );
    return own?.skill_ref.sequence === 2 && peer?.skill_ref.sequence === 1
      ? { own, peer, items }
      : null;
  },
  "both actual learned projections ready while caller is idle",
  undefined,
  90000,
);
console.log(
  JSON.stringify({
    phase: "idle_source_metadata",
    candidate_count: candidates.items.length,
    own_sequence: candidates.own.skill_ref.sequence,
    peer_sequence: candidates.peer.skill_ref.sequence,
  }),
);
assert.equal(candidates.items.length, 3);
assert(
  candidates.items.some(
    (item) =>
      item.skill_ref.kind === "registry" &&
      item.skill_ref.skill_id === formal.skill_id &&
      item.skill_ref.version === formal.version &&
      item.content_digest === formal.content_digest,
  ),
);
assert.equal(candidates.own.content_digest, formal.content_digest);
assert.notEqual(candidates.peer.content_digest, formal.content_digest);
const selected = {
  caller_agent_id: callerId,
  peer_agent_id: peerId,
  peer_digest: candidates.peer.content_digest,
  formal_ref: {
    kind: "registry",
    skill_id: formal.skill_id,
    version: formal.version,
  },
  formal_digest: formal.content_digest,
};
assert.equal(formal.version, 2);
const acp = connectACP(1, callerId, client.cookie, {
  // This client has no span exporter: do not invent an unrecorded parent.
  injectTraceParent: false,
  requestPermission: ({ params }) => ({
    outcome: {
      outcome: "selected",
      optionId: params.options.find((option) => option.kind === "allow_once")
        .optionId,
    },
  }),
});
try {
  await acp.initialize();
  console.log("Caller fixture: ACP initialized");
  const { sessionId } = await until(
    async () => {
      try {
        return await acp.request("new", { cwd: "/workspace", mcpServers: [] });
      } catch (error) {
        if (error?.data?.code === "configuration_not_ready") return null;
        throw error;
      }
    },
    "caller foreground configuration",
    undefined,
    90000,
  );
  assert(
    acp.updates.some(
      (entry) =>
        entry.update.sessionUpdate === "available_commands_update" &&
        entry.update.availableCommands.some(
          (command) => command.name === "skill:personal:fixture-procedure",
        ),
    ),
    "the caller's own local Skill must remain available",
  );
  console.log("Caller fixture: own local Skill command remains available");
  const result = await acp.request(
    "prompt",
    {
      sessionId,
      prompt: [
        {
          type: "text",
          text: `discover excluding self ${JSON.stringify(selected)}`,
        },
      ],
    },
    90000,
  );
  assert.equal(result.stopReason, "end_turn");
  const starts = acp.updates.filter(
    (entry) => entry.update.sessionUpdate === "tool_call",
  );
  assert.deepEqual(
    starts.map((entry) => entry.update.title),
    ["Find Skill", "Load Skill", "Load Skill"],
  );
  const reply = acp.updates
    .filter((entry) => entry.update.sessionUpdate === "agent_message_chunk")
    .map((entry) => entry.update.content.text ?? "")
    .join("");
  assert(reply.includes("Caller search loaded the formal and peer Skills."));
  const model = await fetch("http://stage3-model:8080/status").then(
    (response) => response.json(),
  );
  assert.deepEqual(model.errors, []);
  for (const phase of [
    "foreground-caller-search",
    "foreground-caller-load-formal",
    "foreground-caller-load-peer",
    "foreground-caller-reply",
    "review-peer-create",
  ])
    assert(
      model.requests.includes(phase),
      `missing actual model phase ${phase}`,
    );
  console.log(
    JSON.stringify({
      status: "active_caller_search_passed",
      caller_agent_id: callerId,
      peer_agent_id: peerId,
      session_id: sessionId,
      own_projection: candidates.own,
      peer_projection: candidates.peer,
      formal,
      tools: starts.map((entry) => entry.update.title),
      local_skill_still_available: true,
    }),
  );
} finally {
  await acp.close();
}
