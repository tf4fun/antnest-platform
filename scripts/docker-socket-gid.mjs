import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export function validateDockerSocketGid(value) {
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9][0-9]*)$/u.test(value) ||
    Number(value) > 4294967294
  )
    throw new Error(
      "ANTNEST_DOCKER_SOCKET_GID must be a decimal Docker socket group ID",
    );
  return value;
}

export async function resolveDockerSocketGid(
  invoke,
  override = process.env.ANTNEST_DOCKER_SOCKET_GID,
) {
  if (override !== undefined && override !== "")
    return validateDockerSocketGid(override);
  try {
    const result = await invoke([
      "run",
      "--rm",
      "--pull=never",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--user",
      "65532:65532",
      "--mount",
      "type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock,readonly",
      "node:24.21.0-bookworm-slim",
      "node",
      "-e",
      "const socket=require('node:fs').statSync('/var/run/docker.sock');if(!socket.isSocket())throw Error('socket');process.stdout.write(String(socket.gid));",
    ]);
    return validateDockerSocketGid(String(result).trim());
  } catch {
    throw new Error(
      "ANTNEST_DOCKER_SOCKET_GID is required: cannot inspect the Docker-visible socket; preload node:24.21.0-bookworm-slim or set a verified socket GID explicitly",
    );
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const { values } = parseArgs({ options: { gid: { type: "string" } } });
    const gid = await resolveDockerSocketGid(
      (args) =>
        execFileSync("docker", args, {
          encoding: "utf8",
          timeout: 30000,
          stdio: ["ignore", "pipe", "pipe"],
        }),
      values.gid ?? process.env.ANTNEST_DOCKER_SOCKET_GID,
    );
    process.stdout.write(gid + "\n");
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "ANTNEST_DOCKER_SOCKET_GID detection failed",
    );
    process.exitCode = 1;
  }
}
