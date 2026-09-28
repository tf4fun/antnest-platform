import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { lines } from "./docker.mjs";

async function legacyControl(
  config,
  docker,
  path,
  { method = "GET", body, status = 200 } = {},
) {
  const container = lines(
    await docker(config.compose(["ps", "-q", "stage3-model"])),
  )[0];
  assert(container, "internal legacy backup client is unavailable");
  const script = `const [path,method,body,key]=process.argv.slice(1);fetch("http://runtime-controller:8080"+path,{method,headers:{...(body?{"Content-Type":"application/json"}:{}),...(key?{"Idempotency-Key":key}:{})},body:body||undefined,signal:AbortSignal.timeout(30000)}).then(async response=>{console.log(JSON.stringify({status:response.status,body:await response.json()}))}).catch(error=>{console.error(error);process.exitCode=1})`;
  const response = JSON.parse(
    await docker(
      [
        "exec",
        container,
        "node",
        "-e",
        script,
        path,
        method,
        body ? JSON.stringify(body) : "",
        body ? randomUUID() : "",
      ],
      true,
    ),
  );
  assert.equal(response.status, status, `legacy backup ${method} ${path}`);
  return response.body;
}

function hash(bytes) {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

async function exportBackup(config, docker, destination, receipt) {
  const result = JSON.parse(
    await docker(
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--read-only",
        "--mount",
        `type=volume,source=${config.env.ANTNEST_RUNTIME_LEGACY_BACKUP_VOLUME},target=/backup,readonly`,
        "--mount",
        `type=bind,source=${destination},target=/export`,
        "--entrypoint",
        "/usr/local/bin/legacy-backup-export",
        "antnest/runtime-controller:local",
        "--source=/backup",
        "--destination=/export",
        `--backup-ref=${receipt.backup_ref}`,
        `--volume-name=${receipt.volume_name}`,
        `--manifest-digest=${receipt.manifest_digest}`,
      ],
      true,
    ),
  );
  assert.equal(result.status, "copy_verified");
  for (const name of [
    "backup_ref",
    "inventory_digest",
    "archive_digest",
    "manifest_digest",
  ])
    assert.equal(result[name], receipt[name]);
  const root = join(destination, receipt.backup_ref);
  assert.equal(
    hash(await readFile(join(root, "archive.tar"))),
    receipt.archive_digest,
  );
  assert.equal(
    hash(await readFile(join(root, "manifest.json"))),
    receipt.manifest_digest,
  );
  assert.equal(
    await readFile(join(root, "receipt.sha256"), "utf8"),
    `${receipt.manifest_digest}\n`,
  );
  return root;
}

export async function createLegacyExportFixture(
  config,
  docker,
  directory,
  volumeName,
) {
  const inventory = await legacyControl(
    config,
    docker,
    "/internal/legacy-system-skills/inventory",
  );
  assert.equal(inventory.volume_name, volumeName);
  assert(inventory.entries.length > 0, "legacy shared volume fixture is empty");
  const receipt = await legacyControl(
    config,
    docker,
    "/internal/legacy-system-skills/backups",
    {
      method: "POST",
      status: 201,
      body: { expected_inventory_digest: inventory.inventory_digest },
    },
  );
  assert.equal(receipt.volume_name, volumeName);
  assert.equal(receipt.inventory_digest, inventory.inventory_digest);
  const destination = join(directory, "operator-export");
  await mkdir(destination, { mode: 0o700 });
  await chmod(destination, 0o700);
  await exportBackup(config, docker, destination, receipt);
  return receipt;
}

export async function assertRestoredLegacyExport(
  config,
  docker,
  directory,
  original,
) {
  const recovered = await legacyControl(
    config,
    docker,
    `/internal/legacy-system-skills/backups/${original.backup_ref}`,
  );
  assert.deepEqual(recovered, original, "restored RC backup receipt changed");
  const destination = join(directory, "restored-operator-export");
  await mkdir(destination, { mode: 0o700 });
  await chmod(destination, 0o700);
  const restoredRoot = await exportBackup(
    config,
    docker,
    destination,
    recovered,
  );
  const originalRoot = join(directory, "operator-export", original.backup_ref);
  for (const name of ["archive.tar", "manifest.json", "receipt.sha256"])
    assert.deepEqual(
      await readFile(join(restoredRoot, name)),
      await readFile(join(originalRoot, name)),
      `restored legacy export differs: ${name}`,
    );
  return {
    backup_ref: recovered.backup_ref,
    manifest_digest: recovered.manifest_digest,
  };
}
