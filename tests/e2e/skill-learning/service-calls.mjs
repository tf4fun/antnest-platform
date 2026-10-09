import { serviceClient } from "../../support/service-grants.mjs";

const endpoints = {
  controller: "http://agent-controller:8080",
  registry: "http://skill-registry:8080",
};

// Internal routes admit only named workloads. Skill clients borrow the same
// disposable per-project grants the authenticated peer uses (mounted under
// /run/auth by skillClientArgs) instead of reaching routes unauthenticated.
export function serviceCalls(options) {
  const { send, json, callerContext } = serviceClient(options);
  const policyPath = (agentId) =>
    `${endpoints.controller}/internal/agents/${agentId}/skill-learning-policy`;
  return {
    learningPolicy: (agentId, { organization_id, principal_id }) =>
      json(
        `${policyPath(agentId)}?${new URLSearchParams({ organization_id, principal_id })}`,
        "acp-controller",
        { method: "GET" },
      ),
    setLearningPolicy: async (agentId, account, body) =>
      json(policyPath(agentId), "console-controller", {
        method: "PUT",
        context: (await callerContext(account, agentId)).context,
        body,
      }),
    // The Registry requires the metadata actor to equal the verified admin,
    // so the form is built only after the admin principal is known.
    registryUpload: async (account, buildForm) => {
      const { context, principal } = await callerContext(account);
      return send(`${endpoints.registry}/internal/skills`, "console-registry", {
        form: buildForm(principal),
        context,
      });
    },
    registrySearch: (body) =>
      send(
        `${endpoints.registry}/internal/skill-discovery/search`,
        "acp-registry",
        { body },
      ),
  };
}
