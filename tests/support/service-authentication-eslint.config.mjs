import serviceConfiguration from "../../services/agent-acp-service/eslint.config.js";
import tseslint from "../../services/agent-acp-service/node_modules/typescript-eslint/dist/index.js";

export default [
  ...serviceConfiguration,
  {
    files: [
      "tests/e2e/service-authentication/**/*.mjs",
      "tests/support/service-authentication.test.mjs",
    ],
    ...tseslint.configs.disableTypeChecked,
  },
];
