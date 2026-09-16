import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { waitForAgentReady } from "../verification/agent-state.mjs";

export const member = {
  organization_slug: "stage3",
  email: "c4-member@example.com",
  password: "c4-member-password",
};

export async function until(check, label, signal, timeout = 120000) {
  const deadline = Date.now() + timeout;
  do {
    signal?.throwIfAborted();
    const value = await check();
    if (value) return value;
    await delay(250, undefined, { signal });
  } while (Date.now() < deadline);
  throw new Error(`${label}: deadline exceeded`);
}

export async function setup(config, signal) {
  const client = new GatewayClient(config.gateway);
  const json = async (path, options) =>
    (await client.request(path, options)).body;
  await json("/api/session/login", {
    body: {
      organization_slug: "stage3",
      email: "stage3-admin@example.com",
      password: "stage3-admin-password",
    },
  });
  const owner = await json("/api/admin/directory/users", {
    body: {
      email: member.email,
      display_name: "C4 member",
      password: member.password,
      role: "member",
    },
  });
  await json("/api/admin/provider-connections", {
    status: 201,
    body: {
      provider_key: "deepseek",
      display_name: "C4 controlled provider",
      base_url: "http://stage3-model:8080/v1",
      credential: { method: "api_key", api_key: "stage3-model-secret" },
      models: [
        {
          display_name: "C4 vision",
          model: {
            model: "stage3-model",
            context_window: 8192,
            max_output_tokens: 1024,
            supports_images: true,
          },
        },
      ],
    },
  });
  const profiles = (await json("/api/admin/model-profiles")).items;
  assert.equal(profiles.length, 1);
  const template = await json("/api/admin/templates", {
    status: 201,
    body: {
      name: "C4 template",
      model_profile_id: profiles[0].model_profile_id,
      system_prompt: "Synthetic browser acceptance",
      max_model_requests: 8,
      runtime: { image_ref: config.image },
    },
  });
  async function operation(id) {
    return until(
      async () => {
        const value = await json(`/api/admin/operations/${id}`);
        assert.notEqual(
          value.state,
          "failed",
          `${value.kind} failed: ${value.error_code}`,
        );
        return value.state === "completed" && value;
      },
      "lifecycle operation",
      signal,
    );
  }
  const created = await json("/api/admin/agents", {
    status: 202,
    body: {
      owner_user_id: owner.user.id,
      name: "C4 Browser Agent",
      template_id: template.template_id,
      template_revision: template.revision,
    },
  });
  const agentID = created.agent.agent_id;
  const ready = () =>
    waitForAgentReady(() => json(`/api/admin/agents/${agentID}`), signal);
  await operation(created.operation.request_id);
  await ready();
  const memberClient = new GatewayClient(config.gateway);
  await memberClient.request("/api/session/login", { body: member });
  const state = async () =>
    (await memberClient.request(`/api/app/agents/${agentID}/state`)).body;
  return {
    json,
    operation,
    ready,
    state,
    agentID,
    template,
    ownerID: owner.user.id,
  };
}
