import assert from "node:assert/strict";
import { resolve } from "node:path";
import { lines } from "./docker.mjs";
import { serviceContainer } from "./recovery-support.mjs";

const senderFiles =
  'for f in /tmp/antnest-runtime-senders-*/*/antnest-runtime; do [ -f "$f" ] && { cat "$f"; echo; }; done';
const statusRequest =
  'curl --fail --silent -H "antnest-service-authorization: Bearer $ANTNEST_RUNTIME_STATUS_BEARER" http://127.0.0.1:8093/status';

// Runtime /status admits only the Runtime Controller and ACP workloads. The
// Controller keeps one sender credential per Runtime connection in its private
// temporary directory, so the read tries each until the Runtime accepts one;
// the answer still comes from the live Runtime process.
export async function runtimeStatus(docker, project, runtimeId) {
  const controller = await serviceContainer(
    docker,
    project,
    "runtime-controller",
  );
  const tokens = lines(
    await docker(["exec", controller.Id, "sh", "-c", senderFiles]),
  );
  assert(tokens.length > 0, "Runtime Controller holds no Runtime credential");
  for (const token of tokens) {
    let output;
    try {
      output = await docker([
        "exec",
        "-e",
        `ANTNEST_RUNTIME_STATUS_BEARER=${token}`,
        runtimeId,
        "sh",
        "-c",
        statusRequest,
      ]);
    } catch {
      continue;
    }
    return JSON.parse(output);
  }
  throw new Error("Runtime rejected every Runtime Controller credential");
}

// Runtime Controller's internal API admits only the Agent Controller
// workload; a disposable probe on its network reads with that credential
// mounted, keeping the token out of process arguments.
export async function runtimeControllerRead(docker, config, path) {
  assert.match(path, /^\/internal\/[\w/?=&.-]+$/u);
  const token = resolve(
    config.credentials,
    "agent-controller/tokens/runtime-controller",
  );
  return JSON.parse(
    await docker([
      "run",
      "--rm",
      "--pull",
      "never",
      "--label",
      `com.docker.compose.project=${config.project}`,
      "--network",
      `${config.project}_controller-runtime`,
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--user",
      `${process.getuid()}:${process.getgid()}`,
      "--mount",
      `type=bind,src=${token},dst=/proof/token,readonly`,
      "antnest/agent-acp-service:local",
      "node",
      "-e",
      `const token = require("node:fs").readFileSync("/proof/token", "utf8").trim();
fetch("http://runtime-controller:8080" + process.argv[1], { headers: { "Antnest-Service-Authorization": "Bearer " + token }, signal: AbortSignal.timeout(5000) })
  .then(async (response) => { if (response.status !== 200) throw new Error("Runtime query " + response.status); console.log(JSON.stringify(await response.json())); });`,
      path,
    ]),
  );
}
