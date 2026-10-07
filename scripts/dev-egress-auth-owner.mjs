// Egress needs root-owned bootstrap files even when Docker uses Linux bind mounts.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
const files = ["callers.json", "tunnel-master.key"];

export async function prepareEgressOwnership(invoke, directory) {
  const path = resolve(directory);
  const contained = [
    "artifacts/service-authentication",
    "artifacts/verification",
  ].some((base) => {
    const child = relative(resolve(root, base), path);
    return (
      child === "" ||
      (child !== ".." &&
        !child.startsWith(`..${sep}`) &&
        !child.startsWith(sep))
    );
  });
  if (!contained || path.includes(",") || path.split(sep).includes(".cache"))
    throw new Error("egress_ownership_invalid");
  for (let parent = path + "/runtime-egress"; ; parent = dirname(parent)) {
    const row = lstatSync(parent);
    if (!row.isDirectory() || row.isSymbolicLink())
      throw new Error("egress_ownership_invalid");
    if (dirname(parent) === parent) break;
  }
  for (const file of files) {
    const row = lstatSync(path + "/runtime-egress/" + file);
    if (
      !row.isFile() ||
      row.isSymbolicLink() ||
      row.nlink !== 1 ||
      (row.mode & 0o777) !== 0o600 ||
      (file === "tunnel-master.key"
        ? row.size !== 32
        : row.size < 2 || row.size > 8192)
    )
      throw new Error("egress_ownership_invalid");
  }
  await invoke([
    "run",
    "--rm",
    "--name",
    "antnest-egress-owner-" + randomUUID(),
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--cap-add",
    "CHOWN",
    "--security-opt",
    "no-new-privileges:true",
    "--user",
    "0:0",
    ...files.flatMap((file) => [
      "--mount",
      `type=bind,src=${path}/runtime-egress/${file},dst=/auth/${file}`,
    ]),
    "node:24.21.0-bookworm-slim",
    "node",
    "-e",
    "const fs=require('node:fs'); for(const file of ['/auth/callers.json','/auth/tunnel-master.key']) {fs.chownSync(file,0,0);const s=fs.statSync(file);if(s.uid!==0||s.gid!==0||(s.mode&511)!==384)throw Error('owner');}",
  ]);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const { values } = parseArgs({
      options: {
        directory: {
          type: "string",
          default:
            process.env.ANTNEST_SERVICE_AUTH_DIRECTORY ??
            resolve(root, "artifacts/service-authentication"),
        },
      },
    });
    await prepareEgressOwnership(
      (args) =>
        execFileSync("docker", args, {
          timeout: 30000,
          stdio: ["ignore", "ignore", "pipe"],
        }),
      values.directory,
    );
    console.log(JSON.stringify({ complete: true, files: files.length }));
  } catch {
    console.error("egress_ownership_failed");
    process.exitCode = 1;
  }
}
