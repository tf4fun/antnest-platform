import assert from "node:assert/strict";
import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  validatePrivateOutput,
  writePrivateFile,
} from "../../../scripts/lib/private-output.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));

// Test-only opt-in. The RC reads this immutable member catalog before ACP
// starts; its Compose UID/GID already matches the private credential owner.
export function prepareOwnerProfile(config) {
  assert.match(config.project, /^antnest-lifecycle-[a-f0-9]{8}$/u);
  assert.match(
    config.env.ANTNEST_SERVICE_NETWORK_PREFIX,
    /^10\.244\.(?:[1-9]\d?|1\d\d|200)$/u,
  );
  assert.equal(config.env.ANTNEST_SERVICE_AUTH_UID, String(process.getuid()));
  assert.equal(config.env.ANTNEST_SERVICE_AUTH_GID, String(process.getgid()));
  assert.equal(
    config.credentials,
    resolve(
      root,
      "artifacts/verification/authenticated-e2e",
      config.project,
      "credentials",
    ),
  );
  const directory = lstatSync(config.credentials);
  assert(directory.isDirectory() && !directory.isSymbolicLink());
  assert.equal(directory.mode & 0o777, 0o700);
  assert.equal(directory.uid, process.getuid());
  const path = validatePrivateOutput(
    resolve(config.credentials, "acp-members.json"),
  );
  writePrivateFile(
    path,
    JSON.stringify({
      version: 1,
      members: [
        {
          member_id: "acp-a",
          container_selector: `${config.project}-agent-acp-service-1`,
          network: `${config.project}_controller-runtime`,
          probe_origin: "http://agent-acp-service:8085",
        },
      ],
    }) + "\n",
  );
  config.env.ANTNEST_E2E_ACP_MEMBERS_FILE = path;
  config.ownerProfiles = ["acp-owner-bootstrap"];
}
