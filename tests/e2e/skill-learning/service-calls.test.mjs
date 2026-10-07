import assert from "node:assert/strict";
import test from "node:test";
import { serviceCalls } from "./service-calls.mjs";

const credentials = {
  "gateway-identity": "g".repeat(43),
  "acp-controller": "a".repeat(43),
  "console-controller": "c".repeat(43),
  "acp-registry": "r".repeat(43),
  "console-registry": "s".repeat(43),
};
function harness(responses) {
  const requests = [];
  const calls = serviceCalls({
    readCredential: (grant) => {
      assert(Object.hasOwn(credentials, grant), `unexpected grant ${grant}`);
      return credentials[grant];
    },
    fetch: async (url, init) => {
      requests.push({ url, ...init });
      const next = responses.shift();
      return new Response(JSON.stringify(next.body), { status: next.status });
    },
  });
  return { calls, requests };
}
const header = (request, name) => request.headers[name];

test("policy reads use the ACP workload grant and owner scope only", async () => {
  const { calls, requests } = harness([
    { status: 200, body: { mode: "automatic", revision: 3 } },
  ]);
  const policy = await calls.learningPolicy("agent_x", {
    organization_id: "org_1",
    principal_id: "user_1",
  });
  assert.equal(policy.revision, 3);
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "http://agent-controller:8080/internal/agents/agent_x/skill-learning-policy?organization_id=org_1&principal_id=user_1",
  );
  assert.equal(requests[0].method, "GET");
  assert.equal(
    header(requests[0], "Antnest-Service-Authorization"),
    `Bearer ${credentials["acp-controller"]}`,
  );
  assert.equal(header(requests[0], "Antnest-Caller-Context"), undefined);
});

test("policy changes carry a Console grant and an Identity-issued owner context", async () => {
  const { calls, requests } = harness([
    { status: 200, body: { access_token: "session-token" } },
    { status: 200, body: { caller_context: "cct" } },
    { status: 200, body: { mode: "off" } },
  ]);
  const body = { request_id: "r", mode: "off" };
  const changed = await calls.setLearningPolicy(
    "agent_x",
    { email: "member@example.com", password: "pw", organization_slug: "o" },
    body,
  );
  assert.equal(changed.mode, "off");
  const [login, issue, put] = requests;
  assert.equal(
    login.url,
    "http://identity-service:8080/rpc/identity/local-login",
  );
  assert.equal(
    header(login, "Antnest-Service-Authorization"),
    `Bearer ${credentials["gateway-identity"]}`,
  );
  const loginBody = JSON.parse(login.body);
  assert.equal(loginBody.email, "member@example.com");
  assert.match(loginBody.request_id, /^[0-9a-f-]{36}$/u);
  assert.equal(
    issue.url,
    "http://identity-service:8080/rpc/identity/resolve-access-token",
  );
  assert.deepEqual(JSON.parse(issue.body), {
    access_token: "session-token",
    profile: "console",
    agent_id: "agent_x",
  });
  assert.equal(put.method, "PUT");
  assert.equal(
    put.url,
    "http://agent-controller:8080/internal/agents/agent_x/skill-learning-policy",
  );
  assert.equal(
    header(put, "Antnest-Service-Authorization"),
    `Bearer ${credentials["console-controller"]}`,
  );
  assert.equal(header(put, "Antnest-Caller-Context"), "cct");
  assert.equal(header(put, "Content-Type"), "application/json");
  assert.deepEqual(JSON.parse(put.body), body);
});

test("registry search runs as the ACP workload without user context", async () => {
  const { calls, requests } = harness([{ status: 200, body: { items: [] } }]);
  const response = await calls.registrySearch({ query: "q" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { items: [] });
  assert.equal(
    requests[0].url,
    "http://skill-registry:8080/internal/skill-discovery/search",
  );
  assert.equal(
    header(requests[0], "Antnest-Service-Authorization"),
    `Bearer ${credentials["acp-registry"]}`,
  );
  assert.equal(header(requests[0], "Antnest-Caller-Context"), undefined);
});

test("registry uploads send the multipart form as the Console with an admin context", async () => {
  const principal = { organization_id: "org_1", user_id: "user_admin" };
  const { calls, requests } = harness([
    { status: 200, body: { access_token: "admin-session", principal } },
    { status: 200, body: { caller_context: "admin-cct" } },
    { status: 201, body: { name: "fixture" } },
  ]);
  const form = new FormData();
  let seen;
  const response = await calls.registryUpload(
    { email: "admin@example.com", password: "pw", organization_slug: "o" },
    (admin) => {
      seen = admin;
      form.set("metadata", JSON.stringify({ actor_id: admin.user_id }));
      return form;
    },
  );
  assert.equal(response.status, 201);
  assert.deepEqual(seen, principal);
  const [, issue, upload] = requests;
  assert.deepEqual(JSON.parse(issue.body), {
    access_token: "admin-session",
    profile: "console",
  });
  assert.equal(upload.url, "http://skill-registry:8080/internal/skills");
  assert.equal(upload.body, form);
  assert.equal(header(upload, "Content-Type"), undefined);
  assert.equal(
    header(upload, "Antnest-Service-Authorization"),
    `Bearer ${credentials["console-registry"]}`,
  );
  assert.equal(header(upload, "Antnest-Caller-Context"), "admin-cct");
});

test("unexpected statuses fail without echoing credentials", async () => {
  const { calls } = harness([{ status: 403, body: { code: "forbidden" } }]);
  await assert.rejects(
    calls.learningPolicy("agent_x", {
      organization_id: "org_1",
      principal_id: "user_1",
    }),
    (error) => {
      assert.match(error.message, /skill-learning-policy.*403.*forbidden/u);
      for (const value of Object.values(credentials))
        assert(!error.message.includes(value));
      return true;
    },
  );
});

test("credentials must be disposable token encodings", () => {
  const calls = serviceCalls({
    readCredential: () => "not a token",
    fetch: async () => assert.fail("must not send"),
  });
  return assert.rejects(
    calls.learningPolicy("agent_x", {
      organization_id: "o",
      principal_id: "p",
    }),
    /invalid disposable credential/u,
  );
});
