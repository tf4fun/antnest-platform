import { generateKeyPairSync } from "node:crypto";
import { learningImageOverlay } from "../skill-learning/development-settings.mjs";

export const workspaceOverlay = [
  "-f",
  "tests/e2e/workspace-closeout/c4.compose.yaml",
  ...learningImageOverlay,
];

export const productionOverlay = [
  ...workspaceOverlay,
  "-f",
  "tests/e2e/skill-learning/deployment.compose.yaml",
  "-f",
  "tests/e2e/skill-learning/propagation.compose.yaml",
];

export function configureWorkspaceNetworks(config) {
  Object.assign(config.env, {
    ANTNEST_C4_CONTROL_DYNAMIC_RANGE:
      config.env.ANTNEST_EGRESS_CONTROL_SUBNET.replace(".0/24", ".128/25"),
    ANTNEST_C4_RUNTIME_DYNAMIC_RANGE:
      config.env.ANTNEST_RUNTIME_MANAGEMENT_SUBNET.replace(".0/24", ".128/25"),
  });
}

export function configureProductionSigning(config) {
  if (!config.env.ANTNEST_E2E_SKILL_SIGNING_KEY) {
    const keys = generateKeyPairSync("ed25519");
    Object.assign(config.env, {
      ANTNEST_E2E_SKILL_SIGNING_KID: "key_2026-01",
      ANTNEST_E2E_SKILL_SIGNING_KEY: keys.privateKey
        .export({ format: "der", type: "pkcs8" })
        .toString("base64"),
      ANTNEST_E2E_SKILL_MAINTENANCE_VERIFIERS: JSON.stringify({
        keys: [
          {
            kid: "key_2026-01",
            algorithm: "Ed25519",
            public_key_base64url: keys.publicKey.export({ format: "jwk" }).x,
          },
        ],
      }),
    });
  }
  Object.assign(config.env, {
    ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KID:
      config.env.ANTNEST_E2E_SKILL_SIGNING_KID,
    ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KEY:
      config.env.ANTNEST_E2E_SKILL_SIGNING_KEY,
    ANTNEST_RUNTIME_SKILL_MAINTENANCE_VERIFIERS:
      config.env.ANTNEST_E2E_SKILL_MAINTENANCE_VERIFIERS,
  });
}

export async function resources(docker) {
  const value = {};
  for (const [kind, args] of [
    ["containers", ["ps", "-aq"]],
    ["running", ["ps", "-q"]],
    ["networks", ["network", "ls", "-q"]],
    ["volumes", ["volume", "ls", "-q"]],
  ])
    value[kind] = (await docker(args)).split(/\s+/u).filter(Boolean).sort();
  return value;
}
