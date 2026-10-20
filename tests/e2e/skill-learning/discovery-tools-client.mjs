import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { openSkillACP, withSkillACPClient } from "./private-client.mjs";
import { readPrivateExecutionState } from "../../support/private-acp-execution-state.mjs";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { member, until } from "../workspace-closeout/c4-setup.mjs";

const agentId = process.env.ANTNEST_E2E_AGENT_ID;
const sourceAgentId = process.env.ANTNEST_E2E_SOURCE_AGENT_ID;
const stateEvidence = process.env.ANTNEST_E2E_PRIVATE_STATE_EVIDENCE;
assert(agentId && sourceAgentId && agentId !== sourceAgentId);
assert(stateEvidence, "private state evidence destination required");
const client = new GatewayClient("http://edge-gateway:8080");
let acp;
let stage = "login";
let stateReads = 0;
let lastState;
const stateReceipts = [],
  secrets = [];
const errors = [];
try {
  await withSkillACPClient(
    { closeAndWait: () => acp?.closeAndWait() },
    async () => {
      try {
        const principal = (
          await client.request("/api/session/login", { body: member })
        ).body.principal;
        stage = "execution-readiness";
        // Controller readiness precedes ACP publication (#44). Establish this
        // discovery scenario's consumer precondition before opening a session; a
        // later new/prompt agent_unavailable remains a failure; Prompt is sent once.
        const readinessDeadline = Date.now() + 90000;
        await until(
          async () => {
            const remaining = readinessDeadline - Date.now();
            assert(
              remaining > 0,
              "target Agent execution readiness: deadline exceeded",
            );
            stateReads++;
            const state = await readPrivateExecutionState(agentId, client, {
              principal,
              receipts: stateReceipts,
              secrets,
              signal: AbortSignal.timeout(Math.min(15000, remaining)),
            });
            lastState = {
              agent_id: state?.agent_id,
              access_allowed: state?.access_allowed,
              availability: state?.availability,
              active_session_id: state?.active_session_id,
              configuration_revision: state?.configuration_revision,
              unavailable_reason: state?.unavailable_reason,
            };
            assert(
              Date.now() < readinessDeadline,
              "target Agent execution readiness: deadline exceeded",
            );
            assert.equal(state?.agent_id, agentId);
            assert.equal(state.access_allowed, true);
            assert.equal(state.active_session_id, null);
            assert.match(state.configuration_revision, /^[a-f0-9]{64}$/u);
            if (state.availability === "ready") {
              assert.equal(state.unavailable_reason, null);
              return state;
            }
            assert.equal(state.availability, "offline");
            assert.equal(state.unavailable_reason, "agent_unavailable");
            return null;
          },
          "target Agent execution readiness",
          undefined,
          90000,
        );
        stage = "initialize";
        acp = await openSkillACP(1, agentId, client, {
          principal,
          secrets,
          requestPermission: ({ params }) => ({
            outcome: {
              outcome: "selected",
              optionId: params.options.find(
                (option) => option.kind === "allow_once",
              ).optionId,
            },
          }),
        });
        stage = "session/new";
        const { sessionId } = await until(
          async () => {
            try {
              return await acp.request("new", {
                cwd: "/workspace",
                mcpServers: [],
              });
            } catch (error) {
              if (error?.data?.code === "configuration_not_ready") return null;
              throw error;
            }
          },
          "target Agent configuration",
          undefined,
          90000,
        );
        stage = "session/prompt";
        assert.equal(
          (
            await acp.request(
              "prompt",
              {
                sessionId,
                prompt: [
                  { type: "text", text: "discover reusable fixture-procedure" },
                ],
              },
              90000,
            )
          ).stopReason,
          "end_turn",
        );
        const starts = acp.updates.filter(
          (entry) => entry.update.sessionUpdate === "tool_call",
        );
        assert.deepEqual(
          starts.map((entry) => entry.update.title),
          ["Find Skill", "Load Skill"],
        );
        stage = "workspace-view";
        const view = (
          await client.request(
            `/api/app/workspace/v1/agents/${agentId}/view?sessionId=${sessionId}`,
          )
        ).body;
        assert.equal(view.systemNotices?.length ?? 0, 0);
        console.log(
          JSON.stringify({
            status: "model_discovery_guidance_loaded",
            source_agent_id: sourceAgentId,
            target_agent_id: agentId,
            readiness: {
              reads: stateReads,
              state: lastState,
            },
            session_id: sessionId,
            tools: starts.map((entry) => entry.update.title),
          }),
        );
      } catch (error) {
        console.error(
          JSON.stringify({
            status: "discovery_tools_failed",
            stage,
            target_agent_id: agentId,
            state_reads: stateReads,
            last_state: lastState,
          }),
        );
        throw error;
      }
    },
  );
} catch (error) {
  errors.push(error);
}
try {
  await writeFile(stateEvidence, JSON.stringify(stateReceipts), {
    flag: "wx",
    mode: 0o600,
  });
} catch (error) {
  errors.push(error);
}
if (errors.length === 1) throw errors[0];
if (errors.length)
  throw new AggregateError(
    errors,
    "Discovery work and private state archive failed",
  );
