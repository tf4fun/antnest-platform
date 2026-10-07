import assert from "node:assert/strict";
import test from "node:test";
import { skillClientArgs } from "./client-container.mjs";

const config = {
  project: "antnest-lifecycle-0000abcd",
  credentials: "/work/artifacts/credentials",
  env: { ANTNEST_SERVICE_AUTH_UID: "1234", ANTNEST_SERVICE_AUTH_GID: "5678" },
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
});

test("unknown grants are rejected", () => {
  assert.throws(() => skillClientArgs(config, { grants: ["admin-registry"] }));
});
