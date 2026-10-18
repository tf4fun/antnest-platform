import assert from "node:assert/strict";
import test from "node:test";
import { skillClientArgs } from "./client-container.mjs";

const config = {
  project: "antnest-lifecycle-0000abcd",
  credentials: "/work/artifacts/credentials",
  env: {
    ANTNEST_SERVICE_AUTH_UID: "1234",
    ANTNEST_SERVICE_AUTH_GID: "5678",
    ANTNEST_SERVICE_NETWORK_PREFIX: "10.244.7",
  },
};
const networks = (args) =>
  args.flatMap((value, index) =>
    args[index - 1] === "--network" ? [value] : [],
  );

test("plain clients reach only the gateway and the model fixture", () => {
  const args = skillClientArgs(config);
  assert.deepEqual(networks(args), [
    "antnest-lifecycle-0000abcd_gateway-ingress",
    "antnest-lifecycle-0000abcd_acp-provider",
  ]);
  assert(!args.includes("--user"));
  assert(!args.some((value) => value.includes("/run/auth")));
  assert(!args.some((value) => value.startsWith("--add-host=")));
  assert(
    args.includes("com.docker.compose.project=antnest-lifecycle-0000abcd"),
  );
  assert(!args.some((value) => value.includes("development")));
});

test("granted clients mount each credential read-only and join its receiver network", () => {
  const args = skillClientArgs(config, {
    grants: ["acp-controller", "console-controller", "gateway-identity"],
  });
  assert.deepEqual(networks(args), [
    "antnest-lifecycle-0000abcd_gateway-ingress",
    "antnest-lifecycle-0000abcd_acp-provider",
    "antnest-lifecycle-0000abcd_controller-clients",
    "antnest-lifecycle-0000abcd_identity-clients",
  ]);
  assert.equal(args[args.indexOf("--user") + 1], "1234:5678");
  for (const [grant, sender, receiver] of [
    ["acp-controller", "agent-acp-service", "agent-controller"],
    ["console-controller", "admin-console", "agent-controller"],
    ["gateway-identity", "edge-gateway", "identity-service"],
  ])
    assert(
      args.includes(
        `/work/artifacts/credentials/${sender}/tokens/${receiver}:/run/auth/${grant}:ro`,
      ),
      grant,
    );
});

test("Registry grants join the Registry client network once", () => {
  const args = skillClientArgs(config, {
    grants: ["acp-registry", "console-registry"],
  });
  assert.deepEqual(networks(args), [
    "antnest-lifecycle-0000abcd_gateway-ingress",
    "antnest-lifecycle-0000abcd_acp-provider",
    "antnest-lifecycle-0000abcd_registry-clients",
  ]);
  assert(
    args.includes(
      "/work/artifacts/credentials/admin-console/tokens/skill-registry:/run/auth/console-registry:ro",
    ),
  );
  assert.deepEqual(
    args.filter((value) => value.startsWith("--add-host=")),
    ["--add-host=skill-registry:10.244.7.82"],
  );
});

test("unknown grants are rejected", () => {
  assert.throws(() => skillClientArgs(config, { grants: ["admin-registry"] }));
});

test("private ACP clients opt into exact workload grants and the exporter network", () => {
  const args = skillClientArgs(config, {
    privateACP: true,
    grants: ["console-registry", "gateway-identity"],
  });
  assert.deepEqual(networks(args), [
    "antnest-lifecycle-0000abcd_gateway-ingress",
    "antnest-lifecycle-0000abcd_acp-provider",
    "antnest-lifecycle-0000abcd_registry-clients",
    "antnest-lifecycle-0000abcd_identity-clients",
    "antnest-lifecycle-0000abcd_edge",
    "antnest-lifecycle-0000abcd_observability",
  ]);
  const grants = args.filter((value) => value.includes(":/run/auth/"));
  assert.equal(grants.length, 3);
  assert(
    grants.includes(
      "/work/artifacts/credentials/agent-ui/tokens/agent-acp-service:/run/auth/agent-ui-acp:ro",
    ),
  );
  assert(
    grants.includes(
      "/work/artifacts/credentials/edge-gateway/tokens/identity-service:/run/auth/gateway-identity:ro",
    ),
  );
  assert(args.includes("--add-host=agent-acp-service:10.244.7.5"));
});

test("private ACP network admission requires an explicit boolean", () => {
  for (const privateACP of ["true", 1, null])
    assert.throws(() => skillClientArgs(config, { privateACP }));
});
