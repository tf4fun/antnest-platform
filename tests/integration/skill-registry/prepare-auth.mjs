// Writes the service-authentication material for the host-process Skill
// Registry and Runtime Controller started by run-registry-rc-prepare.sh, and
// the token the Egress registration double admits.
// Each service gets its own directory: a receiver must not list itself as a
// caller, so the Registry callers file cannot be shared with Runtime Controller.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createFixture } from "../../e2e/service-authentication/registry/auth-fixture.mjs";

const hash = (token) =>
  "sha256:" + createHash("sha256").update(token, "ascii").digest("hex");

export function prepareAuthentication(directory) {
  const registry = resolve(directory, "registry");
  const controller = resolve(directory, "controller");
  const egress = resolve(directory, "egress");
  mkdirSync(registry, { recursive: true, mode: 0o700 });
  mkdirSync(egress, { recursive: true, mode: 0o700 });
  mkdirSync(resolve(controller, "outgoing"), { recursive: true, mode: 0o700 });
  const fixture = createFixture(registry);
  const agentController = randomBytes(32).toString("base64url");
  writeFileSync(
    resolve(controller, "callers.json"),
    JSON.stringify({ "agent-controller": [hash(agentController)] }),
    { mode: 0o600 },
  );
  writeFileSync(
    resolve(controller, "outgoing", "skill-registry"),
    fixture.incoming["runtime-controller"],
    { mode: 0o600 },
  );
  const egressToken = randomBytes(32).toString("base64url");
  for (const file of [
    resolve(controller, "outgoing", "runtime-egress"),
    resolve(egress, "runtime-egress"),
  ])
    writeFileSync(file, egressToken, { mode: 0o600 });
  // Instance records are encrypted with this key, so a restarted controller
  // must read the same file.
  writeFileSync(resolve(controller, "instance-master"), randomBytes(32), {
    mode: 0o600,
  });
  const credentials = resolve(directory, "test-credentials.json");
  writeFileSync(
    credentials,
    JSON.stringify({
      admin_console: fixture.incoming["admin-console"],
      agent_controller: agentController,
      caller_context_key: fixture.privateKey
        .export({ format: "pem", type: "pkcs8" })
        .toString(),
    }),
    { mode: 0o600 },
  );
  return { registry, controller, egress, credentials };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [directory] = process.argv.slice(2);
  if (!directory) throw new Error("usage: prepare-auth.mjs <directory>");
  prepareAuthentication(directory);
}
