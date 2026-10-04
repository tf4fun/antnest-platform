import serviceConfiguration from "../../services/agent-acp-service/eslint.config.js";
import tseslint from "../../services/agent-acp-service/node_modules/typescript-eslint/dist/index.js";

export default [
  ...serviceConfiguration,
  {
    files: [
      "tests/e2e/service-authentication/**/*.mjs",
      "tests/e2e/skill-registry/discovery-docker.mjs",
      "tests/e2e/skill-registry/discovery-source.mjs",
      "tests/integration/platform/service-authentication-contract.test.mjs",
      "tests/integration/platform/development-authentication-contract.test.mjs",
      "tests/integration/platform/development-authentication.test.mjs",
      "tests/integration/platform/development-pki.test.mjs",
      "tests/integration/deployment/host-ports.test.mjs",
      "tests/integration/deployment/diagnostic-relay.test.mjs",
      "tests/integration/deployment/runtime-telemetry-ingress.test.mjs",
      "scripts/deployment/*.mjs",
      "tests/integration/deployment/purpose-listener-docker.mjs",
      "tests/integration/deployment/fixtures/purpose-listener.mjs",
      "tests/integration/deployment/fixtures/transport-peer.mjs",
      "tests/integration/deployment/transports-docker.mjs",
      "tests/integration/platform/development-network-contract.test.mjs",
      "tests/support/dependencies.mjs",
      "tests/support/dependencies.test.mjs",
      "tests/e2e/lifecycle-closeout/docker.mjs",
      "tests/integration/platform/service-token-contract.test.mjs",
      "scripts/dev-service-tokens.mjs",
      "scripts/dev-pki.mjs",
      "scripts/lib/private-output.mjs",
      "tests/support/fixtures/pki-openssl-process.mjs",
      "tests/integration/runtime-egress/service-authentication-contract.test.mjs",
      "tests/support/service-authentication-eslint.config.mjs",
      "tests/support/service-authentication.test.mjs",
    ],
    ...tseslint.configs.disableTypeChecked,
  },
];
