import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../../../", import.meta.url);
const json = async (path) =>
  JSON.parse(await readFile(new URL(path, root), "utf8"));

test("released Runtime Controller contract has no legacy Skill migration routes or errors", async () => {
  const contract = await json(
    "services/runtime-controller/api/control-contract.json",
  );
  assert.deepEqual(
    contract.routes.filter((route) =>
      route.path.includes("legacy-system-skills"),
    ),
    [],
  );
  assert.deepEqual(
    Object.keys(contract.errors).filter((code) => code.startsWith("legacy_")),
    [],
  );
  assert(
    !contract.routes.some((route) =>
      route.path.endsWith("/skill-sets/verify-active"),
    ),
  );
  assert(
    contract.routes.some((route) => route.path.endsWith("/skill-sets/prepare")),
  );
});

test("released Controller contract has no legacy Skill migration resources or errors", async () => {
  const contract = await json(
    "contracts/agent-controller/control-contract.json",
  );
  assert.deepEqual(
    Object.keys(contract.resources).filter((key) => key.startsWith("legacy_")),
    [],
  );
  assert(!JSON.stringify(contract.errors).includes("legacy_"));
  assert(contract.resources.agents);
});

for (const path of [
  "services/runtime-controller/api/control-api.schema.json",
  "contracts/agent-controller/control-api.schema.json",
]) {
  test(`${path} exports no retired legacy Skill DTOs`, async () => {
    const schema = await json(path);
    assert.deepEqual(
      Object.keys(schema.$defs).filter((key) => key.startsWith("legacy_")),
      [],
    );
    assert(!JSON.stringify(schema).includes("#/$defs/legacy_"));
  });
}

test("Runtime Controller release image excludes legacy maintenance executables", async () => {
  const dockerfile = await readFile(
    new URL("services/runtime-controller/Dockerfile", root),
    "utf8",
  );
  assert(!dockerfile.includes("legacy-backup-export"));
  assert(!dockerfile.includes("legacy-backup-attest"));
  assert(dockerfile.includes("/out/runtime-controller"));
});

test("ordinary deployment has no legacy backup storage or verifier configuration", async () => {
  const compose = await readFile(new URL("compose.yaml", root), "utf8");
  assert(!compose.includes("runtime-legacy-backups"));
  assert(!compose.includes("ANTNEST_RUNTIME_LEGACY_BACKUP_ROOT"));
  assert(
    !compose.includes("ANTNEST_AGENT_CONTROLLER_LEGACY_EXPORT_VERIFIER_KEYS"),
  );
});

test("published Skill contracts exclude retired migration and recovery documents", async () => {
  const files = await readdir(new URL("contracts/skill-registry/", root));
  assert.deepEqual(
    files.filter(
      (name) =>
        name.startsWith("legacy-") ||
        name === "active-skill-set-verification.md",
    ),
    [],
  );
});
