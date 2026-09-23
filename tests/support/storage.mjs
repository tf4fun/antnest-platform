import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  realpathSync,
  lstatSync,
  statSync,
  mkdirSync,
  readdirSync,
  constants,
  openSync,
  fstatSync,
  ftruncateSync,
  fchmodSync,
  writeFileSync,
  closeSync,
} from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

// Evidence, baselines and recovery inputs must survive deletion of build caches.
export function durablePath(value) {
  assert(typeof value === "string" && value.length, "durable path is required");
  const absolute = resolve(value);
  const allowed = (path) => !path.split(sep).includes(".cache");
  assert(allowed(absolute), "durable files must not use .cache");
  let ancestor = absolute;
  while (!optionalLstat(ancestor) && dirname(ancestor) !== ancestor)
    ancestor = dirname(ancestor);
  assert(
    allowed(realpathSync(ancestor)),
    "durable files must not use a cache alias",
  );
  return absolute;
}

export function temporaryStorageRoot() {
  return durablePath(tmpdir());
}

// Shell redirections and docker cp do not use writeEvidenceFile. Inspect
// existing output leaves before those commands can follow a cached alias.
export function shellStoragePreflight(value) {
  temporaryStorageRoot();
  function inspect(value) {
    const path = durablePath(value);
    const row = optionalLstat(path);
    if (!row) return;
    assert(!row.isSymbolicLink(), "evidence tree must not contain links");
    if (row.isDirectory())
      for (const name of readdirSync(path)) inspect(resolve(path, name));
    else
      assert(
        row.isFile() && row.nlink === 1,
        "evidence must be a regular file with one link",
      );
  }
  inspect(value);
}

function optionalLstat(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

export function evidenceDirectory(value) {
  if (value === undefined || value === "") return undefined;
  const directory = durablePath(value);
  if (optionalLstat(directory))
    assert(
      statSync(directory).isDirectory(),
      "evidence output must be a directory",
    );
  return directory;
}

export function evidenceFilePath(directory, name) {
  directory = evidenceDirectory(directory);
  if (!directory) return undefined;
  assert(
    typeof name === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(name),
    "invalid evidence filename",
  );
  const file = durablePath(resolve(directory, name));
  const row = optionalLstat(file);
  assert(
    !row || row.isFile(),
    "evidence output must be a regular file, not a link",
  );
  return file;
}

// Collectors may update their regular raw snapshots; aliases and special files reject.
export function writeEvidenceFile(directory, name, contents) {
  const file = evidenceFilePath(directory, name);
  if (!file) return;
  mkdirSync(evidenceDirectory(directory), { recursive: true, mode: 0o700 });
  const fd = openSync(
    evidenceFilePath(directory, name),
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
    0o600,
  );
  try {
    assert(fstatSync(fd).isFile(), "evidence output must be a regular file");
    fchmodSync(fd, 0o600);
    ftruncateSync(fd, 0);
    writeFileSync(fd, contents);
  } finally {
    closeSync(fd);
  }
}

export function readConfiguration(file) {
  const config = JSON.parse(readFileSync(durablePath(file), "utf8"));
  config.output = durablePath(config.output);
  for (const key of [
    "envFile",
    "secretFile",
    "browserReport",
    "metadataReport",
    "restartSnapshot",
    "composeSnapshot",
    "workspaceManifest",
  ])
    if (config[key]) config[key] = durablePath(config[key]);
  return config;
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
)
  shellStoragePreflight(process.argv[2]);
