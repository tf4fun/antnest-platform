import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { durablePath } from "./storage.mjs";

// A private, disposable native Runtime receiver; never a production provisioner.
export function createRuntimeReceiver(output) {
  output = durablePath(output);
  mkdirSync(output, { mode: 0o700 });
  const tokens = Object.fromEntries(
    ["runtime-controller", "agent-acp-service"].map((caller) => [
      caller,
      randomBytes(32).toString("base64url"),
    ]),
  );
  const hash = (value) =>
    "sha256:" + createHash("sha256").update(value).digest("hex");
  const raw = JSON.stringify(
    Object.fromEntries(
      Object.entries(tokens).map(([caller, token]) => [caller, [hash(token)]]),
    ),
  );
  for (const [file, contents] of [
    ["callers.json", raw],
    [
      "mcp.headers",
      "Antnest-Service-Authorization: Bearer " +
        tokens["agent-acp-service"] +
        "\n",
    ],
    [
      "status.headers",
      "Antnest-Service-Authorization: Bearer " +
        tokens["runtime-controller"] +
        "\n",
    ],
  ])
    writeFileSync(join(output, file), contents, { flag: "wx", mode: 0o600 });
  return {
    connection_id: "rci_" + randomBytes(16).toString("hex"),
    callers_file: "/run/antnest-auth/callers.json",
    receiver_digest: hash(raw),
  };
}

// The Runtime accepts only a root-owned 0700 directory holding a root-owned
// 0600 callers.json, so a short-lived root container installs it in a volume.
export async function installRuntimeReceiver(invoke, image, volume, output) {
  await invoke(["volume", "create", volume]);
  await invoke([
    "run",
    "--rm",
    "--network",
    "none",
    "--entrypoint",
    "sh",
    "--mount",
    `type=bind,src=${output},dst=/fixture/auth,readonly`,
    "--mount",
    `type=volume,src=${volume},dst=/run/antnest-auth`,
    image,
    "-c",
    "chmod 700 /run/antnest-auth; cp /fixture/auth/callers.json /run/antnest-auth/; chown 0:0 /run/antnest-auth /run/antnest-auth/callers.json; chmod 600 /run/antnest-auth/callers.json",
  ]);
}

// Runtime admits only Host values naming its own listen port, and fetch cannot
// override Host, so host-side callers publish the listen port one-to-one.
export function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv.length !== 3)
    throw new Error("private receiver output required");
  console.log(JSON.stringify(createRuntimeReceiver(process.argv[2])));
}
