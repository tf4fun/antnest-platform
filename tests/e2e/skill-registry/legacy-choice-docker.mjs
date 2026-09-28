import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  verify,
} from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { createAccessCatalog } from "../identity-closeout/catalog.mjs";
import { publishSkill } from "./stage3-fixture.mjs";
import { connectOwner } from "../lifecycle-closeout/acp.mjs";
import { waitForAgentReady } from "../../support/verification/agent-state.mjs";
import {
  configuration,
  dockerClient,
  cleanup,
  lines,
} from "../lifecycle-closeout/docker.mjs";
import { configureFoundation } from "../lifecycle-closeout/foundation-setup.mjs";
import { temporaryStorageRoot } from "../../support/storage.mjs";
import { collectTrace } from "../managed-mcp/trace.mjs";
import {
  inspectLegacyProofLossCrashDiagnostic,
  inspectLegacyProofLossRecoveryTrace,
} from "./legacy-proof-loss-trace.mjs";
import { inspectLegacySourceRecoveryTrace } from "./legacy-source-recovery-trace.mjs";

const abort = new AbortController();
const interrupt = () =>
  abort.abort(new Error("Legacy Skill choice acceptance interrupted"));
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const timer = setTimeout(interrupt, 900000);

let internalDocker, internalContainer;
async function control(
  origin,
  path,
  { method = "GET", body, idempotencyKey, status = 200 } = {},
) {
  abort.signal.throwIfAborted();
  const script = `const [origin,path,options]=process.argv.slice(1); const input=JSON.parse(options); fetch(origin+path,{method:input.method,headers:{...(input.body?{"Content-Type":"application/json"}:{}),...(input.idempotencyKey?{"Idempotency-Key":input.idempotencyKey}:{})},body:input.body?JSON.stringify(input.body):undefined,signal:AbortSignal.timeout(30000)}).then(async response=>{const raw=await response.text();console.log(JSON.stringify({status:response.status,body:raw?JSON.parse(raw):null}))}).catch(error=>{console.error(error.message);process.exitCode=1})`;
  const result = JSON.parse(
    await internalDocker([
      "exec",
      internalContainer,
      "node",
      "-e",
      script,
      origin,
      path,
      JSON.stringify({ method, body, idempotencyKey }),
    ]),
  );
  assert(
    (Array.isArray(status) ? status : [status]).includes(result.status),
    `${method} ${path} status ${result.status}: ${JSON.stringify(result.body)}`,
  );
  return result.body;
}

async function waitOperation(admin, requestID) {
  let last;
  for (let attempt = 0; attempt < 180; attempt++) {
    abort.signal.throwIfAborted();
    const result = (await admin.request(`/api/admin/operations/${requestID}`))
      .body;
    last = result;
    if (result.state === "completed") return result;
    assert.equal(
      result.state,
      "running",
      `lifecycle failed at ${result.phase}: ${result.error_code ?? "unknown"}`,
    );
    await delay(500, undefined, { signal: abort.signal });
  }
  throw new Error(`Agent lifecycle did not complete: ${JSON.stringify(last)}`);
}

async function admitPreparedLifecycle(admin, agentID, kind, body) {
  assert(["enable", "rebuild"].includes(kind));
  const key = randomUUID();
  let sawPreparation = false;
  for (let attempt = 0; attempt < 180; attempt++) {
    abort.signal.throwIfAborted();
    const response = await fetch(
      `${admin.base}/api/admin/agents/${agentID}/${kind}`,
      {
        method: "POST",
        signal: AbortSignal.timeout(15000),
        headers: {
          "content-type": "application/json",
          Cookie: admin.cookie,
          Origin: admin.base,
          "X-Antnest-CSRF-Token": admin.cookies.get("antnest_csrf") ?? "",
          "Idempotency-Key": key,
        },
        body: JSON.stringify(body),
      },
    );
    const result = await response.json();
    if (response.status === 202) return { result, sawPreparation };
    assert.equal(
      response.status,
      503,
      `prepared ${kind} status ${response.status}: ${JSON.stringify(result)}`,
    );
    assert.equal(
      result.retryable,
      true,
      `prepared ${kind} was not retryable: ${JSON.stringify(result)}`,
    );
    sawPreparation = true;
    await delay(500, undefined, { signal: abort.signal });
  }
  throw new Error(`prepared ${kind} never reached admission`);
}

async function waitFailedOperation(admin, requestID, code) {
  let last;
  for (let attempt = 0; attempt < 180; attempt++) {
    abort.signal.throwIfAborted();
    last = (await admin.request(`/api/admin/operations/${requestID}`)).body;
    if (last.state === "failed") {
      assert.equal(last.error_code, code);
      return last;
    }
    assert.equal(
      last.state,
      "running",
      `unexpected migration state: ${JSON.stringify(last)}`,
    );
    await delay(500, undefined, { signal: abort.signal });
  }
  throw new Error(
    `Migration did not fail after proof revocation: ${JSON.stringify(last)}`,
  );
}

let config, exportDirectory, verifierDirectory;
try {
  config = await configuration(abort.signal);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicBytes = Buffer.from(
    publicKey.export({ format: "jwk" }).x,
    "base64url",
  );
  const { publicKey: nextPublicKey, privateKey: nextPrivateKey } =
    generateKeyPairSync("ed25519");
  const nextPublicBytes = Buffer.from(
    nextPublicKey.export({ format: "jwk" }).x,
    "base64url",
  );
  config.env.ANTNEST_AGENT_CONTROLLER_LEGACY_EXPORT_VERIFIER_KEYS =
    JSON.stringify({
      current: {
        key_id: "stage4-test-key",
        public_key: publicBytes.toString("base64"),
      },
      next: {
        key_id: "stage4-next-key",
        public_key: nextPublicBytes.toString("base64"),
      },
    });
  configureFoundation(config);
  if (process.env.ANTNEST_E2E_LEGACY_MIGRATION === "true") {
    const compose = config.compose;
    config.compose = (args) => {
      const command = compose(args);
      const position = command.indexOf("--profile");
      assert(position > 0);
      return [
        ...command.slice(0, position),
        "-f",
        "tests/e2e/skill-registry/legacy-migration.compose.yaml",
        ...command.slice(position),
      ];
    };
  }
  if (process.env.ANTNEST_E2E_SOURCE_RECOVERY === "true") {
    const compose = config.compose;
    config.compose = (args) => {
      const command = compose(args);
      const position = command.indexOf("--profile");
      assert(position > 0);
      return [
        ...command.slice(0, position),
        "-f",
        "tests/e2e/skill-registry/source-recovery-fault.compose.yaml",
        ...command.slice(position),
      ];
    };
  }
  const docker = dockerClient(config.env, abort.signal);
  await docker(
    config.compose([
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      "180",
      "--no-build",
      "--pull",
      "never",
    ]),
    true,
  );
  internalDocker = docker;
  internalContainer = lines(
    await docker(config.compose(["ps", "-q", "stage3-model"])),
  )[0];
  assert(internalContainer);

  const legacyVolume = config.env.ANTNEST_RUNTIME_SYSTEM_SKILLS_VOLUME;
  await docker(
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--mount",
      `type=volume,source=${legacyVolume},target=/data`,
      "node:24.21.0-bookworm-slim",
      "sh",
      "-c",
      "printf '%s' 'Legacy shared Skill awaiting migration' > /data/legacy-note.txt",
    ],
    true,
  );
  const rc = "http://runtime-controller:8080";
  const controller = "http://agent-controller:8080";
  const inventory = await control(
    rc,
    "/internal/legacy-system-skills/inventory",
  );
  assert.equal(inventory.volume_name, legacyVolume);
  assert.equal(inventory.entries.length, 1);
  const backup = await control(rc, "/internal/legacy-system-skills/backups", {
    method: "POST",
    status: 201,
    idempotencyKey: "legacy-choice-e2e-backup",
    body: { expected_inventory_digest: inventory.inventory_digest },
  });
  assert.equal(backup.volume_name, legacyVolume);
  assert.equal(backup.inventory_digest, inventory.inventory_digest);
  exportDirectory = await mkdtemp(
    join(temporaryStorageRoot(), "antnest-legacy-export-"),
  );
  await chmod(exportDirectory, 0o700);
  const exportArgs = [
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--mount",
    `type=volume,source=${config.env.ANTNEST_RUNTIME_LEGACY_BACKUP_VOLUME},target=/backup,readonly`,
    "--mount",
    `type=bind,source=${exportDirectory},target=/export`,
    "--entrypoint",
    "/usr/local/bin/legacy-backup-export",
    "antnest/runtime-controller:local",
    "--source=/backup",
    "--destination=/export",
    `--backup-ref=${backup.backup_ref}`,
    `--volume-name=${legacyVolume}`,
    `--manifest-digest=${backup.manifest_digest}`,
  ];
  const exported = JSON.parse(await docker(exportArgs, true));
  assert.equal(exported.status, "copy_verified");
  assert.equal(exported.manifest_digest, backup.manifest_digest);
  assert.equal(exported.archive_digest, backup.archive_digest);
  const archive = join(exportDirectory, backup.backup_ref, "archive.tar");
  const manifest = join(exportDirectory, backup.backup_ref, "manifest.json");
  const hash = (data) =>
    "sha256:" + createHash("sha256").update(data).digest("hex");
  assert.equal(hash(await readFile(archive)), backup.archive_digest);
  assert.equal(hash(await readFile(manifest)), backup.manifest_digest);
  assert.equal((await lstat(archive)).mode & 0o777, 0o600);
  assert.equal(
    (await lstat(join(exportDirectory, backup.backup_ref))).mode & 0o777,
    0o700,
  );
  assert.deepEqual(JSON.parse(await docker(exportArgs, true)), exported);

  verifierDirectory = await mkdtemp(
    join(temporaryStorageRoot(), "antnest-legacy-verifier-"),
  );
  await chmod(verifierDirectory, 0o700);
  const keyPath = join(verifierDirectory, "key.pem");
  await writeFile(
    keyPath,
    privateKey.export({ type: "pkcs8", format: "pem" }),
    { mode: 0o600 },
  );
  const attestArgs = [
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--mount",
    `type=bind,source=${exportDirectory},target=/export,readonly`,
    "--mount",
    `type=bind,source=${keyPath},target=/run/verifier-key.pem,readonly`,
    "--entrypoint",
    "/usr/local/bin/legacy-backup-attest",
    "antnest/runtime-controller:local",
    "--destination=/export",
    `--backup-ref=${backup.backup_ref}`,
    `--volume-name=${legacyVolume}`,
    `--manifest-digest=${backup.manifest_digest}`,
    "--storage-ref=s3://stage4-backups.example/legacy/fixture",
    "--verifier-id=stage4-verifier",
    "--key-id=stage4-test-key",
    "--key-file=/run/verifier-key.pem",
  ];
  const attestation = JSON.parse(await docker(attestArgs, true));
  assert.equal(attestation.version, 1);
  assert.equal(attestation.manifest_digest, backup.manifest_digest);
  assert.equal(attestation.archive_digest, backup.archive_digest);
  assert.equal(attestation.inventory_digest, inventory.inventory_digest);
  const message = [
    "antnest/legacy-skill-export/v1",
    attestation.key_id,
    attestation.verifier_id,
    attestation.storage_ref,
    attestation.backup_ref,
    attestation.volume_name,
    attestation.inventory_digest,
    attestation.archive_digest,
    attestation.manifest_digest,
    attestation.verified_at,
    attestation.expires_at,
    "",
  ].join("\n");
  assert(
    verify(
      null,
      Buffer.from(message),
      publicKey,
      Buffer.from(attestation.signature, "base64"),
    ),
  );
  await assert.rejects(
    docker(
      attestArgs.map((arg) =>
        arg.startsWith("--manifest-digest=")
          ? `--manifest-digest=sha256:${"0".repeat(64)}`
          : arg,
      ),
      true,
    ),
  );

  const admin = new GatewayClient(config.gateway);
  const login = (
    await admin.request("/api/session/login", {
      body: {
        organization_slug: "stage3",
        email: "stage3-admin@example.com",
        password: "stage3-admin-password",
      },
    })
  ).body;
  const owner = (
    await admin.request("/api/admin/directory/users", {
      body: {
        email: "legacy-owner@example.com",
        display_name: "Legacy owner",
        password: "legacy-owner-password",
        role: "member",
      },
    })
  ).body;
  const { template, model } = await createAccessCatalog(admin, {
    name: "Legacy choice fixture",
    baseURL: "http://stage3-model:8080/v1",
    modelName: "stage3-model",
    credential: "stage3-model-secret",
    systemPrompt: "Legacy choice fixture",
    maxModelRequests: 8,
    runtimeImage: config.image,
  });
  const created = (
    await admin.request("/api/admin/agents", {
      status: 202,
      body: {
        owner_user_id: owner.user.id,
        name: "Legacy choice Agent",
        template_id: template.template_id,
        template_revision: template.revision,
      },
    })
  ).body;
  const agentID = created.agent.agent_id;
  await waitOperation(admin, created.operation.request_id);
  assert.match(agentID, /^agent_[0-9a-f]{32}$/);
  const runtimeContainer = `antnest-runtime-${agentID}`;
  const runtimeInspect = JSON.parse(
    await docker(["inspect", runtimeContainer], true),
  )[0];
  const skillMount = runtimeInspect.Mounts.find(
    (mount) => mount.Destination === "/skills",
  );
  assert(
    skillMount,
    "empty template Skill collection must still mount a prepared volume",
  );
  assert.notEqual(
    skillMount.Name,
    legacyVolume,
    "new Agent must not inherit the legacy shared Skill volume",
  );
  const skillVolume = JSON.parse(
    await docker(["volume", "inspect", skillMount.Name], true),
  )[0];
  assert.equal(skillVolume.Labels["io.antnest.managed"], "skill-set");
  assert.equal(skillVolume.Labels["io.antnest.agent-id"], agentID);
  assert.match(login.principal.organization_id, /^org_[0-9a-f]{32}$/);
  const postgres = lines(
    await docker(config.compose(["ps", "-q", "postgres"])),
  )[0];
  assert(postgres);
  const emptySetDigest = await docker(
    [
      "exec",
      postgres,
      "psql",
      "-XAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "antnest_test_admin",
      "-d",
      "antnest_agent_controller",
      "-c",
      `SELECT target_spec->>'skill_set_digest' FROM agent_controller.agent_skill_preparation_intents WHERE request_id='${created.operation.request_id}'`,
    ],
    true,
  );
  assert.match(emptySetDigest, /^sha256:[0-9a-f]{64}$/);
  const runtime = await control(rc, `/internal/runtimes/${agentID}`);
  assert.match(runtime.runtime_revision, /^rtv_[0-9a-f]{32}$/);
  const verifyOwner = "legacy-choice-e2e-active-verification";
  const prepareID = randomUUID();
  const preparationBody = {
    organization_id: login.principal.organization_id,
    owner_operation_id: verifyOwner,
    layout_version: 1,
    skill_set_digest: emptySetDigest,
    system_skills: [],
  };
  let preparation = await control(
    rc,
    `/internal/runtimes/${agentID}/skill-sets/prepare`,
    {
      method: "POST",
      status: 202,
      idempotencyKey: prepareID,
      body: preparationBody,
    },
  );
  for (
    let attempt = 0;
    preparation.state !== "ready" && attempt < 80;
    attempt++
  ) {
    assert(
      ["queued", "preparing", "retry_wait"].includes(preparation.state),
      `Skill preparation: ${JSON.stringify(preparation)}`,
    );
    await delay(500, undefined, { signal: abort.signal });
    preparation = await control(
      rc,
      `/internal/runtimes/${agentID}/skill-sets/preparations/${prepareID}?organization_id=${login.principal.organization_id}`,
    );
  }
  assert.equal(
    preparation.state,
    "ready",
    "active verification reference was not prepared",
  );
  const verifyPath = `/internal/runtimes/${agentID}/skill-sets/verify-active`;
  const verificationBody = {
    organization_id: login.principal.organization_id,
    expected_runtime_revision: runtime.runtime_revision,
    prepared_reference_id: preparation.prepared_reference_id,
    prepared_skill_set: preparation.prepared_skill_set,
    system_skills: [],
  };
  const active = await control(rc, verifyPath, {
    method: "POST",
    status: 200,
    idempotencyKey: randomUUID(),
    body: verificationBody,
  });
  assert.equal(active.runtime_revision, runtime.runtime_revision);
  assert.equal(active.skill_set_digest, emptySetDigest);
  assert.match(active.manifest_digest, /^sha256:[0-9a-f]{64}$/);
  const stale = await control(rc, verifyPath, {
    method: "POST",
    status: 409,
    idempotencyKey: randomUUID(),
    body: {
      ...verificationBody,
      expected_runtime_revision: `rtv_${"f".repeat(32)}`,
    },
  });
  assert.equal(stale.code, "runtime_revision_conflict");
  await control(
    rc,
    `/internal/runtimes/${agentID}/skill-sets/preparations/${prepareID}/release`,
    {
      method: "POST",
      status: 204,
      idempotencyKey: randomUUID(),
      body: {
        organization_id: login.principal.organization_id,
        owner_operation_id: verifyOwner,
      },
    },
  );
  const released = await control(rc, verifyPath, {
    method: "POST",
    status: 409,
    idempotencyKey: randomUUID(),
    body: verificationBody,
  });
  assert.equal(released.code, "prepared_skill_set_invalidated");
  const activeVerifier = await docker(
    [
      "exec",
      postgres,
      "psql",
      "-XAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "antnest_test_admin",
      "-d",
      "antnest_agent_controller",
      "-c",
      "SELECT revoked_at IS NULL FROM agent_controller.legacy_export_verifier_keys WHERE key_id='stage4-test-key'",
    ],
    true,
  );
  assert.equal(
    activeVerifier,
    "t",
    "Controller must register the configured verifier key",
  );
  const sql = `INSERT INTO agent_controller.legacy_system_skills_migrations(agent_id,organization_id,state) VALUES ('${agentID}','${login.principal.organization_id}','pending')`;
  await docker([
    "exec",
    postgres,
    "psql",
    "-XAt",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "antnest_test_admin",
    "-d",
    "antnest_agent_controller",
    "-c",
    sql,
  ]);

  const choicePath = `/internal/agents/${agentID}/legacy-system-skills-migration/choices`;
  const body = {
    organization_id: login.principal.organization_id,
    actor_principal_id: login.principal.user_id,
    kind: "empty",
    volume_name: legacyVolume,
    inventory_digest: inventory.inventory_digest,
    backup_ref: backup.backup_ref,
    backup_digest: backup.manifest_digest,
  };
  const invalid = await control(controller, choicePath, {
    method: "POST",
    status: 409,
    idempotencyKey: randomUUID(),
    body: { ...body, backup_digest: "sha256:" + "0".repeat(64) },
  });
  assert.equal(invalid.code, "legacy_backup_mismatch");
  const missing = await control(controller, choicePath, {
    method: "POST",
    status: 409,
    idempotencyKey: randomUUID(),
    body: { ...body, backup_ref: "missing-legacy-backup" },
  });
  assert.equal(missing.code, "legacy_backup_mismatch");
  const requestID = randomUUID();
  const accepted = await control(controller, choicePath, {
    method: "POST",
    status: 201,
    idempotencyKey: requestID,
    body,
  });
  assert.equal(accepted.sequence, 1, "rejected choices must not be recorded");
  const replayed = await control(controller, choicePath, {
    method: "POST",
    status: 201,
    idempotencyKey: requestID,
    body,
  });
  assert.deepEqual(replayed, accepted);
  const review = await control(
    controller,
    `/internal/agents/${agentID}/legacy-system-skills-migration?organization_id=${login.principal.organization_id}`,
  );
  assert.equal(review.migration.state, "pending");
  assert.equal(review.migration.latest_choice.request_id, requestID);
  assert.equal(review.inventory.inventory_digest, inventory.inventory_digest);

  const disabled = (
    await admin.request(`/api/admin/agents/${agentID}/disable`, {
      status: 202,
      headers: { "Idempotency-Key": randomUUID() },
      body: {},
    })
  ).body;
  await waitOperation(admin, (disabled.operation ?? disabled).request_id);
  const blocked = (
    await admin.request(`/api/admin/agents/${agentID}/enable`, {
      status: 409,
      headers: { "Idempotency-Key": randomUUID() },
      body: {},
    })
  ).body;
  assert.equal(blocked.code, "legacy_system_skills_migration_required");

  if (process.env.ANTNEST_E2E_LEGACY_MIGRATION === "true") {
    const operationPath = `/internal/agents/${agentID}/legacy-system-skills-migration/operations`;
    const migrationBody = {
      organization_id: login.principal.organization_id,
      actor_principal_id: login.principal.user_id,
      choice_sequence: accepted.sequence,
      attestation,
    };
    const invalidProof = await control(controller, operationPath, {
      method: "POST",
      status: 409,
      idempotencyKey: randomUUID(),
      body: {
        ...migrationBody,
        attestation: {
          ...attestation,
          archive_digest: `sha256:${"0".repeat(64)}`,
        },
      },
    });
    assert.equal(invalidProof.code, "legacy_attestation_invalid");
    const staleChoice = await control(controller, operationPath, {
      method: "POST",
      status: 409,
      idempotencyKey: randomUUID(),
      body: { ...migrationBody, choice_sequence: accepted.sequence + 1 },
    });
    assert.equal(staleChoice.code, "lifecycle_conflict");
    const migrationID = randomUUID();
    const migration = await control(controller, operationPath, {
      method: "POST",
      status: 202,
      idempotencyKey: migrationID,
      body: migrationBody,
    });
    assert.equal(migration.request_id, migrationID);
    assert.equal(
      migration.kind,
      "enable",
      "disabled Agent must use controlled Enable",
    );
    await waitOperation(admin, migrationID);
    const resolved = await control(
      controller,
      `/internal/agents/${agentID}/legacy-system-skills-migration?organization_id=${login.principal.organization_id}`,
    );
    assert.equal(resolved.migration.state, "resolved");
    const migratedContainer = JSON.parse(
      await docker(["inspect", runtimeContainer], true),
    )[0];
    const migratedMount = migratedContainer.Mounts.find(
      (mount) => mount.Destination === "/skills",
    );
    assert(
      migratedMount && migratedMount.Name !== legacyVolume,
      "migrated Runtime must use managed Skill volume",
    );
    assert.equal(
      migratedMount.RW,
      false,
      "system Skills must remain read-only in Runtime",
    );
    const migratedVolume = JSON.parse(
      await docker(["volume", "inspect", migratedMount.Name], true),
    )[0];
    assert.equal(migratedVolume.Labels["io.antnest.agent-id"], agentID);
    const agent = (await admin.request(`/api/admin/agents/${agentID}`)).body;
    assert.equal(agent.activation_state, "enabled");

    const publishedSkill = await publishSkill(admin, 1);
    const skillTemplate = (
      await admin.request("/api/admin/templates", {
        status: 201,
        body: {
          name: "Legacy migration fixed Skill template",
          model_profile_id: model.model_profile_id,
          system_prompt: "Legacy migration fixed Skill template",
          max_model_requests: 8,
          runtime: { image_ref: config.image },
          skill_refs: [
            {
              skill_id: publishedSkill.skill_id,
              version: publishedSkill.version,
            },
          ],
        },
      })
    ).body;
    assert.equal(
      skillTemplate.skill_refs[0].artifact_digest,
      publishedSkill.artifact_digest,
    );
    const enabledCreated = (
      await admin.request("/api/admin/agents", {
        status: 202,
        body: {
          owner_user_id: owner.user.id,
          name: "Legacy enabled migration Agent",
          template_id: template.template_id,
          template_revision: template.revision,
        },
      })
    ).body;
    const enabledAgentID = enabledCreated.agent.agent_id;
    await waitOperation(admin, enabledCreated.operation.request_id);
    await docker([
      "exec",
      postgres,
      "psql",
      "-XAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "antnest_test_admin",
      "-d",
      "antnest_agent_controller",
      "-c",
      `INSERT INTO agent_controller.legacy_system_skills_migrations(agent_id,organization_id,state) VALUES ('${enabledAgentID}','${login.principal.organization_id}','pending')`,
    ]);
    const enabledChoice = await control(
      controller,
      `/internal/agents/${enabledAgentID}/legacy-system-skills-migration/choices`,
      {
        method: "POST",
        status: 201,
        idempotencyKey: randomUUID(),
        body: {
          ...body,
          kind: "template_revision",
          template_id: skillTemplate.template_id,
          template_revision: skillTemplate.revision,
        },
      },
    );
    const enabledMigrationID = randomUUID();
    const enabledMigration = await control(
      controller,
      `/internal/agents/${enabledAgentID}/legacy-system-skills-migration/operations`,
      {
        method: "POST",
        status: 202,
        idempotencyKey: enabledMigrationID,
        body: { ...migrationBody, choice_sequence: enabledChoice.sequence },
      },
    );
    assert.equal(
      enabledMigration.kind,
      "rebuild",
      "enabled Agent must use source-preserving Rebuild",
    );
    await waitOperation(admin, enabledMigrationID);
    const enabledReview = await control(
      controller,
      `/internal/agents/${enabledAgentID}/legacy-system-skills-migration?organization_id=${login.principal.organization_id}`,
    );
    assert.equal(enabledReview.migration.state, "resolved");
    const enabledContainer = JSON.parse(
      await docker(["inspect", `antnest-runtime-${enabledAgentID}`], true),
    )[0];
    const enabledMount = enabledContainer.Mounts.find(
      (mount) => mount.Destination === "/skills",
    );
    assert(enabledMount && enabledMount.Name !== legacyVolume);
    assert.equal(enabledMount.RW, false);
    const skillBody = await docker([
      "exec",
      "--user",
      "1000:1000",
      enabledContainer.Id,
      "cat",
      "/skills/code-review/SKILL.md",
    ]);
    assert.match(skillBody, /Stage 4 immutable preset version 1\./);
    const enabledAgent = await control(
      controller,
      `/internal/agents/${enabledAgentID}?organization_id=${login.principal.organization_id}`,
    );
    assert.equal(
      enabledAgent.configuration.skill_set_digest,
      skillTemplate.skill_set_digest,
    );
    assert.deepEqual(
      enabledAgent.configuration.system_skills,
      skillTemplate.skill_refs,
    );
    await waitForAgentReady(() =>
      admin
        .request(`/api/admin/agents/${enabledAgentID}`)
        .then((result) => result.body),
    );
    const ownerSession = new GatewayClient(config.gateway);
    await ownerSession.request("/api/session/login", {
      body: {
        organization_slug: "stage3",
        email: "legacy-owner@example.com",
        password: "legacy-owner-password",
      },
    });
    const acp = connectOwner(
      config.gateway,
      enabledAgentID,
      ownerSession.cookie,
      abort.signal,
    );
    try {
      await acp.initialize();
      const { sessionId } = await acp.request("new", {
        cwd: "/workspace",
        mcpServers: [],
      });
      const response = await acp.request(
        "prompt",
        { sessionId, prompt: [{ type: "text", text: "c5-after-restore" }] },
        60000,
      );
      assert.equal(response.stopReason, "end_turn");
      assert(
        acp.updates.some(
          (update) =>
            update.sessionId === sessionId &&
            update.update.sessionUpdate === "tool_call",
        ),
        "post-migration Run did not call Runtime read",
      );
    } finally {
      acp.close();
    }
    const modelStatus = await fetch(config.model + "/status", {
      signal: AbortSignal.timeout(15000),
    }).then((response) => response.json());
    assert.equal(modelStatus.errors.length, 0);
    assert.deepEqual(
      modelStatus.requests.map((request) => [request.phase, request.stage]),
      [
        ["c5-after-restore", "tool"],
        ["c5-after-restore", "reply"],
      ],
    );
    if (process.env.ANTNEST_E2E_POST_MIGRATION_RESTART === "true") {
      for (const service of ["runtime-controller", "agent-controller"]) {
        await docker(
          config.compose([
            "up",
            "-d",
            "--wait",
            "--wait-timeout",
            "180",
            "--no-build",
            "--pull",
            "never",
            "--no-deps",
            "--force-recreate",
            service,
          ]),
          true,
        );
      }
      const retainedReview = await control(
        controller,
        `/internal/agents/${enabledAgentID}/legacy-system-skills-migration?organization_id=${login.principal.organization_id}`,
      );
      assert.equal(retainedReview.migration.state, "resolved");
      const restartedRuntime = await control(
        rc,
        `/internal/runtimes/${enabledAgentID}`,
      );
      assert.equal(
        restartedRuntime.runtime_revision,
        enabledAgent.runtime?.runtime_revision,
      );
      const retainedContainer = JSON.parse(
        await docker(["inspect", `antnest-runtime-${enabledAgentID}`], true),
      )[0];
      const retainedMount = retainedContainer.Mounts.find(
        (mount) => mount.Destination === "/skills",
      );
      assert.equal(retainedMount?.Name, enabledMount.Name);
      assert.equal(retainedMount?.RW, false);
      const ordinaryDisable = (
        await admin.request(`/api/admin/agents/${enabledAgentID}/disable`, {
          status: 202,
          headers: { "Idempotency-Key": randomUUID() },
          body: {},
        })
      ).body;
      await waitOperation(
        admin,
        (ordinaryDisable.operation ?? ordinaryDisable).request_id,
      );
      const disabledReview = await control(
        controller,
        `/internal/agents/${enabledAgentID}/legacy-system-skills-migration?organization_id=${login.principal.organization_id}`,
      );
      assert.equal(
        disabledReview.migration.state,
        "resolved",
        "ordinary Disable reopened the migration gate",
      );
      const ordinaryEnable = (
        await admin.request(`/api/admin/agents/${enabledAgentID}/enable`, {
          status: 202,
          headers: { "Idempotency-Key": randomUUID() },
          body: {},
        })
      ).body;
      await waitOperation(
        admin,
        (ordinaryEnable.operation ?? ordinaryEnable).request_id,
      );
      const enabledAgain = JSON.parse(
        await docker(["inspect", `antnest-runtime-${enabledAgentID}`], true),
      )[0];
      const reusedMount = enabledAgain.Mounts.find(
        (mount) => mount.Destination === "/skills",
      );
      assert.equal(
        reusedMount?.Name,
        enabledMount.Name,
        "ordinary Enable did not reuse the pinned Skill volume",
      );
      assert.equal(reusedMount?.RW, false);
      const ordinaryRebuild = (
        await admin.request(`/api/admin/agents/${enabledAgentID}/rebuild`, {
          status: 202,
          headers: { "Idempotency-Key": randomUUID() },
          body: {
            template_id: skillTemplate.template_id,
            template_revision: skillTemplate.revision,
          },
        })
      ).body;
      await waitOperation(
        admin,
        (ordinaryRebuild.operation ?? ordinaryRebuild).request_id,
      );
      const rebuiltReview = await control(
        controller,
        `/internal/agents/${enabledAgentID}/legacy-system-skills-migration?organization_id=${login.principal.organization_id}`,
      );
      assert.equal(
        rebuiltReview.migration.state,
        "resolved",
        "ordinary Rebuild reopened the migration gate",
      );
      const rebuiltContainer = JSON.parse(
        await docker(["inspect", `antnest-runtime-${enabledAgentID}`], true),
      )[0];
      const rebuiltMount = rebuiltContainer.Mounts.find(
        (mount) => mount.Destination === "/skills",
      );
      assert.equal(
        rebuiltMount?.Name,
        enabledMount.Name,
        "ordinary Rebuild did not reuse the pinned Skill volume",
      );
      assert.equal(rebuiltMount?.RW, false);
      const rebuiltAgent = await control(
        controller,
        `/internal/agents/${enabledAgentID}?organization_id=${login.principal.organization_id}`,
      );
      assert.equal(
        rebuiltAgent.configuration.skill_set_digest,
        skillTemplate.skill_set_digest,
      );
      assert.deepEqual(
        rebuiltAgent.configuration.system_skills,
        skillTemplate.skill_refs,
      );
      const secondSkill = await publishSkill(admin, 2, publishedSkill.skill_id);
      const revisedTemplate = (
        await admin.request(
          `/api/admin/templates/${skillTemplate.template_id}/revisions`,
          {
            status: 201,
            body: {
              name: skillTemplate.name,
              model_profile_id: model.model_profile_id,
              system_prompt: skillTemplate.system_prompt,
              max_model_requests: 8,
              runtime: { image_ref: config.image },
              skill_refs: [
                {
                  skill_id: secondSkill.skill_id,
                  version: secondSkill.version,
                },
              ],
            },
          },
        )
      ).body;
      assert.equal(revisedTemplate.revision, skillTemplate.revision + 1);
      assert.equal(
        revisedTemplate.skill_refs[0].artifact_digest,
        secondSkill.artifact_digest,
      );
      const stillPinned = await control(
        controller,
        `/internal/agents/${enabledAgentID}?organization_id=${login.principal.organization_id}`,
      );
      assert.deepEqual(
        stillPinned.configuration.system_skills,
        skillTemplate.skill_refs,
        "publishing v2 or revising the Template changed the Agent without Rebuild",
      );
      const versioned = await admitPreparedLifecycle(
        admin,
        enabledAgentID,
        "rebuild",
        {
          template_id: revisedTemplate.template_id,
          template_revision: revisedTemplate.revision,
        },
      );
      await waitOperation(
        admin,
        (versioned.result.operation ?? versioned.result).request_id,
      );
      const upgradedReview = await control(
        controller,
        `/internal/agents/${enabledAgentID}/legacy-system-skills-migration?organization_id=${login.principal.organization_id}`,
      );
      assert.equal(upgradedReview.migration.state, "resolved");
      const upgradedContainer = JSON.parse(
        await docker(["inspect", `antnest-runtime-${enabledAgentID}`], true),
      )[0];
      const upgradedMount = upgradedContainer.Mounts.find(
        (mount) => mount.Destination === "/skills",
      );
      assert(
        upgradedMount?.Name && upgradedMount.Name !== enabledMount.Name,
        "version-changing Rebuild did not replace the prepared Skill set",
      );
      assert.equal(upgradedMount.RW, false);
      const upgradedBody = await docker([
        "exec",
        "--user",
        "1000:1000",
        upgradedContainer.Id,
        "cat",
        "/skills/code-review/SKILL.md",
      ]);
      assert.match(upgradedBody, /Stage 4 immutable preset version 2\./);
      const upgradedAgent = await control(
        controller,
        `/internal/agents/${enabledAgentID}?organization_id=${login.principal.organization_id}`,
      );
      assert.equal(
        upgradedAgent.configuration.skill_set_digest,
        revisedTemplate.skill_set_digest,
      );
      assert.deepEqual(
        upgradedAgent.configuration.system_skills,
        revisedTemplate.skill_refs,
      );
      await waitForAgentReady(() =>
        admin
          .request(`/api/admin/agents/${enabledAgentID}`)
          .then((result) => result.body),
      );
      const resumed = connectOwner(
        config.gateway,
        enabledAgentID,
        ownerSession.cookie,
        abort.signal,
      );
      try {
        await resumed.initialize();
        const { sessionId } = await resumed.request("new", {
          cwd: "/workspace",
          mcpServers: [],
        });
        const response = await resumed.request(
          "prompt",
          {
            sessionId,
            prompt: [{ type: "text", text: "c5-after-migration-v2" }],
          },
          60000,
        );
        assert.equal(response.stopReason, "end_turn");
        assert(
          resumed.updates.some(
            (update) =>
              update.sessionId === sessionId &&
              update.update.sessionUpdate === "tool_call",
          ),
          "post-restart Run did not call Runtime read",
        );
      } finally {
        resumed.close();
      }
      const resumedModelStatus = await fetch(config.model + "/status", {
        signal: AbortSignal.timeout(15000),
      }).then((response) => response.json());
      assert.equal(resumedModelStatus.errors.length, 0);
      assert.deepEqual(
        resumedModelStatus.requests.map((request) => [
          request.phase,
          request.stage,
        ]),
        [
          ["c5-after-restore", "tool"],
          ["c5-after-restore", "reply"],
          ["c5-after-migration-v2", "tool"],
          ["c5-after-migration-v2", "reply"],
        ],
      );
      const upgradedDisable = (
        await admin.request(`/api/admin/agents/${enabledAgentID}/disable`, {
          status: 202,
          headers: { "Idempotency-Key": randomUUID() },
          body: {},
        })
      ).body;
      await waitOperation(
        admin,
        (upgradedDisable.operation ?? upgradedDisable).request_id,
      );
      const ownedRuntimeContainers = lines(
        await docker(
          [
            "ps",
            "-aq",
            "--filter",
            `label=io.antnest.runtime-controller-scope=${config.project}`,
            "--filter",
            `label=io.antnest.agent-id=${enabledAgentID}`,
            "--filter",
            "label=io.antnest.managed=runtime",
          ],
          true,
        ),
      );
      assert.equal(
        ownedRuntimeContainers.length,
        0,
        "disabled migrated Agent still owns a Runtime container",
      );
      const lostVolume = JSON.parse(
        await docker(["volume", "inspect", upgradedMount.Name], true),
      )[0];
      assert.equal(
        lostVolume.Labels["io.antnest.runtime-controller-scope"],
        config.project,
      );
      assert.equal(lostVolume.Labels["io.antnest.agent-id"], enabledAgentID);
      assert.equal(lostVolume.Labels["io.antnest.managed"], "skill-set");
      assert.equal(
        lostVolume.Labels["io.antnest.skill-set-digest"],
        revisedTemplate.skill_set_digest,
      );
      await docker(["volume", "rm", upgradedMount.Name], true);
      const rematerialized = await admitPreparedLifecycle(
        admin,
        enabledAgentID,
        "enable",
        {},
      );
      await waitOperation(
        admin,
        (rematerialized.result.operation ?? rematerialized.result).request_id,
      );
      const restoredReview = await control(
        controller,
        `/internal/agents/${enabledAgentID}/legacy-system-skills-migration?organization_id=${login.principal.organization_id}`,
      );
      assert.equal(restoredReview.migration.state, "resolved");
      const restoredContainer = JSON.parse(
        await docker(["inspect", `antnest-runtime-${enabledAgentID}`], true),
      )[0];
      const restoredMount = restoredContainer.Mounts.find(
        (mount) => mount.Destination === "/skills",
      );
      assert(
        restoredMount?.Name && restoredMount.Name !== upgradedMount.Name,
        "lost post-migration Skill volume was silently reused",
      );
      assert.equal(
        restoredMount.Name.replace(/-m[0-9]+$/, ""),
        upgradedMount.Name.replace(/-m[0-9]+$/, ""),
      );
      assert.equal(restoredMount.RW, false);
      const restoredBody = await docker([
        "exec",
        "--user",
        "1000:1000",
        restoredContainer.Id,
        "cat",
        "/skills/code-review/SKILL.md",
      ]);
      assert.match(restoredBody, /Stage 4 immutable preset version 2\./);
      await waitForAgentReady(() =>
        admin
          .request(`/api/admin/agents/${enabledAgentID}`)
          .then((result) => result.body),
      );
      const restoredRun = connectOwner(
        config.gateway,
        enabledAgentID,
        ownerSession.cookie,
        abort.signal,
      );
      try {
        await restoredRun.initialize();
        const { sessionId } = await restoredRun.request("new", {
          cwd: "/workspace",
          mcpServers: [],
        });
        const response = await restoredRun.request(
          "prompt",
          {
            sessionId,
            prompt: [{ type: "text", text: "c5-after-migration-volume-loss" }],
          },
          60000,
        );
        assert.equal(response.stopReason, "end_turn");
        assert(
          restoredRun.updates.some(
            (update) =>
              update.sessionId === sessionId &&
              update.update.sessionUpdate === "tool_call",
          ),
          "rematerialized Skill was not read by ACP Run",
        );
      } finally {
        restoredRun.close();
      }
      const restoredModelStatus = await fetch(config.model + "/status", {
        signal: AbortSignal.timeout(15000),
      }).then((response) => response.json());
      assert.equal(restoredModelStatus.errors.length, 0);
      assert.deepEqual(
        restoredModelStatus.requests.map((request) => [
          request.phase,
          request.stage,
        ]),
        [
          ["c5-after-restore", "tool"],
          ["c5-after-restore", "reply"],
          ["c5-after-migration-v2", "tool"],
          ["c5-after-migration-v2", "reply"],
          ["c5-after-migration-volume-loss", "tool"],
          ["c5-after-migration-volume-loss", "reply"],
        ],
      );
      console.log(
        JSON.stringify({
          post_migration_restart: "passed",
          agent_id: enabledAgentID,
          skill_volume: retainedMount.Name,
          ordinary_disable_enable: true,
          ordinary_rebuild: true,
          version_upgrade: true,
          post_migration_volume_loss_recovered: true,
          preparation_retry_observed:
            versioned.sawPreparation || rematerialized.sawPreparation,
        }),
      );
    }
    if (process.env.ANTNEST_E2E_SOURCE_RECOVERY === "true") {
      const sourceCreated = (
        await admin.request("/api/admin/agents", {
          status: 202,
          body: {
            owner_user_id: owner.user.id,
            name: "Legacy source recovery Agent",
            template_id: template.template_id,
            template_revision: template.revision,
          },
        })
      ).body;
      const sourceAgentID = sourceCreated.agent.agent_id;
      await waitOperation(admin, sourceCreated.operation.request_id);
      const sourceContainer = JSON.parse(
        await docker(["inspect", `antnest-runtime-${sourceAgentID}`], true),
      )[0];
      const sourceWorkspace = sourceContainer.Mounts.find(
        (mount) => mount.Destination === "/workspace",
      );
      const sourceSkills = sourceContainer.Mounts.find(
        (mount) => mount.Destination === "/skills",
      );
      assert(sourceWorkspace?.Name && sourceSkills?.Name);
      let sourceRuntime;
      for (let attempt = 0; attempt < 180; attempt++) {
        sourceRuntime = await control(
          rc,
          `/internal/runtimes/${sourceAgentID}`,
        );
        if (
          sourceRuntime.phase === "running" &&
          sourceRuntime.runtime_execution_id
        )
          break;
        await delay(500, undefined, { signal: abort.signal });
      }
      assert(
        sourceRuntime.runtime_execution_id,
        "source Runtime process was not observed",
      );
      assert.equal(sourceRuntime.lifecycle_state, "provisioned");
      await waitForAgentReady(() =>
        admin
          .request(`/api/admin/agents/${sourceAgentID}`)
          .then((result) => result.body),
      );
      const sourceACP = connectOwner(
        config.gateway,
        sourceAgentID,
        ownerSession.cookie,
        abort.signal,
      );
      await sourceACP.initialize();
      const heldSession = (
        await sourceACP.request("new", { cwd: "/workspace", mcpServers: [] })
      ).sessionId;
      let heldSettled = false;
      const heldPrompt = sourceACP
        .request(
          "prompt",
          {
            sessionId: heldSession,
            prompt: [{ type: "text", text: "c5-source-held" }],
          },
          180000,
        )
        .then(
          (value) => {
            heldSettled = true;
            return { value };
          },
          (error) => {
            heldSettled = true;
            return { error };
          },
        );
      let heldStarted = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        heldStarted =
          (await docker([
            "exec",
            "--user",
            "1000:1000",
            sourceContainer.Id,
            "sh",
            "-c",
            "if [ -f /workspace/.c5-source-started ]; then printf started; fi",
          ])) === "started";
        if (heldStarted) break;
        if (heldSettled) {
          const early = await heldPrompt;
          throw new Error(
            `held Run ended before its Runtime tool barrier: ${early.error?.message ?? early.value?.stopReason}`,
          );
        }
        await delay(200, undefined, { signal: abort.signal });
      }
      assert(heldStarted, "held Run did not enter its Runtime tool barrier");
      await docker([
        "exec",
        postgres,
        "psql",
        "-XAt",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "antnest_test_admin",
        "-d",
        "antnest_agent_controller",
        "-c",
        `INSERT INTO agent_controller.legacy_system_skills_migrations(agent_id,organization_id,state)
         VALUES ('${sourceAgentID}','${login.principal.organization_id}','pending');
         UPDATE agent_controller.agents SET executable_execution_revision_id='missing-execution'
         WHERE id='${sourceAgentID}'`,
      ]);
      const sourceRecoveryPath = `/internal/agents/${sourceAgentID}/legacy-system-skills-migration/source-recovery`;
      const sourceRecoveryBody = {
        organization_id: login.principal.organization_id,
        actor_principal_id: login.principal.user_id,
      };
      await docker([
        "exec",
        postgres,
        "psql",
        "-XAt",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "antnest_test_admin",
        "-d",
        "antnest_agent_controller",
        "-c",
        `UPDATE agent_controller.agents SET runtime_revision='rtv_${"f".repeat(32)}' WHERE id='${sourceAgentID}'`,
      ]);
      const wrongSourceID = randomUUID();
      const wrongSource = await control(controller, sourceRecoveryPath, {
        method: "POST",
        status: 409,
        idempotencyKey: wrongSourceID,
        body: sourceRecoveryBody,
      });
      assert.equal(wrongSource.code, "legacy_source_manual_recovery_required");
      const wrongSourceReceipt = await control(
        controller,
        `/internal/agent-operations/${wrongSourceID}?organization_id=${login.principal.organization_id}`,
        { status: 404 },
      );
      assert.equal(wrongSourceReceipt.code, "operation_not_found");
      await docker([
        "exec",
        postgres,
        "psql",
        "-XAt",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "antnest_test_admin",
        "-d",
        "antnest_agent_controller",
        "-c",
        `UPDATE agent_controller.agents SET runtime_revision='${sourceRuntime.runtime_revision}' WHERE id='${sourceAgentID}'`,
      ]);
      const sourceRecoveryID = randomUUID();
      const admittedSourceRecovery = await control(
        controller,
        sourceRecoveryPath,
        {
          method: "POST",
          status: 202,
          idempotencyKey: sourceRecoveryID,
          body: sourceRecoveryBody,
        },
      );
      assert.equal(
        admittedSourceRecovery.source_runtime_revision,
        sourceRuntime.runtime_revision,
      );
      assert.equal(admittedSourceRecovery.phase, "drain");
      assert.equal(
        heldSettled,
        false,
        "source recovery interrupted the active Run",
      );
      const sourceNetworkProbe =
        "fetch(process.argv[1],{signal:AbortSignal.timeout(15000)}).then(async response=>{if(!response.ok)process.exitCode=1;console.log(JSON.stringify(await response.json()))})";
      const networkDuringDrain = JSON.parse(
        await docker(
          [
            "run",
            "--rm",
            "--network",
            `${config.project}_control`,
            "node:24.21.0-bookworm-slim",
            "node",
            "-e",
            sourceNetworkProbe,
            `http://${config.env.ANTNEST_EGRESS_CONTROL_IPV4}:8081/internal/agent-networks/${sourceAgentID}`,
          ],
          true,
        ),
      );
      assert.equal(
        networkDuringDrain.attachment_state,
        "open",
        "active Run was fenced before settlement",
      );
      await docker([
        "exec",
        "--user",
        "1000:1000",
        sourceContainer.Id,
        "sh",
        "-c",
        "touch /workspace/.c5-source-release",
      ]);
      const heldResult = await heldPrompt;
      assert.ifError(heldResult.error);
      assert.equal(heldResult.value.stopReason, "end_turn");
      sourceACP.close();
      let sourceReceipt;
      for (let attempt = 0; attempt < 180; attempt++) {
        sourceReceipt = await control(
          controller,
          `/internal/agent-operations/${sourceRecoveryID}?organization_id=${login.principal.organization_id}`,
        );
        if (sourceReceipt.state === "completed") break;
        assert.equal(
          sourceReceipt.state,
          "running",
          JSON.stringify(sourceReceipt),
        );
        await delay(500, undefined, { signal: abort.signal });
      }
      assert.equal(
        sourceReceipt?.state,
        "completed",
        JSON.stringify(sourceReceipt),
      );
      assert.equal(sourceReceipt.phase, "done");
      assert.equal(
        sourceReceipt.child_request_id,
        admittedSourceRecovery.child_request_id,
      );
      const sourceTraceID = await docker(
        [
          "exec",
          postgres,
          "psql",
          "-XAt",
          "-v",
          "ON_ERROR_STOP=1",
          "-U",
          "antnest_test_admin",
          "-d",
          "antnest_agent_controller",
          "-c",
          `SELECT trace_id FROM agent_controller.agent_events WHERE operation_request_id='${sourceRecoveryID}' AND event_type='agent_legacy_source_recovered'`,
        ],
        true,
      );
      assert.match(sourceTraceID, /^[a-f0-9]{32}$/);
      let sourceTrace;
      const sourceTraceTopology = await collectTrace(
        config.jaeger,
        sourceTraceID,
        (trace) => {
          sourceTrace = trace;
          return inspectLegacySourceRecoveryTrace(trace, {
            traceID: sourceTraceID,
            secrets: [
              "stage3-admin-password",
              "legacy-owner-password",
              "stage3-model-secret",
              "Legacy shared Skill awaiting migration",
              attestation.signature,
            ],
          });
        },
        abort.signal,
      );
      const sourceTraceEvidence = join(
        "artifacts",
        "verification",
        "skill-registry",
        config.project,
      );
      await mkdir(sourceTraceEvidence, { recursive: true, mode: 0o700 });
      await writeFile(
        join(sourceTraceEvidence, `${sourceTraceID}.json`),
        JSON.stringify(sourceTrace),
        { mode: 0o600 },
      );
      await docker(
        config.compose([
          "up",
          "-d",
          "--wait",
          "--wait-timeout",
          "180",
          "--no-build",
          "--pull",
          "never",
          "--no-deps",
          "--force-recreate",
          "agent-controller",
        ]),
        true,
      );
      const restartedSourceReceipt = await control(
        controller,
        sourceRecoveryPath,
        {
          method: "POST",
          status: 200,
          idempotencyKey: sourceRecoveryID,
          body: sourceRecoveryBody,
        },
      );
      assert.deepEqual(restartedSourceReceipt, sourceReceipt);
      const recoveredAgent = await control(
        controller,
        `/internal/agents/${sourceAgentID}?organization_id=${login.principal.organization_id}`,
      );
      assert.equal(recoveredAgent.activation_state, "disabled");
      assert.equal(
        recoveredAgent.runtime?.runtime_revision,
        sourceReceipt.disabled_runtime_revision,
      );
      const sourceReview = await control(
        controller,
        `/internal/agents/${sourceAgentID}/legacy-system-skills-migration?organization_id=${login.principal.organization_id}`,
      );
      assert.equal(sourceReview.migration.state, "pending");
      await docker(["volume", "inspect", sourceWorkspace.Name], true);
      await docker(["volume", "inspect", sourceSkills.Name], true);
      const sourceChoice = await control(
        controller,
        `/internal/agents/${sourceAgentID}/legacy-system-skills-migration/choices`,
        {
          method: "POST",
          status: 201,
          idempotencyKey: randomUUID(),
          body: {
            ...body,
            kind: "template_revision",
            template_id: skillTemplate.template_id,
            template_revision: skillTemplate.revision,
          },
        },
      );
      const sourceMigrationID = randomUUID();
      const sourceMigration = await control(
        controller,
        `/internal/agents/${sourceAgentID}/legacy-system-skills-migration/operations`,
        {
          method: "POST",
          status: 202,
          idempotencyKey: sourceMigrationID,
          body: { ...migrationBody, choice_sequence: sourceChoice.sequence },
        },
      );
      assert.equal(sourceMigration.kind, "enable");
      await waitOperation(admin, sourceMigrationID);
      const resolvedSource = await control(
        controller,
        `/internal/agents/${sourceAgentID}/legacy-system-skills-migration?organization_id=${login.principal.organization_id}`,
      );
      assert.equal(resolvedSource.migration.state, "resolved");
      const missingCreated = (
        await admin.request("/api/admin/agents", {
          status: 202,
          body: {
            owner_user_id: owner.user.id,
            name: "Legacy missing source Agent",
            template_id: template.template_id,
            template_revision: template.revision,
          },
        })
      ).body;
      const missingSourceAgentID = missingCreated.agent.agent_id;
      await waitOperation(admin, missingCreated.operation.request_id);
      await docker([
        "exec",
        postgres,
        "psql",
        "-XAt",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "antnest_test_admin",
        "-d",
        "antnest_agent_controller",
        "-c",
        `INSERT INTO agent_controller.legacy_system_skills_migrations(agent_id,organization_id,state)
         VALUES ('${missingSourceAgentID}','${login.principal.organization_id}','pending');
         UPDATE agent_controller.agents SET executable_execution_revision_id='missing-execution'
         WHERE id='${missingSourceAgentID}'`,
      ]);
      await docker(
        ["rm", "-f", `antnest-runtime-${missingSourceAgentID}`],
        true,
      );
      const missingSourceID = randomUUID();
      const missingSource = await control(
        controller,
        `/internal/agents/${missingSourceAgentID}/legacy-system-skills-migration/source-recovery`,
        {
          method: "POST",
          status: 409,
          idempotencyKey: missingSourceID,
          body: sourceRecoveryBody,
        },
      );
      assert.equal(
        missingSource.code,
        "legacy_source_manual_recovery_required",
      );
      const missingSourceReceipt = await control(
        controller,
        `/internal/agent-operations/${missingSourceID}?organization_id=${login.principal.organization_id}`,
        { status: 404 },
      );
      assert.equal(missingSourceReceipt.code, "operation_not_found");
      const proxy = "http://source-recovery-rc-proxy:8080";
      const createUnprovenSource = async (name, mode, beforeCorrupt) => {
        const created = (
          await admin.request("/api/admin/agents", {
            status: 202,
            body: {
              owner_user_id: owner.user.id,
              name,
              template_id: template.template_id,
              template_revision: template.revision,
            },
          })
        ).body;
        const id = created.agent.agent_id;
        await waitOperation(admin, created.operation.request_id);
        let observed;
        for (let attempt = 0; attempt < 180; attempt++) {
          observed = await control(rc, `/internal/runtimes/${id}`);
          if (observed.phase === "running" && observed.runtime_execution_id)
            break;
          await delay(500, undefined, { signal: abort.signal });
        }
        assert(
          observed?.runtime_execution_id,
          `${name} Runtime process was not observed`,
        );
        await waitForAgentReady(() =>
          admin
            .request(`/api/admin/agents/${id}`)
            .then((result) => result.body),
        );
        if (mode)
          await control(proxy, "/fault/configure", {
            method: "POST",
            body: {
              agent_id: id,
              mode,
            },
          });
        if (beforeCorrupt) await beforeCorrupt(id);
        await docker([
          "exec",
          postgres,
          "psql",
          "-XAt",
          "-v",
          "ON_ERROR_STOP=1",
          "-U",
          "antnest_test_admin",
          "-d",
          "antnest_agent_controller",
          "-c",
          `INSERT INTO agent_controller.legacy_system_skills_migrations(agent_id,organization_id,state)
           VALUES ('${id}','${login.principal.organization_id}','pending');
           UPDATE agent_controller.agents SET executable_execution_revision_id='missing-execution'
           WHERE id='${id}'`,
        ]);
        const state = await docker(
          [
            "exec",
            postgres,
            "psql",
            "-XAt",
            "-v",
            "ON_ERROR_STOP=1",
            "-U",
            "antnest_test_admin",
            "-d",
            "antnest_agent_controller",
            "-c",
            `SELECT json_build_object('desired',desired_state,'activation',activation_state,
           'lifecycle',lifecycle_state,'active',active_operation_request_id,
           'execution',executable_execution_revision_id,'failure',failure_code)
           FROM agent_controller.agents WHERE id='${id}'`,
          ],
          true,
        );
        const expected = JSON.parse(state);
        assert.equal(expected.desired, "enabled");
        assert.equal(expected.activation, "enabled");
        assert.equal(expected.lifecycle, "created");
        assert.equal(expected.active, "");
        assert.equal(expected.execution, "missing-execution");
        assert.equal(expected.failure, "");
        return id;
      };
      const unknownAgentID = await createUnprovenSource(
        "Legacy unknown Disable Agent",
        "unknown_once",
      );
      const unknownRecoveryID = randomUUID();
      await control(
        controller,
        `/internal/agents/${unknownAgentID}/legacy-system-skills-migration/source-recovery`,
        {
          method: "POST",
          status: 202,
          idempotencyKey: unknownRecoveryID,
          body: sourceRecoveryBody,
        },
      );
      let unknownReceipt;
      for (let attempt = 0; attempt < 180; attempt++) {
        unknownReceipt = await control(
          controller,
          `/internal/agent-operations/${unknownRecoveryID}?organization_id=${login.principal.organization_id}`,
        );
        if (unknownReceipt.state === "completed") break;
        assert.equal(
          unknownReceipt.state,
          "running",
          JSON.stringify(unknownReceipt),
        );
        await delay(500, undefined, { signal: abort.signal });
      }
      assert.equal(
        unknownReceipt?.state,
        "completed",
        JSON.stringify(unknownReceipt),
      );
      const unknownFault = await control(proxy, "/fault/status");
      assert(
        unknownFault.calls >= 2,
        "unknown RC result did not retry Disable",
      );
      assert(
        unknownFault.child_ids.every(
          (id) => id === unknownReceipt.child_request_id,
        ),
        "unknown RC result changed the child request ID",
      );
      const rejectAgentID = await createUnprovenSource(
        "Legacy rejected Disable Agent",
        "reject",
      );
      const rejectedRecoveryID = randomUUID();
      await control(
        controller,
        `/internal/agents/${rejectAgentID}/legacy-system-skills-migration/source-recovery`,
        {
          method: "POST",
          status: 202,
          idempotencyKey: rejectedRecoveryID,
          body: sourceRecoveryBody,
        },
      );
      let rejectedReceipt;
      for (let attempt = 0; attempt < 180; attempt++) {
        rejectedReceipt = await control(
          controller,
          `/internal/agent-operations/${rejectedRecoveryID}?organization_id=${login.principal.organization_id}`,
        );
        if (rejectedReceipt.state === "manual_recovery_required") break;
        assert.equal(
          rejectedReceipt.state,
          "running",
          JSON.stringify(rejectedReceipt),
        );
        await delay(500, undefined, { signal: abort.signal });
      }
      assert.equal(
        rejectedReceipt?.manual_reason,
        "runtime_disable_rejected",
        JSON.stringify(rejectedReceipt),
      );
      const rejectedFault = await control(proxy, "/fault/status");
      assert.equal(rejectedFault.calls, 1);
      assert.equal(rejectedFault.forwarded, 0, "rejected Disable reached RC");
      const rejectedRuntime = await control(
        rc,
        `/internal/runtimes/${rejectAgentID}`,
      );
      assert.equal(rejectedRuntime.lifecycle_state, "provisioned");
      const rejectedReview = await control(
        controller,
        `/internal/agents/${rejectAgentID}/legacy-system-skills-migration?organization_id=${login.principal.organization_id}`,
      );
      assert.equal(rejectedReview.migration.state, "pending");
      const egressProxy = "http://source-recovery-egress-proxy:8081";
      const driftAgentID = await createUnprovenSource(
        "Legacy Egress drift Agent",
        undefined,
        (id) =>
          control(egressProxy, "/fault/configure", {
            method: "POST",
            body: {
              agent_id: id,
              mode: "hold_publish",
            },
          }),
      );
      const driftRecoveryID = randomUUID();
      await control(
        controller,
        `/internal/agents/${driftAgentID}/legacy-system-skills-migration/source-recovery`,
        {
          method: "POST",
          status: 202,
          idempotencyKey: driftRecoveryID,
          body: sourceRecoveryBody,
        },
      );
      let driftPending = false;
      for (let attempt = 0; attempt < 120; attempt++) {
        driftPending = (await control(egressProxy, "/fault/status")).pending;
        if (driftPending) break;
        await delay(500, undefined, { signal: abort.signal });
      }
      assert(
        driftPending,
        "source recovery did not reach the held Egress publication recheck",
      );
      const driftHeld = await control(
        controller,
        `/internal/agent-operations/${driftRecoveryID}?organization_id=${login.principal.organization_id}`,
      );
      assert.equal(driftHeld.phase, "publish");
      await control(egressProxy, "/fault/reopen", { method: "POST" });
      await control(egressProxy, "/fault/release", { method: "POST" });
      let driftReceipt;
      for (let attempt = 0; attempt < 180; attempt++) {
        driftReceipt = await control(
          controller,
          `/internal/agent-operations/${driftRecoveryID}?organization_id=${login.principal.organization_id}`,
        );
        if (driftReceipt.state === "manual_recovery_required") break;
        assert.equal(
          driftReceipt.state,
          "running",
          JSON.stringify(driftReceipt),
        );
        await delay(500, undefined, { signal: abort.signal });
      }
      assert.equal(
        driftReceipt?.manual_reason,
        "network_attachment_changed",
        JSON.stringify(driftReceipt),
      );
      const driftNetwork = JSON.parse(
        await docker(
          [
            "run",
            "--rm",
            "--network",
            `${config.project}_control`,
            "node:24.21.0-bookworm-slim",
            "node",
            "-e",
            sourceNetworkProbe,
            `http://${config.env.ANTNEST_EGRESS_CONTROL_IPV4}:8081/internal/agent-networks/${driftAgentID}`,
          ],
          true,
        ),
      );
      assert.equal(
        driftNetwork.attachment_state,
        "closed",
        "drifted Egress stayed open after manual recovery",
      );
      const driftReview = await control(
        controller,
        `/internal/agents/${driftAgentID}/legacy-system-skills-migration?organization_id=${login.principal.organization_id}`,
      );
      assert.equal(driftReview.migration.state, "pending");
      console.log(
        JSON.stringify({
          source_recovery: "passed",
          agent_id: sourceAgentID,
          trace: sourceTraceTopology,
          unknown_disable_replayed: true,
          rejected_disable_fenced: true,
          changed_egress_refenced: true,
        }),
      );
    }
    const faultCreated = (
      await admin.request("/api/admin/agents", {
        status: 202,
        body: {
          owner_user_id: owner.user.id,
          name: "Legacy proof-loss Agent",
          template_id: template.template_id,
          template_revision: template.revision,
        },
      })
    ).body;
    const faultAgentID = faultCreated.agent.agent_id;
    await waitOperation(admin, faultCreated.operation.request_id);
    await docker([
      "exec",
      postgres,
      "psql",
      "-XAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "antnest_test_admin",
      "-d",
      "antnest_agent_controller",
      "-c",
      `INSERT INTO agent_controller.legacy_system_skills_migrations(agent_id,organization_id,state) VALUES ('${faultAgentID}','${login.principal.organization_id}','pending')`,
    ]);
    const faultChoice = await control(
      controller,
      `/internal/agents/${faultAgentID}/legacy-system-skills-migration/choices`,
      {
        method: "POST",
        status: 201,
        idempotencyKey: randomUUID(),
        body,
      },
    );
    const faultRequestID = randomUUID();
    const revokeAtPublish = `CREATE FUNCTION agent_controller.revoke_test_legacy_key_at_publish() RETURNS trigger
      LANGUAGE plpgsql AS $migration$ BEGIN
        UPDATE agent_controller.legacy_export_verifier_keys SET revoked_at=clock_timestamp()
        WHERE key_id='stage4-test-key' AND revoked_at IS NULL;
        RETURN NEW;
      END $migration$;
      CREATE TRIGGER revoke_test_legacy_key_at_publish AFTER UPDATE OF phase
      ON agent_controller.agent_lifecycle_operations FOR EACH ROW
      WHEN (NEW.phase='publish' AND NEW.request_id='${faultRequestID}')
      EXECUTE FUNCTION agent_controller.revoke_test_legacy_key_at_publish();`;
    await docker([
      "exec",
      postgres,
      "psql",
      "-XAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "antnest_test_admin",
      "-d",
      "antnest_agent_controller",
      "-c",
      revokeAtPublish,
    ]);
    const faultMigration = await control(
      controller,
      `/internal/agents/${faultAgentID}/legacy-system-skills-migration/operations`,
      {
        method: "POST",
        status: 202,
        idempotencyKey: faultRequestID,
        body: { ...migrationBody, choice_sequence: faultChoice.sequence },
      },
    );
    assert.equal(faultMigration.kind, "rebuild");
    await waitFailedOperation(
      admin,
      faultRequestID,
      "legacy_migration_proof_lost",
    );
    const networkProbe =
      "fetch(process.argv[1],{signal:AbortSignal.timeout(15000)}).then(async response=>{if(!response.ok)process.exitCode=1;console.log(JSON.stringify(await response.json()))})";
    const faultNetwork = JSON.parse(
      await docker(
        [
          "run",
          "--rm",
          "--network",
          `${config.project}_control`,
          "node:24.21.0-bookworm-slim",
          "node",
          "-e",
          networkProbe,
          `http://${config.env.ANTNEST_EGRESS_CONTROL_IPV4}:8081/internal/agent-networks/${faultAgentID}`,
        ],
        true,
      ),
    );
    assert.equal(faultNetwork.attachment_state, "closed");
    const faultAgent = await control(
      controller,
      `/internal/agents/${faultAgentID}?organization_id=${login.principal.organization_id}`,
    );
    assert.equal(faultAgent.failure_code, "legacy_migration_proof_lost");
    assert.equal(faultAgent.runtime_state, "unknown");
    const faultReview = await control(
      controller,
      `/internal/agents/${faultAgentID}/legacy-system-skills-migration?organization_id=${login.principal.organization_id}`,
    );
    assert.equal(faultReview.migration.state, "pending");
    const retried = await control(
      controller,
      `/internal/agents/${faultAgentID}/legacy-system-skills-migration/operations`,
      {
        method: "POST",
        status: 409,
        idempotencyKey: randomUUID(),
        body: { ...migrationBody, choice_sequence: faultChoice.sequence },
      },
    );
    assert.equal(retried.code, "legacy_migration_recovery_required");
    const faultContainer = JSON.parse(
      await docker(["inspect", `antnest-runtime-${faultAgentID}`], true),
    )[0];
    const faultWorkspace = faultContainer.Mounts.find(
      (mount) => mount.Destination === "/workspace",
    );
    const faultSkills = faultContainer.Mounts.find(
      (mount) => mount.Destination === "/skills",
    );
    assert(
      faultWorkspace?.Name && faultSkills?.Name,
      "fault target must have retained volumes",
    );
    let observedProcess;
    for (let attempt = 0; attempt < 180; attempt++) {
      observedProcess = await control(rc, `/internal/runtimes/${faultAgentID}`);
      if (observedProcess.runtime_execution_id) break;
      await delay(500, undefined, { signal: abort.signal });
    }
    assert(
      observedProcess?.runtime_execution_id,
      "fault target process was not observed before restart",
    );
    await docker(["restart", `antnest-runtime-${faultAgentID}`], true);
    let restartedProcess;
    for (let attempt = 0; attempt < 180; attempt++) {
      restartedProcess = await control(
        rc,
        `/internal/runtimes/${faultAgentID}`,
      );
      if (
        restartedProcess.runtime_execution_id &&
        restartedProcess.runtime_execution_id !==
          observedProcess.runtime_execution_id
      )
        break;
      await delay(500, undefined, { signal: abort.signal });
    }
    assert(
      restartedProcess?.runtime_execution_id &&
        restartedProcess.runtime_execution_id !==
          observedProcess.runtime_execution_id,
      "Runtime restart did not change the observed process identity",
    );
    assert.equal(
      restartedProcess.runtime_revision,
      observedProcess.runtime_revision,
      "process restart must retain the RC revision",
    );
    const recoveryCrash = process.env.ANTNEST_E2E_RECOVERY_NORMAL !== "true";
    const recoveryID = randomUUID();
    const recoveryPath = `/internal/agents/${faultAgentID}/legacy-system-skills-migration/proof-loss-recovery`;
    const recoveryBody = {
      organization_id: login.principal.organization_id,
      actor_principal_id: login.principal.user_id,
      failed_migration_request_id: faultRequestID,
    };
    const holdRecoveryReceipt = `CREATE FUNCTION agent_controller.hold_test_recovery_receipt() RETURNS trigger
      LANGUAGE plpgsql AS $recovery$ BEGIN
        PERFORM pg_sleep(90);
        RETURN NEW;
      END $recovery$;
      CREATE TRIGGER hold_test_recovery_receipt BEFORE UPDATE OF phase
      ON agent_controller.legacy_proof_loss_recoveries FOR EACH ROW
      WHEN (NEW.phase='publish' AND NEW.request_id='${recoveryID}')
      EXECUTE FUNCTION agent_controller.hold_test_recovery_receipt();`;
    if (recoveryCrash)
      await docker([
        "exec",
        postgres,
        "psql",
        "-XAt",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "antnest_test_admin",
        "-d",
        "antnest_agent_controller",
        "-c",
        holdRecoveryReceipt,
      ]);
    const beforeRecoveryRuntime = await control(
      rc,
      `/internal/runtimes/${faultAgentID}`,
    );
    console.log(
      JSON.stringify({
        proof_loss_recovery_preflight: {
          phase: beforeRecoveryRuntime.phase,
          lifecycle_state: beforeRecoveryRuntime.lifecycle_state,
          health: beforeRecoveryRuntime.health,
          runtime_revision: beforeRecoveryRuntime.runtime_revision,
          has_execution_id: Boolean(beforeRecoveryRuntime.runtime_execution_id),
        },
      }),
    );
    const recovery = await control(controller, recoveryPath, {
      method: "POST",
      status: 202,
      idempotencyKey: recoveryID,
      body: recoveryBody,
    });
    assert.equal(recovery.request_id, recoveryID);
    assert.equal(recovery.failed_migration_request_id, faultRequestID);
    if (recoveryCrash) {
      const competingRecoveryID = randomUUID();
      const competingRecovery = await control(controller, recoveryPath, {
        method: "POST",
        status: 409,
        idempotencyKey: competingRecoveryID,
        body: recoveryBody,
      });
      assert.equal(competingRecovery.code, "lifecycle_conflict");
      const competingQuery = await control(
        controller,
        `/internal/agent-operations/${competingRecoveryID}?organization_id=${login.principal.organization_id}`,
        { status: 404 },
      );
      assert.equal(competingQuery.code, "operation_not_found");
      const runningReplay = await control(controller, recoveryPath, {
        method: "POST",
        status: 202,
        idempotencyKey: recoveryID,
        body: recoveryBody,
      });
      assert.deepEqual(runningReplay, recovery);
    }
    let disabledChild;
    for (let attempt = 0; attempt < 180; attempt++) {
      try {
        disabledChild = await control(
          rc,
          `/internal/runtime-operations/${recovery.child_request_id}`,
        );
      } catch {
        await delay(500, undefined, { signal: abort.signal });
        continue;
      }
      if (disabledChild.state === "completed") break;
      assert.equal(
        disabledChild.state,
        "running",
        `RC recovery Disable: ${JSON.stringify(disabledChild)}`,
      );
      await delay(500, undefined, { signal: abort.signal });
    }
    assert.equal(
      disabledChild?.state,
      "completed",
      `RC Disable did not complete: ${JSON.stringify(disabledChild)}`,
    );
    console.log(
      JSON.stringify({ proof_loss_recovery_fault_stage: "rc_child_completed" }),
    );
    const recreateController = async () => {
      config.env.ANTNEST_AGENT_CONTROLLER_LEGACY_EXPORT_VERIFIER_KEYS =
        JSON.stringify({
          current: {
            key_id: "stage4-next-key",
            public_key: nextPublicBytes.toString("base64"),
          },
        });
      await docker(
        config.compose([
          "up",
          "-d",
          "--wait",
          "--no-build",
          "--no-deps",
          "--force-recreate",
          "agent-controller",
        ]),
        true,
      );
      console.log(
        JSON.stringify({
          proof_loss_recovery_fault_stage: "controller_recreated",
        }),
      );
    };
    if (recoveryCrash) {
      const beforeCrash = await control(
        controller,
        `/internal/agent-operations/${recoveryID}?organization_id=${login.principal.organization_id}`,
      );
      assert.equal(
        beforeCrash.phase,
        "disable_runtime",
        "receipt hold must precede Controller publication",
      );
      const controllerContainer = lines(
        await docker(config.compose(["ps", "-q", "agent-controller"])),
      )[0];
      assert(controllerContainer);
      await docker(["kill", "--signal=SIGKILL", controllerContainer], true);
      console.log(
        JSON.stringify({
          proof_loss_recovery_fault_stage: "controller_killed",
        }),
      );
      await docker(
        [
          "exec",
          postgres,
          "psql",
          "-XAt",
          "-v",
          "ON_ERROR_STOP=1",
          "-U",
          "antnest_test_admin",
          "-d",
          "antnest_agent_controller",
          "-c",
          "DROP TRIGGER hold_test_recovery_receipt ON agent_controller.legacy_proof_loss_recoveries; DROP FUNCTION agent_controller.hold_test_recovery_receipt();",
        ],
        true,
      );
      console.log(
        JSON.stringify({
          proof_loss_recovery_fault_stage: "receipt_hold_removed",
        }),
      );
      await recreateController();
    }
    let recovered;
    for (let attempt = 0; attempt < 180; attempt++) {
      recovered = await control(
        controller,
        `/internal/agent-operations/${recoveryID}?organization_id=${login.principal.organization_id}`,
      );
      if (recovered.state === "completed") break;
      assert.equal(
        recovered.state,
        "running",
        `proof-loss recovery: ${JSON.stringify(recovered)}`,
      );
      await delay(500, undefined, { signal: abort.signal });
    }
    assert.equal(
      recovered?.state,
      "completed",
      `proof-loss recovery did not settle: ${JSON.stringify(recovered)}`,
    );
    assert.equal(recovered.phase, "done");
    assert.match(recovered.disabled_runtime_revision, /^rtv_[0-9a-f]{32}$/);
    const recoveryTraceID = await docker(
      [
        "exec",
        postgres,
        "psql",
        "-XAt",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "antnest_test_admin",
        "-d",
        "antnest_agent_controller",
        "-c",
        `SELECT trace_id FROM agent_controller.agent_events WHERE operation_request_id='${recoveryID}' AND event_type='agent_legacy_proof_loss_recovered'`,
      ],
      true,
    );
    assert.match(recoveryTraceID, /^[a-f0-9]{32}$/);
    let recoveryTrace;
    const traceEvidence = join(
      "artifacts",
      "verification",
      "skill-registry",
      config.project,
    );
    let recoveryTraceTopology;
    try {
      recoveryTraceTopology = await collectTrace(
        config.jaeger,
        recoveryTraceID,
        (trace) => {
          recoveryTrace = trace;
          return (
            recoveryCrash
              ? inspectLegacyProofLossCrashDiagnostic
              : inspectLegacyProofLossRecoveryTrace
          )(trace, {
            traceID: recoveryTraceID,
            secrets: [
              "stage3-admin-password",
              "legacy-owner-password",
              "stage3-model-secret",
              "Legacy shared Skill awaiting migration",
              attestation.signature,
            ],
          });
        },
        abort.signal,
      );
    } finally {
      if (recoveryTrace) {
        await mkdir(traceEvidence, { recursive: true, mode: 0o700 });
        await writeFile(
          join(traceEvidence, `${recoveryTraceID}.json`),
          JSON.stringify(recoveryTrace),
          { mode: 0o600 },
        );
        const spanIDs = new Set(recoveryTrace.spans.map((span) => span.spanID));
        const missing = recoveryTrace.spans.flatMap((span) =>
          (span.references ?? [])
            .filter(
              (ref) => ref.refType === "CHILD_OF" && !spanIDs.has(ref.spanID),
            )
            .map((ref) => ({
              name: span.operationName,
              service: recoveryTrace.processes?.[span.processID]?.serviceName,
              missing_parent_id: ref.spanID,
            })),
        );
        if (missing.length)
          console.log(
            JSON.stringify({ recovery_trace_missing_parents: missing }),
          );
      }
    }
    console.log(
      JSON.stringify({ recovery_trace_topology: recoveryTraceTopology }),
    );
    if (!recoveryCrash) await recreateController();
    const recoveryReplay = await control(controller, recoveryPath, {
      method: "POST",
      status: 200,
      idempotencyKey: recoveryID,
      body: recoveryBody,
    });
    assert.deepEqual(recoveryReplay, recovered);
    const disabledFaultAgent = await control(
      controller,
      `/internal/agents/${faultAgentID}?organization_id=${login.principal.organization_id}`,
    );
    assert.equal(disabledFaultAgent.activation_state, "disabled");
    assert.equal(disabledFaultAgent.runtime_state, "absent");
    assert.equal(
      disabledFaultAgent.runtime?.runtime_revision,
      recovered.disabled_runtime_revision,
    );
    assert.equal(disabledFaultAgent.failure_code ?? "", "");
    const pendingAfterRecovery = await control(
      controller,
      `/internal/agents/${faultAgentID}/legacy-system-skills-migration?organization_id=${login.principal.organization_id}`,
    );
    assert.equal(pendingAfterRecovery.migration.state, "pending");
    const closedAfterRecovery = JSON.parse(
      await docker(
        [
          "run",
          "--rm",
          "--network",
          `${config.project}_control`,
          "node:24.21.0-bookworm-slim",
          "node",
          "-e",
          networkProbe,
          `http://${config.env.ANTNEST_EGRESS_CONTROL_IPV4}:8081/internal/agent-networks/${faultAgentID}`,
        ],
        true,
      ),
    );
    assert.equal(closedAfterRecovery.attachment_state, "closed");
    await docker(["volume", "inspect", faultWorkspace.Name], true);
    await docker(["volume", "inspect", faultSkills.Name], true);
    const nextKeyPath = join(verifierDirectory, "next-key.pem");
    await writeFile(
      nextKeyPath,
      nextPrivateKey.export({ type: "pkcs8", format: "pem" }),
      { mode: 0o600 },
    );
    const nextAttestArgs = attestArgs.map((arg) =>
      arg ===
      `type=bind,source=${keyPath},target=/run/verifier-key.pem,readonly`
        ? `type=bind,source=${nextKeyPath},target=/run/verifier-key.pem,readonly`
        : arg === "--key-id=stage4-test-key"
          ? "--key-id=stage4-next-key"
          : arg,
    );
    const nextAttestation = JSON.parse(await docker(nextAttestArgs, true));
    assert.equal(nextAttestation.key_id, "stage4-next-key");
    const afterRecoveryID = randomUUID();
    const afterRecovery = await control(
      controller,
      `/internal/agents/${faultAgentID}/legacy-system-skills-migration/operations`,
      {
        method: "POST",
        status: 202,
        idempotencyKey: afterRecoveryID,
        body: {
          ...migrationBody,
          choice_sequence: faultChoice.sequence,
          attestation: nextAttestation,
        },
      },
    );
    assert.equal(
      afterRecovery.kind,
      "enable",
      "recovered Agent must use controlled Enable",
    );
    await waitOperation(admin, afterRecoveryID);
    const resolvedAfterRecovery = await control(
      controller,
      `/internal/agents/${faultAgentID}/legacy-system-skills-migration?organization_id=${login.principal.organization_id}`,
    );
    assert.equal(resolvedAfterRecovery.migration.state, "resolved");
    const missingCreated = (
      await admin.request("/api/admin/agents", {
        status: 202,
        body: {
          owner_user_id: owner.user.id,
          name: "Legacy missing-target Agent",
          template_id: template.template_id,
          template_revision: template.revision,
        },
      })
    ).body;
    const missingAgentID = missingCreated.agent.agent_id;
    await waitOperation(admin, missingCreated.operation.request_id);
    await docker([
      "exec",
      postgres,
      "psql",
      "-XAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "antnest_test_admin",
      "-d",
      "antnest_agent_controller",
      "-c",
      `INSERT INTO agent_controller.legacy_system_skills_migrations(agent_id,organization_id,state) VALUES ('${missingAgentID}','${login.principal.organization_id}','pending')`,
    ]);
    const missingChoice = await control(
      controller,
      `/internal/agents/${missingAgentID}/legacy-system-skills-migration/choices`,
      {
        method: "POST",
        status: 201,
        idempotencyKey: randomUUID(),
        body,
      },
    );
    const missingMigrationID = randomUUID();
    const revokeNextAtPublish = `CREATE FUNCTION agent_controller.revoke_test_next_key_at_publish() RETURNS trigger
      LANGUAGE plpgsql AS $migration$ BEGIN
        UPDATE agent_controller.legacy_export_verifier_keys SET revoked_at=clock_timestamp()
        WHERE key_id='stage4-next-key' AND revoked_at IS NULL;
        RETURN NEW;
      END $migration$;
      CREATE TRIGGER revoke_test_next_key_at_publish AFTER UPDATE OF phase
      ON agent_controller.agent_lifecycle_operations FOR EACH ROW
      WHEN (NEW.phase='publish' AND NEW.request_id='${missingMigrationID}')
      EXECUTE FUNCTION agent_controller.revoke_test_next_key_at_publish();`;
    await docker([
      "exec",
      postgres,
      "psql",
      "-XAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "antnest_test_admin",
      "-d",
      "antnest_agent_controller",
      "-c",
      revokeNextAtPublish,
    ]);
    await control(
      controller,
      `/internal/agents/${missingAgentID}/legacy-system-skills-migration/operations`,
      {
        method: "POST",
        status: 202,
        idempotencyKey: missingMigrationID,
        body: {
          ...migrationBody,
          choice_sequence: missingChoice.sequence,
          attestation: nextAttestation,
        },
      },
    );
    await waitFailedOperation(
      admin,
      missingMigrationID,
      "legacy_migration_proof_lost",
    );
    await docker(["rm", "-f", `antnest-runtime-${missingAgentID}`], true);
    const missingRecovery = await control(
      controller,
      `/internal/agents/${missingAgentID}/legacy-system-skills-migration/proof-loss-recovery`,
      {
        method: "POST",
        status: 409,
        idempotencyKey: randomUUID(),
        body: {
          organization_id: login.principal.organization_id,
          actor_principal_id: login.principal.user_id,
          failed_migration_request_id: missingMigrationID,
        },
      },
    );
    assert.equal(
      missingRecovery.code,
      "legacy_migration_manual_recovery_required",
    );
    const missingReview = await control(
      controller,
      `/internal/agents/${missingAgentID}/legacy-system-skills-migration?organization_id=${login.principal.organization_id}`,
    );
    assert.equal(missingReview.migration.state, "pending");
    const missingNetwork = JSON.parse(
      await docker(
        [
          "run",
          "--rm",
          "--network",
          `${config.project}_control`,
          "node:24.21.0-bookworm-slim",
          "node",
          "-e",
          networkProbe,
          `http://${config.env.ANTNEST_EGRESS_CONTROL_IPV4}:8081/internal/agent-networks/${missingAgentID}`,
        ],
        true,
      ),
    );
    assert.equal(missingNetwork.attachment_state, "closed");
    const staleSource = await control(
      rc,
      `/internal/runtimes/${missingAgentID}`,
    );
    const replacementPreparationID = randomUUID();
    const replacementOwner = `legacy-choice-e2e-replacement-${missingAgentID}`;
    const replacementPreparationBody = {
      organization_id: login.principal.organization_id,
      owner_operation_id: replacementOwner,
      layout_version: 1,
      skill_set_digest: emptySetDigest,
      system_skills: [],
    };
    let replacementPreparation = await control(
      rc,
      `/internal/runtimes/${missingAgentID}/skill-sets/prepare`,
      {
        method: "POST",
        status: 202,
        idempotencyKey: replacementPreparationID,
        body: replacementPreparationBody,
      },
    );
    for (
      let attempt = 0;
      replacementPreparation.state !== "ready" && attempt < 180;
      attempt++
    ) {
      assert(
        ["queued", "preparing", "retry_wait"].includes(
          replacementPreparation.state,
        ),
        `replacement Skill preparation: ${JSON.stringify(replacementPreparation)}`,
      );
      await delay(500, undefined, { signal: abort.signal });
      replacementPreparation = await control(
        rc,
        `/internal/runtimes/${missingAgentID}/skill-sets/preparations/${replacementPreparationID}?organization_id=${login.principal.organization_id}`,
      );
    }
    assert.equal(replacementPreparation.state, "ready");
    const replacementID = randomUUID();
    const replacement = await control(
      rc,
      `/internal/runtimes/${missingAgentID}/update`,
      {
        method: "POST",
        status: [200, 202],
        idempotencyKey: replacementID,
        body: {
          expected_revision: staleSource.runtime_revision,
          configuration: {
            image_ref: config.image,
            network: {
              packet_contract_revision: missingNetwork.packet_contract_revision,
              egress_endpoint: missingNetwork.egress_endpoint,
              tunnel_ipv4: missingNetwork.tunnel_ipv4,
              resolver_ipv4: missingNetwork.resolver_ipv4,
            },
            resources: {
              memory_bytes: 536870912,
              pids_limit: 256,
              tmpfs_bytes: 67108864,
            },
            organization_id: login.principal.organization_id,
            system_skills: [],
            prepared_skill_set: replacementPreparation.prepared_skill_set,
            prepared_reference_id: replacementPreparation.prepared_reference_id,
          },
        },
      },
    );
    assert.equal(replacement.request_id, replacementID);
    let settledReplacement;
    for (let attempt = 0; attempt < 180; attempt++) {
      settledReplacement = await control(
        rc,
        `/internal/runtime-operations/${replacementID}`,
      );
      if (settledReplacement.state === "completed") break;
      assert.equal(
        settledReplacement.state,
        "running",
        `out-of-band RC Update: ${JSON.stringify(settledReplacement)}`,
      );
      await delay(500, undefined, { signal: abort.signal });
    }
    assert.equal(settledReplacement?.state, "completed");
    const driftedRuntime = await control(
      rc,
      `/internal/runtimes/${missingAgentID}`,
    );
    assert.notEqual(
      driftedRuntime.runtime_revision,
      staleSource.runtime_revision,
    );
    assert.equal(driftedRuntime.lifecycle_state, "provisioned");
    assert.equal(driftedRuntime.phase, "running");
    await docker(["inspect", `antnest-runtime-${missingAgentID}`], true);
    const driftRecovery = await control(
      controller,
      `/internal/agents/${missingAgentID}/legacy-system-skills-migration/proof-loss-recovery`,
      {
        method: "POST",
        status: 409,
        idempotencyKey: randomUUID(),
        body: {
          organization_id: login.principal.organization_id,
          actor_principal_id: login.principal.user_id,
          failed_migration_request_id: missingMigrationID,
        },
      },
    );
    assert.equal(
      driftRecovery.code,
      "legacy_migration_manual_recovery_required",
    );
    const replacementAfterRejection = await control(
      rc,
      `/internal/runtimes/${missingAgentID}`,
    );
    assert.equal(
      replacementAfterRejection.runtime_revision,
      driftedRuntime.runtime_revision,
    );
    assert.equal(replacementAfterRejection.lifecycle_state, "provisioned");
    assert.equal(replacementAfterRejection.phase, "running");
    const markerAfterRejection = await control(
      controller,
      `/internal/agents/${missingAgentID}/legacy-system-skills-migration?organization_id=${login.principal.organization_id}`,
    );
    assert.equal(markerAfterRejection.migration.state, "pending");
    const networkAfterRejection = JSON.parse(
      await docker(
        [
          "run",
          "--rm",
          "--network",
          `${config.project}_control`,
          "node:24.21.0-bookworm-slim",
          "node",
          "-e",
          networkProbe,
          `http://${config.env.ANTNEST_EGRESS_CONTROL_IPV4}:8081/internal/agent-networks/${missingAgentID}`,
        ],
        true,
      ),
    );
    assert.equal(networkAfterRejection.attachment_state, "closed");
    console.log(
      JSON.stringify({
        status: "legacy_migration_local_mechanics_passed",
        project: config.project,
        disabled_operation_kind: migration.kind,
        enabled_operation_kind: enabledMigration.kind,
        markers_resolved: true,
        active_skill_mount_verified: true,
        fixed_template_skill_loaded: true,
        post_migration_acp_run: true,
        revoked_proof_fenced_and_quarantined: true,
        proof_loss_recovered_to_disabled: true,
        retained_workspace_and_skills: true,
        controller_restart_replay: true,
        unknown_disable_reconciled: recoveryCrash,
        recovery_trace_topology: !recoveryCrash,
        competing_recovery_rejected: recoveryCrash,
        changed_process_same_revision_recovered: true,
        missing_target_requires_manual_recovery: true,
        live_replacement_revision_rejected: true,
        fresh_proof_controlled_enable: true,
        invalid_proof_rejected: true,
        stale_choice_rejected: true,
      }),
    );
  } else {
    console.log(
      JSON.stringify({
        status: "legacy_choice_passed",
        project: config.project,
        backup_verified: true,
        copy_verified: true,
        attestation_mechanics_verified: true,
        verifier_key_registered: true,
        active_skill_mount_verified: true,
        invalid_rejected: true,
        missing_rejected: true,
        choice_replayed: true,
        gate_pending: true,
      }),
    );
  }
} finally {
  clearTimeout(timer);
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  try {
    if (config) await cleanup(config);
  } finally {
    if (exportDirectory)
      await rm(exportDirectory, { recursive: true, force: true });
    if (verifierDirectory)
      await rm(verifierDirectory, { recursive: true, force: true });
  }
}
