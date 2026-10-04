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
      "tests/integration/platform/service-token-contract.test.mjs",
      "scripts/dev-service-tokens.mjs",
      "tests/integration/runtime-egress/service-authentication-contract.test.mjs",
      "tests/support/service-authentication-eslint.config.mjs",
      "tests/support/service-authentication.test.mjs",
    ],
    ...tseslint.configs.disableTypeChecked,
  },
];
