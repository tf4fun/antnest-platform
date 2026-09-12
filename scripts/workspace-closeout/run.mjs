import { fileURLToPath } from "node:url";
import {
  configuration,
  dockerClient,
  composeArgs,
  cleanup,
} from "../lifecycle-closeout/docker.mjs";
import { runFlow } from "../lifecycle-closeout/flow.mjs";
import { workspaceFlow } from "./flow.mjs";

process.chdir(fileURLToPath(new URL("../../", import.meta.url)));
const abort = new AbortController();
const interrupt = () =>
  abort.abort(new Error("Workspace integration interrupted"));
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const timer = setTimeout(interrupt, 900000);
let config, result;
try {
  config = await configuration(abort.signal);
  console.error(`Disposable workspace project: ${config.project}`);
  const docker = dockerClient(config.env, abort.signal);
  await docker(
    composeArgs(config.project, [
      "-f",
      "scripts/workspace-closeout/compose.yaml",
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      "180",
      "--no-build",
    ]),
    true,
  );
  result = await runFlow(config, docker, abort.signal, workspaceFlow);
} finally {
  clearTimeout(timer);
  if (config) await cleanup(config);
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
abort.signal.throwIfAborted();
console.log(
  JSON.stringify({ status: "passed", ...result, cleanup: "verified" }),
);
