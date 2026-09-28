import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { skillVolumeInventory } from "./restore-storage.mjs";

const container = `antnest-skill-restore-inventory-${randomBytes(5).toString("hex")}`;
const docker = async (args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
async function eventually(action) {
  let lastError;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError;
}
let started = false;
function stop() {
  if (started)
    execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" });
  started = false;
}
const interrupt = () => {
  stop();
  process.exit(130);
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
try {
  await docker([
    "run",
    "-d",
    "--name",
    container,
    "--network",
    "none",
    "-e",
    "POSTGRES_USER=antnest_test_admin",
    "-e",
    "POSTGRES_PASSWORD=inventory-test-only",
    "postgres:17.11-bookworm",
  ]);
  started = true;
  await eventually(() =>
    docker([
      "exec",
      container,
      "createdb",
      "-U",
      "antnest_test_admin",
      "antnest_runtime_controller",
    ]),
  );
  await eventually(() =>
    docker([
      "exec",
      container,
      "psql",
      "-XAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "antnest_test_admin",
      "-d",
      "antnest_runtime_controller",
      "-c",
      `
    CREATE SCHEMA runtime_controller;
    CREATE TABLE runtime_controller.skill_sets (set_id bigint, volume_name text, manifest_digest text);
    CREATE TABLE runtime_controller.skill_current_references (set_id bigint, volume_name text, manifest_digest text);
    CREATE TABLE runtime_controller.skill_lifecycle_references (set_id bigint, volume_name text, manifest_digest text);
    INSERT INTO runtime_controller.skill_sets VALUES (1, 'skill-new', 'sha256:${"a".repeat(64)}'), (2, 'skill-candidate', '');
    INSERT INTO runtime_controller.skill_current_references VALUES (1, 'skill-new', 'sha256:${"a".repeat(64)}');
    INSERT INTO runtime_controller.skill_lifecycle_references VALUES (1, 'skill-old', 'sha256:${"b".repeat(64)}');
  `,
    ]),
  );
  assert.deepEqual(
    await eventually(() => skillVolumeInventory(docker, container)),
    ["skill-candidate", "skill-new", "skill-old"],
  );
  console.log(
    JSON.stringify({
      status: "passed",
      database: "antnest_runtime_controller",
      physical_skill_volumes: 3,
    }),
  );
} finally {
  stop();
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
