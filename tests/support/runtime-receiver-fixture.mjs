import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
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

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv.length !== 3)
    throw new Error("private receiver output required");
  console.log(JSON.stringify(createRuntimeReceiver(process.argv[2])));
}
