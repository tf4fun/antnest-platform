import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = new URL("../../../", import.meta.url);
const require = createRequire(
  new URL("services/agent-acp-service/package.json", root),
);
const { parse } = require("yaml");
const compose = parse(readFileSync(new URL("compose.yaml", root), "utf8"));
const dotenv = readFileSync(new URL(".env.example", root), "utf8");
const backupDoc = readFileSync(
  new URL("docs/docker-backup-restore.md", root),
  "utf8",
);
const operationsDoc = readFileSync(
  new URL("docs/docker-single-node-operations.md", root),
  "utf8",
);
const docs = `${backupDoc}\n${operationsDoc}`;

test("compose interpolates the settled ACP retention configuration", () => {
  const environment = compose.services["agent-acp-service"].environment;
  assert.equal(
    environment.ANTNEST_ACP_DELETED_SESSION_RETENTION,
    "${ANTNEST_ACP_DELETED_SESSION_RETENTION:-30d}",
  );
  assert.equal(
    environment.ANTNEST_ACP_PURGE_BATCH,
    "${ANTNEST_ACP_PURGE_BATCH:-500}",
  );
  assert.equal(
    environment.ANTNEST_ACP_PURGE_INTERVAL,
    "${ANTNEST_ACP_PURGE_INTERVAL:-60s}",
  );
});

test("env example pins retention defaults exactly once", () => {
  const assignments = dotenv
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[A-Z][A-Z0-9_]*=/u.test(line));
  const keys = assignments.map((line) => line.split("=")[0]);
  assert.equal(keys.length, new Set(keys).size, "duplicate env vars");
  assert.ok(
    keys.includes("ANTNEST_ACP_DELETED_SESSION_RETENTION=30d".split("=")[0]),
  );
  assert.match(dotenv, /^ANTNEST_ACP_DELETED_SESSION_RETENTION=30d$/mu);
  assert.match(dotenv, /^ANTNEST_ACP_PURGE_BATCH=500$/mu);
  assert.match(dotenv, /^ANTNEST_ACP_PURGE_INTERVAL=60s$/mu);
});

test("operations docs describe the retention and erasure boundaries", () => {
  for (const name of [
    "ANTNEST_ACP_DELETED_SESSION_RETENTION",
    "ANTNEST_ACP_PURGE_BATCH",
    "ANTNEST_ACP_PURGE_INTERVAL",
  ])
    assert.ok(docs.includes(name), name);
  for (const flag of [
    "--dry-run",
    "--confirm",
    "--session",
    "--user",
    "--organization",
  ])
    assert.ok(docs.includes(flag), flag);
  assert.match(docs, /deleted_at/u);
  assert.match(docs, /0 disables|disabled/u);
  assert.match(
    docs,
    /restore[\s\S]{0,400}reintroduc|reintroduc[\s\S]{0,400}restore/iu,
  );
  assert.match(docs, /architecture\.md#persistence|architecture\.md/u);
  assert.match(docs, /data-retention\.md/u);
  assert.match(docs, /accounting|budget/iu);
  assert.match(docs, /tombstone|published/u);
  assert.match(docs, /exclusive|lock/iu);
});

test("the built image carries the compiled purge entrypoint", () => {
  const service = fileURLToPath(new URL("services/agent-acp-service/", root));
  const dockerfile = readdirSync(service).find((name) =>
    /dockerfile/iu.test(name),
  );
  assert.ok(dockerfile, "service Dockerfile");
  const body = readFileSync(`${service}${dockerfile}`, "utf8");
  assert.match(body, /dist/u);
  assert.ok(existsSync(`${service}src/purge.ts`));
});
