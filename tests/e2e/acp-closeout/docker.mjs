import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { gatewayOrigin } from "../../support/gateway-origin.mjs";

// Docker commands may stall even when their surrounding polling loop is bounded.
export function dockerInvocation(args, deadline, now = Date.now(), env = {}) {
  const remaining = Number(deadline) - now;
  if (!Number.isFinite(remaining) || remaining <= 0) return;
  const lifecycle = args[0] === "--lifecycle";
  let command = lifecycle ? args.slice(1) : args;
  const explicitOrigin = command.some((value) =>
    /^(?:(?:--env=|-e))?TEST_GATEWAY_PUBLIC_URL(?:=|$)/u.test(value),
  );
  if (
    ["run", "create"].includes(command[0]) &&
    !explicitOrigin &&
    (env.TEST_GATEWAY_PUBLIC_URL || env.ANTNEST_EDGE_PUBLIC_BASE_URL)
  ) {
    command = [
      command[0],
      "--env",
      `TEST_GATEWAY_PUBLIC_URL=${gatewayOrigin("http://edge-gateway:8080", env)}`,
      ...command.slice(1),
    ];
  }
  return {
    args: command,
    timeoutMs: lifecycle ? remaining : Math.min(30000, remaining),
  };
}

function main() {
  const invocation = dockerInvocation(
    process.argv.slice(2),
    process.env.ANTNEST_E2E_DEADLINE_MS,
    Date.now(),
    process.env,
  );
  if (!invocation) process.exit(124);
  const child = spawn("docker", invocation.args, {
    detached: true,
    stdio: "inherit",
  });
  let failure = 0;
  const terminate = (code) => {
    failure = code;
    if (!child.pid) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  const timer = setTimeout(() => terminate(124), invocation.timeoutMs);
  process.on("SIGINT", () => terminate(130));
  process.on("SIGTERM", () => terminate(143));
  child.once("error", (error) => {
    console.error(error.message);
    failure = 1;
  });
  child.once("close", (code) => {
    clearTimeout(timer);
    process.exitCode = failure || code || (code === 0 ? 0 : 1);
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  main();
