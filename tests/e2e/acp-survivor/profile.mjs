import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPrivateDirectory,
  validatePrivateOutput,
  writePrivateFile,
} from "../../../scripts/lib/private-output.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));

// Disposable test-only catalogs. Ordinary workload grants remain untouched.
export function prepareSurvivorProfile(config) {
  assert.match(config.project, /^antnest-lifecycle-[a-f0-9]{8}$/u);
  const prefix = config.env.ANTNEST_SERVICE_NETWORK_PREFIX;
  assert.match(prefix, /^10\.244\.(?:[1-9]\d?|1\d\d|200)$/u);
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
  const credentials = lstatSync(config.credentials);
  assert(credentials.isDirectory() && !credentials.isSymbolicLink());
  assert.equal(credentials.mode & 0o777, 0o700);
  assert.equal(credentials.uid, process.getuid());

  // Validate the whole fresh output tree before creating any file or directory.
  // Existing output and symlink ancestry reject without publishing new env.
  const membersFile = validatePrivateOutput(
    resolve(config.credentials, "acp-members.json"),
  );
  const a = validatePrivateOutput(resolve(config.credentials, "peer-a"));
  const b = validatePrivateOutput(resolve(config.credentials, "peer-b"));
  const aTokens = validatePrivateOutput(resolve(a, "tokens"));
  const bTokens = validatePrivateOutput(resolve(b, "tokens"));
  const aMembership = validatePrivateOutput(resolve(a, "membership.json"));
  const bMembership = validatePrivateOutput(resolve(b, "membership.json"));
  const aCallers = validatePrivateOutput(resolve(a, "callers.json"));
  const bCallers = validatePrivateOutput(resolve(b, "callers.json"));
  const aOutgoing = validatePrivateOutput(resolve(aTokens, "acp-b"));
  const bOutgoing = validatePrivateOutput(resolve(bTokens, "acp-a"));

  const membership =
    JSON.stringify({
      version: 1,
      cluster_id: randomUUID(),
      members: [
        { member_id: "acp-a", origin: `http://${prefix}.53:8083` },
        { member_id: "acp-b", origin: `http://${prefix}.54:8083` },
      ],
    }) + "\n";
  const aToB = randomBytes(32).toString("base64url");
  const bToA = randomBytes(32).toString("base64url");
  const digest = (token) =>
    `sha256:${createHash("sha256").update(token, "ascii").digest("hex")}`;
  const members =
    JSON.stringify({
      version: 1,
      members: [
        {
          member_id: "acp-a",
          container_selector: `${config.project}-agent-acp-service-1`,
          network: `${config.project}_controller-runtime`,
          probe_origin: "http://agent-acp-service:8085",
        },
        {
          member_id: "acp-b",
          container_selector: `${config.project}-agent-acp-peer-b-1`,
          network: `${config.project}_controller-runtime`,
          probe_origin: "http://agent-acp-peer-b:8085",
        },
      ],
    }) + "\n";
  const files = [
    [membersFile, members],
    [aMembership, membership],
    [bMembership, membership],
    [aCallers, JSON.stringify({ "acp-b": [digest(bToA)] }) + "\n"],
    [bCallers, JSON.stringify({ "acp-a": [digest(aToB)] }) + "\n"],
    [aOutgoing, aToB],
    [bOutgoing, bToA],
  ];
  for (const directory of [a, b, aTokens, bTokens])
    createPrivateDirectory(directory);
  for (const [path, contents] of files) writePrivateFile(path, contents);

  // All private inputs now exist. Keep service and Runtime-management subnets distinct.
  Object.assign(config.env, {
    ANTNEST_E2E_ACP_MEMBERS_FILE: membersFile,
    ANTNEST_E2E_ACP_PEER_A_DIRECTORY: a,
    ANTNEST_E2E_ACP_PEER_B_DIRECTORY: b,
    ANTNEST_E2E_ACP_PEER_B_MANAGEMENT_IPV4: `10.243.${prefix.split(".")[2]}.7`,
  });
}
