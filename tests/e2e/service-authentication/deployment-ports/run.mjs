import { fileURLToPath } from "node:url";
import { withDependencies } from "../../../support/dependencies.mjs";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const output = fileURLToPath(
  new URL(
    `../../../../artifacts/verification/issue-32-deployment-ports-${Date.now()}/`,
    import.meta.url,
  ),
);
const result = await withDependencies({
  profile: "temporal",
  command: [
    process.execPath,
    fileURLToPath(new URL("./connectivity.mjs", import.meta.url)),
  ],
  output,
  name: "connectivity",
  cwd: root,
  timeoutMs: 60000,
  graceMs: 30000,
});
console.log(JSON.stringify(result));
process.exitCode = result.exit_code;
