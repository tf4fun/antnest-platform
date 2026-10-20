import assert from "node:assert/strict";
import { resolve } from "node:path";
import { lines } from "./docker.mjs";
import { serviceContainer } from "./recovery-support.mjs";

const senderFiles =
  'for f in /tmp/antnest-runtime-senders-*/*/antnest-runtime; do [ -f "$f" ] && { cat "$f"; echo; }; done';

function statusBudget(docker, { signal, timeoutMS = 30000 } = {}) {
  assert(Number.isFinite(timeoutMS) && timeoutMS > 0);
  const deadline = performance.now() + timeoutMS;
  const bounded = AbortSignal.any(
    [signal, AbortSignal.timeout(Math.ceil(timeoutMS))].filter(Boolean),
  );
  const remaining = () => {
    bounded.throwIfAborted();
    const value = deadline - performance.now();
    assert(value > 0, "Runtime status timed out");
    return value;
  };
  const read = async (args) => {
    const result = await docker(args, false, {
      signal: bounded,
      timeoutMS: remaining(),
    });
    remaining();
    return result;
  };
  return { read, remaining };
}

async function requestStatus({ read, remaining }, runtimeId, token) {
  const seconds = Math.max(0.001, Math.floor(remaining()) / 1000);
  const output = await read([
    "exec",
    "-e",
    `ANTNEST_RUNTIME_STATUS_BEARER=${token}`,
    runtimeId,
    "sh",
    "-c",
    `curl --fail --silent --max-time ${seconds} -H "antnest-service-authorization: Bearer $ANTNEST_RUNTIME_STATUS_BEARER" http://127.0.0.1:8093/status`,
  ]);
  return output;
}

// Select a credential while Identity is available. Subsequent reads keep that
// credential private and query the original Runtime afresh, with each caller's
// current bounded Docker operation. They never reuse a previous /status body
// or silently discover replacement credentials during the measured window.
export async function prepareRuntimeStatus(
  docker,
  project,
  runtimeId,
  options,
) {
  const initial = statusBudget(docker, options);
  const { read, remaining } = initial;
  const controller = await serviceContainer(
    read,
    project,
    "runtime-controller",
  );
  const tokens = lines(
    await read(["exec", controller.Id, "sh", "-c", senderFiles]),
  );
  assert(tokens.length > 0, "Runtime Controller holds no Runtime credential");
  for (const token of tokens) {
    let output;
    try {
      output = await requestStatus(initial, runtimeId, token);
    } catch (error) {
      if (error.remoteCleanupPending) throw error;
      remaining();
      continue;
    }
    let status;
    try {
      status = JSON.parse(output);
    } catch {
      throw new Error("Runtime status response invalid");
    }
    return {
      status,
      async read(currentDocker, currentOptions) {
        const current = statusBudget(currentDocker, currentOptions);
        try {
          return JSON.parse(await requestStatus(current, runtimeId, token));
        } catch (error) {
          if (error.remoteCleanupPending) throw error;
          current.remaining();
          throw new Error("Runtime rejected the bound Controller credential");
        }
      },
    };
  }
  throw new Error("Runtime rejected every Runtime Controller credential");
}

// One-shot callers retain discovery and one live read under a single budget.
export async function runtimeStatus(docker, project, runtimeId, options) {
  return (await prepareRuntimeStatus(docker, project, runtimeId, options))
    .status;
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
