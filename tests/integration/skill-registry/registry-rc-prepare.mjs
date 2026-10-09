import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, createPrivateKey } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { callerContext } from "../../e2e/service-authentication/registry/auth-fixture.mjs";

const registry = process.env.ANTNEST_TEST_REGISTRY_URL;
const controller = process.env.ANTNEST_TEST_RUNTIME_CONTROLLER_URL;
const credentialsFile = process.env.ANTNEST_TEST_CREDENTIALS_FILE;
const scope = process.env.ANTNEST_RUNTIME_CONTROLLER_SCOPE;
const runtimeImage = process.env.ANTNEST_TEST_RUNTIME_IMAGE;
const realRuntimeImage = process.env.ANTNEST_TEST_REAL_RUNTIME_IMAGE;
assert(
  registry && controller && credentialsFile && scope && runtimeImage,
  "isolated service addresses, credentials, scope and Runtime image are required",
);

const organizationID = "org_" + "1".repeat(32);
const actorID = "user_" + "1".repeat(32);
const credentials = JSON.parse(readFileSync(credentialsFile, "utf8"));
const contextSigner = {
  privateKey: createPrivateKey(credentials.caller_context_key),
};
// The test publishes as Admin Console for an organization admin and calls
// Runtime Controller as Agent Controller, the only caller it accepts.
const consoleHeaders = () => ({
  "Antnest-Service-Authorization": `Bearer ${credentials.admin_console}`,
  "Antnest-Caller-Context": callerContext(contextSigner, {
    org: organizationID,
    sub: actorID,
  }),
});
const controllerHeaders = {
  "Antnest-Service-Authorization": `Bearer ${credentials.agent_controller}`,
};
const agentID = "agent_skill_delivery_integration";
const requestID = "skill-integration-prepare";
const content =
  "---\nname: code-review\ndescription: Review code\n---\nCheck tests before editing.\n";
const evidence = fileURLToPath(
  new URL(
    "../../../artifacts/verification/skill-registry-rc-prepare.json",
    import.meta.url,
  ),
);

function docker(...args) {
  return execFileSync("docker", args, { encoding: "utf8" }).trim();
}

function zipSkill(manifest = content) {
  const program =
    "import io,sys,zipfile\nb=io.BytesIO()\nwith zipfile.ZipFile(b,'w',compression=zipfile.ZIP_DEFLATED) as z:z.writestr('SKILL.md',sys.argv[1])\nsys.stdout.buffer.write(b.getvalue())";
  return execFileSync("python3", ["-c", program, manifest]);
}

function digestSet(org, skills) {
  const chunks = [Buffer.from("antnest-skill-set-v1\0")];
  const u32 = (number) => {
    const value = Buffer.alloc(4);
    value.writeUInt32BE(number);
    return value;
  };
  const u64 = (number) => {
    const value = Buffer.alloc(8);
    value.writeBigUInt64BE(BigInt(number));
    return value;
  };
  const str = (value) => {
    const data = Buffer.from(value);
    return [u32(data.length), data];
  };
  chunks.push(u32(1), ...str(org), u32(skills.length));
  for (const skill of [...skills].sort((a, b) =>
    Buffer.compare(Buffer.from(a.skill_id), Buffer.from(b.skill_id)),
  )) {
    chunks.push(
      ...str(skill.skill_id),
      u64(skill.version),
      ...str(skill.name),
      ...str(skill.description),
      ...str(skill.artifact_digest),
      ...str(skill.content_digest),
      u64(skill.artifact_size),
      u64(skill.unpacked_size),
      u32(skill.package_rules_version),
    );
  }
  return (
    "sha256:" + createHash("sha256").update(Buffer.concat(chunks)).digest("hex")
  );
}

async function jsonCall(base, path, options = {}) {
  const headers =
    base === controller
      ? { ...controllerHeaders, ...options.headers }
      : options.headers;
  const response = await fetch(base + path, { ...options, headers });
  const payload = await response.json();
  return { response, payload };
}

const artifact = zipSkill();
for (const path of [
  "/internal/legacy-system-skills/inventory",
  "/internal/legacy-system-skills/backups",
  "/internal/legacy-system-skills/backups/retired",
  `/internal/runtimes/${agentID}/skill-sets/verify-active`,
]) {
  for (const method of ["GET", "POST", "HEAD", "DELETE"]) {
    const response = await fetch(controller + path, {
      method,
      headers: {
        ...controllerHeaders,
        "Content-Type": "application/json",
        "Idempotency-Key": "retired-release-route",
      },
    });
    assert.equal(response.status, 404, `${method} ${path} must be retired`);
    await response.arrayBuffer();
  }
}
const form = new FormData();
form.append(
  "metadata",
  JSON.stringify({
    request_id: "skill-integration-publish",
    organization_id: organizationID,
    actor_id: actorID,
  }),
);
form.append(
  "artifact",
  new Blob([artifact], { type: "application/zip" }),
  "code-review.zip",
);
const anonymous = await fetch(
  `${controller}/internal/runtimes/${agentID}/skill-sets/preparations/${requestID}?organization_id=${organizationID}`,
);
assert.equal(anonymous.status, 401);
assert.equal((await anonymous.json()).code, "service_unauthenticated");
const withoutContext = await jsonCall(registry, "/internal/skills", {
  method: "POST",
  headers: {
    "Antnest-Service-Authorization": `Bearer ${credentials.admin_console}`,
  },
  body: form,
});
assert.equal(withoutContext.response.status, 401);
assert.equal(withoutContext.payload.error.code, "caller_context_required");
const published = await jsonCall(registry, "/internal/skills", {
  method: "POST",
  headers: consoleHeaders(),
  body: form,
});
assert.equal(published.response.status, 201, JSON.stringify(published.payload));
const frozen = published.payload;
assert.equal(frozen.version, 1);
assert.equal(
  frozen.artifact_digest,
  "sha256:" + createHash("sha256").update(artifact).digest("hex"),
);

const expectedDigest = digestSet(organizationID, [frozen]);
const prepared = await jsonCall(
  controller,
  `/internal/runtimes/${agentID}/skill-sets/prepare`,
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": requestID,
    },
    body: JSON.stringify({
      organization_id: organizationID,
      owner_operation_id: "agent-build-integration",
      layout_version: 1,
      skill_set_digest: expectedDigest,
      system_skills: [frozen],
    }),
  },
);
assert.equal(prepared.response.status, 202, JSON.stringify(prepared.payload));
let receipt = prepared.payload;
const until = Date.now() + 45000;
while (receipt.state !== "ready" && Date.now() < until) {
  assert(
    !["rejected", "invalidated", "paused"].includes(receipt.state),
    JSON.stringify(receipt),
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  const current = await jsonCall(
    controller,
    `/internal/runtimes/${agentID}/skill-sets/preparations/${requestID}?organization_id=${organizationID}`,
  );
  assert.equal(current.response.status, 200, JSON.stringify(current.payload));
  receipt = current.payload;
}
assert.equal(receipt.state, "ready", JSON.stringify(receipt));
assert.equal(receipt.prepared_skill_set.skill_set_digest, expectedDigest);
assert.match(receipt.prepared_reference_id, /^psr_/);
const replay = await jsonCall(
  controller,
  `/internal/runtimes/${agentID}/skill-sets/prepare`,
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": requestID,
    },
    body: JSON.stringify({
      organization_id: organizationID,
      owner_operation_id: "agent-build-integration",
      layout_version: 1,
      skill_set_digest: expectedDigest,
      system_skills: [frozen],
    }),
  },
);
assert.equal(replay.response.status, 202, JSON.stringify(replay.payload));
assert.equal(
  replay.payload.prepared_reference_id,
  receipt.prepared_reference_id,
);

const volumes = docker(
  "volume",
  "ls",
  "-q",
  "--filter",
  `label=io.antnest.runtime-controller-scope=${scope}`,
  "--filter",
  "label=io.antnest.managed=skill-set",
)
  .split("\n")
  .filter(Boolean);
assert.equal(
  volumes.length,
  1,
  `expected one owned Skill volume, found ${volumes}`,
);
const volume = volumes[0];
const labels = JSON.parse(
  docker("volume", "inspect", "--format", "{{json .Labels}}", volume),
);
assert.equal(labels["io.antnest.skill-set-digest"], expectedDigest);
assert.equal(labels["io.antnest.skill-organization-id"], organizationID);
const manifest = docker(
  "run",
  "--rm",
  "--network",
  "none",
  "--mount",
  `type=volume,source=${volume},target=/skills,readonly`,
  "postgres:17.11-bookworm",
  "cat",
  "/skills/.antnest-skills.json",
);
const identity = JSON.parse(manifest);
assert.equal(identity.organization_id, organizationID);
assert.equal(identity.agent_id, agentID);
assert.equal(identity.skill_set_digest, expectedDigest);
const installed = docker(
  "run",
  "--rm",
  "--network",
  "none",
  "--mount",
  `type=volume,source=${volume},target=/skills,readonly`,
  "postgres:17.11-bookworm",
  "cat",
  "/skills/code-review/SKILL.md",
);
assert.equal(installed, content.trim());
const writeAttempt = spawnSync(
  "docker",
  [
    "run",
    "--rm",
    "--network",
    "none",
    "--mount",
    `type=volume,source=${volume},target=/skills,readonly`,
    "postgres:17.11-bookworm",
    "sh",
    "-c",
    "echo changed > /skills/code-review/SKILL.md",
  ],
  { encoding: "utf8" },
);
assert.notEqual(writeAttempt.status, 0, "read-only mount allowed a write");

const initializeBody = JSON.stringify({
  configuration: {
    image_ref: runtimeImage,
    network: {
      packet_contract_revision: 2,
      egress_endpoint: { ipv4: "10.20.0.8", port: 8092 },
      tunnel_ipv4: "100.64.0.2",
      resolver_ipv4: "100.64.0.1",
    },
    resources: {
      memory_bytes: 268435456,
      pids_limit: 128,
      tmpfs_bytes: 33554432,
    },
    organization_id: organizationID,
    system_skills: [frozen],
    prepared_skill_set: receipt.prepared_skill_set,
    prepared_reference_id: receipt.prepared_reference_id,
  },
});
let initialized = await jsonCall(
  controller,
  `/internal/runtimes/${agentID}/initialize`,
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": "skill-integration-initialize",
    },
    body: initializeBody,
  },
);
assert(
  [200, 202].includes(initialized.response.status),
  JSON.stringify(initialized.payload),
);
const initializeUntil = Date.now() + 30000;
while (
  initialized.payload.state !== "completed" &&
  Date.now() < initializeUntil
) {
  assert(
    ["running", "unknown"].includes(initialized.payload.state),
    JSON.stringify(initialized.payload),
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  initialized = await jsonCall(
    controller,
    `/internal/runtimes/${agentID}/initialize`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "skill-integration-initialize",
      },
      body: initializeBody,
    },
  );
  assert(
    [200, 202].includes(initialized.response.status),
    JSON.stringify(initialized.payload),
  );
}
assert.equal(
  initialized.payload.state,
  "completed",
  JSON.stringify(initialized.payload),
);
const runtimeContainer = `antnest-runtime-${agentID}`;
const mounts = JSON.parse(
  docker("inspect", "--format", "{{json .Mounts}}", runtimeContainer),
);
assert(
  mounts.some(
    (mount) =>
      mount.Type === "volume" &&
      mount.Name === volume &&
      mount.Destination === "/skills" &&
      mount.RW === false,
  ),
  "Runtime /skills mount differs",
);
assert.equal(
  docker("inspect", "--format", "{{.State.Running}}", runtimeContainer),
  "true",
);
const mounted = docker(
  "exec",
  runtimeContainer,
  "cat",
  "/skills/code-review/SKILL.md",
);
assert.equal(mounted, content.trim());
const protectedFiles = [
  "/skills/code-review/SKILL.md",
  "/skills/.antnest-skills.json",
];
const protectedState = () =>
  protectedFiles.map((path) => ({
    path,
    digest: docker("exec", runtimeContainer, "sha256sum", path).split(" ")[0],
    mode: docker("exec", runtimeContainer, "stat", "-c", "%a", path),
  }));
const originalProtectedState = protectedState();
const rejectedMutations = [
  ["write", "printf changed > /skills/code-review/SKILL.md"],
  ["delete", "rm /skills/code-review/SKILL.md"],
  ["rename", "mv /skills/code-review/SKILL.md /skills/code-review/renamed.md"],
  ["chmod", "chmod 0600 /skills/code-review/SKILL.md"],
  [
    "link creation",
    "ln -s /workspace/skill-write-target /skills/code-review/linked.md",
  ],
];
for (const user of ["0:0", "1000:1000"]) {
  for (const [operation, command] of rejectedMutations) {
    const attempt = spawnSync(
      "docker",
      ["exec", "--user", user, runtimeContainer, "sh", "-c", command],
      { encoding: "utf8" },
    );
    assert.notEqual(
      attempt.status,
      0,
      `${user} ${operation} changed the system Skill`,
    );
    assert.match(
      attempt.stderr,
      /Read-only file system|Permission denied|Operation not permitted/i,
      `${user} ${operation} failed for a reason other than filesystem protection`,
    );
    assert.deepEqual(
      protectedState(),
      originalProtectedState,
      `${user} ${operation} changed the system Skill or manifest`,
    );
  }
}
docker(
  "exec",
  runtimeContainer,
  "ln",
  "-s",
  "/skills/code-review/SKILL.md",
  "/workspace/skill-write-link",
);
try {
  const viaWorkspaceLink = spawnSync(
    "docker",
    [
      "exec",
      runtimeContainer,
      "sh",
      "-c",
      "printf changed > /workspace/skill-write-link",
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(
    viaWorkspaceLink.status,
    0,
    "workspace link modified the system Skill",
  );
  assert.match(
    viaWorkspaceLink.stderr,
    /Read-only file system|Permission denied|Operation not permitted/i,
  );
  assert.deepEqual(
    protectedState(),
    originalProtectedState,
    "workspace link changed the system Skill or manifest",
  );
} finally {
  docker("exec", runtimeContainer, "rm", "/workspace/skill-write-link");
}
assert.equal(
  docker("exec", runtimeContainer, "ls", "-A", "/skills/code-review"),
  "SKILL.md",
);

// A corrupt, unmounted target set must be rematerialized while this source
// Runtime and its current Skill volume remain available.
const targetDigest = digestSet(organizationID, []);
const targetRequestID = "skill-integration-drift-target";
const targetBody = JSON.stringify({
  organization_id: organizationID,
  owner_operation_id: "agent-rebuild-drift-target",
  layout_version: 1,
  skill_set_digest: targetDigest,
  system_skills: [],
});
const targetPrepare = () =>
  jsonCall(controller, `/internal/runtimes/${agentID}/skill-sets/prepare`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": targetRequestID,
    },
    body: targetBody,
  });
let target = await targetPrepare();
assert.equal(target.response.status, 202, JSON.stringify(target.payload));
const targetReadyUntil = Date.now() + 45000;
while (target.payload.state !== "ready" && Date.now() < targetReadyUntil) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  target = await targetPrepare();
  assert.equal(target.response.status, 202, JSON.stringify(target.payload));
}
assert.equal(target.payload.state, "ready", JSON.stringify(target.payload));
const targetVolumes = () =>
  docker(
    "volume",
    "ls",
    "-q",
    "--filter",
    `label=io.antnest.runtime-controller-scope=${scope}`,
    "--filter",
    `label=io.antnest.skill-set-digest=${targetDigest}`,
  )
    .split("\n")
    .filter(Boolean);
const [driftedVolume] = targetVolumes();
assert(
  driftedVolume && driftedVolume !== volume && targetVolumes().length === 1,
);
docker(
  "run",
  "--rm",
  "--network",
  "none",
  "--mount",
  `type=volume,source=${driftedVolume},target=/skills`,
  "postgres:17.11-bookworm",
  "sh",
  "-c",
  "printf corrupt > /skills/.antnest-skills.json",
);
target = await targetPrepare();
assert.equal(target.response.status, 202, JSON.stringify(target.payload));
assert.notEqual(
  target.payload.state,
  "ready",
  "drifted target passed full readback",
);
const targetRecoveredUntil = Date.now() + 60000;
while (target.payload.state !== "ready" && Date.now() < targetRecoveredUntil) {
  assert(
    !["rejected", "paused"].includes(target.payload.state),
    JSON.stringify(target.payload),
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  target = await targetPrepare();
  assert.equal(target.response.status, 202, JSON.stringify(target.payload));
}
assert.equal(target.payload.state, "ready", JSON.stringify(target.payload));
const [recoveredVolume] = targetVolumes();
assert(
  recoveredVolume &&
    recoveredVolume !== driftedVolume &&
    targetVolumes().length === 1,
  "drifted target was not replaced by one new volume",
);
assert.equal(
  docker("inspect", "--format", "{{.State.Running}}", runtimeContainer),
  "true",
);
assert.equal(
  docker("exec", runtimeContainer, "cat", "/skills/code-review/SKILL.md"),
  content.trim(),
);

let realRuntimeDiscovery = false;
if (realRuntimeImage) {
  const workspace = mounts.find(
    (mount) => mount.Type === "volume" && mount.Destination === "/workspace",
  )?.Name;
  assert(workspace, "RC candidate has no workspace volume");
  const runtimeReply = (command, input) => {
    const output = execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "-i",
        "--network",
        "none",
        "--mount",
        `type=volume,source=${volume},target=/skills,readonly`,
        "--mount",
        `type=volume,source=${workspace},target=/workspace`,
        "--entrypoint",
        "/usr/local/bin/antnest-runtime",
        realRuntimeImage,
        command,
      ],
      { input: JSON.stringify(input), encoding: "utf8" },
    );
    return JSON.parse(output.trim());
  };
  const runtimeCall = (command, input) => {
    const reply = runtimeReply(command, input);
    assert.equal(reply.status, "success", JSON.stringify(reply));
    return reply.result;
  };
  const information = runtimeCall("info", {});
  assert(
    information.skills.some(
      (skill) =>
        skill.source === "system" &&
        skill.name === "code-review" &&
        skill.description === "Review code" &&
        skill.path.root === "system_skills" &&
        skill.path.path === "code-review/SKILL.md",
    ),
    JSON.stringify(information),
  );
  assert(
    !JSON.stringify(information).includes("Check tests before editing."),
    "Runtime summary exposed the Skill body",
  );
  const read = runtimeCall("read", {
    path: { root: "system_skills", path: "code-review/SKILL.md" },
    offset: 0,
    limit: 16384,
  });
  assert.equal(read.content, content);
  const denied = runtimeReply("write", {
    path: { root: "system_skills", path: "code-review/SKILL.md" },
    content: "changed",
  });
  assert.equal(denied.status, "failure", JSON.stringify(denied));
  const editDenied = runtimeReply("edit", {
    path: { root: "system_skills", path: "code-review/SKILL.md" },
    old_string: "Check tests before editing.",
    new_string: "changed",
  });
  assert.equal(editDenied.status, "failure", JSON.stringify(editDenied));
  assert.equal(
    runtimeCall("read", {
      path: { root: "system_skills", path: "code-review/SKILL.md" },
      offset: 0,
      limit: 16384,
    }).content,
    content,
  );
  realRuntimeDiscovery = true;
}

let slowPreparation;
if (process.env.ANTNEST_TEST_SLOW_SKILL_PREPARATION === "true") {
  const proxyURL = process.env.ANTNEST_TEST_SLOW_PROXY_URL;
  assert(/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(proxyURL ?? ""));
  const slowAgent = "agent_skill_slow_preparation";
  const slowSkills = [];
  for (let index = 1; index <= 5; index++) {
    const slowArtifact = zipSkill(
      `---\nname: slow-skill-${index}\ndescription: Slow preparation ${index}\n---\nChecked package ${index}.\n`,
    );
    const slowForm = new FormData();
    slowForm.append(
      "metadata",
      JSON.stringify({
        request_id: `skill-slow-publish-${index}`,
        organization_id: organizationID,
        actor_id: actorID,
      }),
    );
    slowForm.append(
      "artifact",
      new Blob([slowArtifact], { type: "application/zip" }),
      `slow-skill-${index}.zip`,
    );
    const version = await jsonCall(registry, "/internal/skills", {
      method: "POST",
      headers: consoleHeaders(),
      body: slowForm,
    });
    assert.equal(version.response.status, 201, JSON.stringify(version.payload));
    slowSkills.push(version.payload);
  }
  const armed = await fetch(`${proxyURL}/__test/arm`, { method: "POST" });
  assert.equal(armed.status, 204);
  const slowDigest = digestSet(organizationID, slowSkills);
  const startedAt = Date.now();
  const slowRequestID = "skill-integration-slow-prepare";
  const slowBody = JSON.stringify({
    organization_id: organizationID,
    owner_operation_id: "agent-build-slow",
    layout_version: 1,
    skill_set_digest: slowDigest,
    system_skills: slowSkills,
  });
  const submitSlow = () =>
    jsonCall(controller, `/internal/runtimes/${slowAgent}/skill-sets/prepare`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": slowRequestID,
      },
      body: slowBody,
    });
  let slow = await submitSlow();
  assert.equal(slow.response.status, 202, JSON.stringify(slow.payload));
  const slowUntil = Date.now() + 240000;
  let sawCheckpoint = false;
  const restartMode =
    process.env.ANTNEST_TEST_RESTART_SKILL_PREPARATION === "true";
  let restarted = false;
  while (slow.payload.state !== "ready" && Date.now() < slowUntil) {
    assert(
      !["rejected", "invalidated", "paused"].includes(slow.payload.state),
      JSON.stringify(slow.payload),
    );
    if ((slow.payload.progress?.verified_packages ?? 0) > 0)
      sawCheckpoint = true;
    if (restartMode && sawCheckpoint && !restarted) {
      const requestFile = process.env.ANTNEST_TEST_RESTART_REQUEST_FILE;
      const doneFile = process.env.ANTNEST_TEST_RESTART_DONE_FILE;
      assert(requestFile && doneFile);
      const beforeRestart = slow.payload.progress.verified_packages;
      assert(
        beforeRestart < 5,
        "restart was requested after preparation completed",
      );
      await writeFile(requestFile, String(beforeRestart));
      const restartUntil = Date.now() + 90000;
      while (!existsSync(doneFile) && Date.now() < restartUntil)
        await new Promise((resolve) => setTimeout(resolve, 250));
      assert(
        existsSync(doneFile),
        "RC did not restart during Skill preparation",
      );
      restarted = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
    slow = await submitSlow();
    assert.equal(slow.response.status, 202, JSON.stringify(slow.payload));
  }
  assert.equal(slow.payload.state, "ready", JSON.stringify(slow.payload));
  if (restartMode)
    assert(restarted, "RC restart did not occur during preparation");
  const elapsed = Date.now() - startedAt;
  assert(
    elapsed >= 120000,
    `Skill preparation did not cross the 2-minute mutation budget: ${elapsed} ms`,
  );
  assert(
    sawCheckpoint,
    "multi-package preparation did not expose durable progress",
  );
  assert.equal(slow.payload.progress.verified_packages, 5);
  assert.equal(slow.payload.progress.total_packages, 5);
  const proxyState = await jsonCall(proxyURL, "/__test/status");
  if (restartMode) {
    assert.equal(
      proxyState.payload.requests[slowSkills[0].skill_id],
      1,
      "RC redownloaded the first checkpointed Skill after restart",
    );
    assert(proxyState.payload.delayed >= 5);
  } else {
    assert.equal(proxyState.payload.delayed, 5);
  }
  const slowVolumes = docker(
    "volume",
    "ls",
    "-q",
    "--filter",
    `label=io.antnest.runtime-controller-scope=${scope}`,
    "--filter",
    `label=io.antnest.agent-id=${slowAgent}`,
    "--filter",
    "label=io.antnest.managed=skill-set",
  )
    .split("\n")
    .filter(Boolean);
  assert.equal(slowVolumes.length, 1);
  const slowManifest = JSON.parse(
    docker(
      "run",
      "--rm",
      "--network",
      "none",
      "--mount",
      `type=volume,source=${slowVolumes[0]},target=/skills,readonly`,
      "postgres:17.11-bookworm",
      "cat",
      "/skills/.antnest-skills.json",
    ),
  );
  assert.equal(slowManifest.skill_set_digest, slowDigest);
  assert.equal(slowManifest.skills.length, 5);
  slowPreparation = {
    elapsed_ms: elapsed,
    downloaded_packages: proxyState.payload.delayed,
    verified_packages: slow.payload.progress.verified_packages,
    lifecycle_mutation_timeout_ms: 120000,
    ...(restartMode
      ? {
          rc_restarted_after_checkpoint: true,
          first_package_downloads:
            proxyState.payload.requests[slowSkills[0].skill_id],
        }
      : {}),
  };
}

const result = {
  scope: "Registry HTTP → RC Prepare/Initialize → Docker Runtime mount",
  skill_id: frozen.skill_id,
  version: frozen.version,
  skill_set_digest: expectedDigest,
  prepared_reference_id: receipt.prepared_reference_id,
  volume,
  exactSkill: true,
  idempotentReplay: true,
  readOnlyMount: true,
  runtimeMount: true,
  runtimeMutationsDenied: true,
  runtimeWriteEditDenied: realRuntimeDiscovery,
  activeSourceTargetDriftRecovered: true,
  realRuntimeDiscovery,
  ...(slowPreparation ? { slowPreparation } : {}),
};
await mkdir(
  fileURLToPath(new URL("../../../artifacts/verification/", import.meta.url)),
  { recursive: true },
);
await writeFile(evidence, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result));
