import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { grantContainerArgs, serviceClient } from "./service-grants.mjs";

const config = {
  project: "antnest-stage3-e2e-42",
  credentials: "/work/credentials",
  env: { ANTNEST_SERVICE_AUTH_UID: "1234", ANTNEST_SERVICE_AUTH_GID: "5678" },
};

test("grants add each receiver network once and mount credentials read-only", () => {
  const { networks, args } = grantContainerArgs(config, [
    "controller-runtime",
    "console-controller",
    "acp-controller",
  ]);
  assert.deepEqual(networks, ["controller-runtime", "controller-clients"]);
  assert.deepEqual(args.slice(0, 2), ["--user", "1234:5678"]);
  assert(
    args.includes(
      "/work/credentials/agent-controller/tokens/runtime-controller:/run/auth/controller-runtime:ro",
    ),
  );
});

test("grants pin each receiver to its listener on the receiver network", () => {
  const compose = readFileSync(
    fileURLToPath(new URL("../../compose.yaml", import.meta.url)),
    "utf8",
  );
  const listener = (service, network) => {
    const block = new RegExp(
      `^  ${service}:\\n(?:(?!^  \\S).*\\n)*?      ${network}:\\n        ipv4_address: \\$\\{ANTNEST_SERVICE_NETWORK_PREFIX:-10\\.241\\.0\\}\\.(\\d+)$`,
      "mu",
    ).exec(compose);
    assert(block, `${service} on ${network}`);
    return block[1];
  };
  const prefixed = {
    ...config,
    env: { ...config.env, ANTNEST_SERVICE_NETWORK_PREFIX: "10.244.7" },
  };
  const { args } = grantContainerArgs(prefixed, [
    "gateway-identity",
    "acp-registry",
    "console-registry",
    "console-controller",
    "controller-runtime",
  ]);
  const hosts = args.filter((arg) => arg.startsWith("--add-host="));
  assert.deepEqual(hosts, [
    `--add-host=identity-service:10.244.7.${listener("identity-service", "identity-clients")}`,
    `--add-host=skill-registry:10.244.7.${listener("skill-registry", "registry-clients")}`,
    `--add-host=agent-controller:10.244.7.${listener("agent-controller", "controller-clients")}`,
    `--add-host=runtime-controller:10.244.7.${listener("runtime-controller", "controller-runtime")}`,
  ]);
  assert(
    grantContainerArgs(config, ["gateway-identity"]).args.includes(
      `--add-host=identity-service:10.241.0.${listener("identity-service", "identity-clients")}`,
    ),
  );
});

test("no grants means no user override and no mounts", () => {
  assert.deepEqual(grantContainerArgs(config), { networks: [], args: [] });
  assert.throws(() => grantContainerArgs(config, ["admin-everything"]));
});

function harness(responses) {
  const requests = [];
  const client = serviceClient({
    readCredential: (grant) => grant[0].repeat(43),
    fetch: async (url, init) => {
      requests.push({ url, ...init });
      const next = responses.shift();
      return new Response(JSON.stringify(next.body), { status: next.status });
    },
  });
  return { client, requests };
}

test("json accepts an expected non-200 status and names failures by code", async () => {
  const { client } = harness([
    { status: 403, body: { error: { code: "organization_mismatch" } } },
    { status: 500, body: { code: "internal" } },
  ]);
  const denied = await client.json(
    "http://agent-controller:8080/internal/agents/a?organization_id=o",
    "console-controller",
    { method: "GET", status: 403 },
  );
  assert.equal(denied.error.code, "organization_mismatch");
  await assert.rejects(
    client.json(
      "http://runtime-controller:8080/internal/runtimes/a",
      "controller-runtime",
      { method: "GET" },
    ),
    (error) => {
      assert.equal(error.message, "/internal/runtimes/a: HTTP 500 internal");
      assert(!error.message.includes("c".repeat(43)));
      return true;
    },
  );
});

test("caller contexts come from Identity through the gateway grant", async () => {
  const principal = { organization_id: "org_1", user_id: "user_1" };
  const { client, requests } = harness([
    { status: 200, body: { access_token: "session", principal } },
    { status: 200, body: { caller_context: "cct" } },
  ]);
  const issued = await client.callerContext(
    { organization_slug: "o", email: "e", password: "p" },
    "agent_1",
  );
  assert.deepEqual(issued, { context: "cct", principal });
  assert.equal(
    requests[0].headers["Antnest-Service-Authorization"],
    `Bearer ${"g".repeat(43)}`,
  );
  assert.deepEqual(JSON.parse(requests[1].body), {
    access_token: "session",
    profile: "console",
    agent_id: "agent_1",
  });
});

test("credentials must be disposable token encodings", async () => {
  const client = serviceClient({
    readCredential: () => "not a token",
    fetch: async () => assert.fail("must not send"),
  });
  await assert.rejects(
    client.send("http://identity-service:8080/x", "gateway-identity"),
    /invalid disposable credential/u,
  );
});
