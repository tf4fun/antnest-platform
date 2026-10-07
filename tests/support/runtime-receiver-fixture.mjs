import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
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
  const pair = () => {
    const key = generateKeyPairSync("x25519");
    return {
      private: key.privateKey
        .export({ format: "der", type: "pkcs8" })
        .subarray(-32)
        .toString("base64url"),
      public: key.publicKey
        .export({ format: "der", type: "spki" })
        .subarray(-32)
        .toString("base64url"),
    };
  };
  const runtime = pair(),
    egress = pair(),
    keyID = "rtk_" + randomBytes(16).toString("hex"),
    psk = randomBytes(32).toString("base64url");
  const tunnel = JSON.stringify({
    key_id: keyID,
    runtime_private_key: runtime.private,
    egress_public_key: egress.public,
    preshared_key: psk,
  });
  writeFileSync(join(output, "tunnel.json"), tunnel, {
    flag: "wx",
    mode: 0o600,
  });
  writeFileSync(
    join(output, "egress-tunnel.json"),
    JSON.stringify({
      key_id: keyID,
      egress_private_key: egress.private,
      runtime_public_key: runtime.public,
      preshared_key: psk,
      tunnel_ipv4: "100.64.0.2",
      runtime_revision: "rtv_" + randomBytes(16).toString("hex"),
    }),
    { flag: "wx", mode: 0o600 },
  );
  return {
    tunnel: {
      key_id: keyID,
      keys_file: "/run/antnest-auth/tunnel.json",
      keys_digest: hash(tunnel),
    },
    connection_id: "rci_" + randomBytes(16).toString("hex"),
    callers_file: "/run/antnest-auth/callers.json",
    receiver_digest: hash(raw),
  };
}

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
    "chmod 700 /run/antnest-auth; cp /fixture/auth/callers.json /fixture/auth/tunnel.json /run/antnest-auth/; chown 0:0 /run/antnest-auth /run/antnest-auth/callers.json /run/antnest-auth/tunnel.json; chmod 600 /run/antnest-auth/callers.json /run/antnest-auth/tunnel.json",
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
