import { chmodSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const outputRoots = {
  tokens: ["artifacts/service-authentication", "artifacts/verification"],
  pki: ["artifacts/dev-pki", "artifacts/verification"],
};

function optionalStat(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function within(base, path) {
  const child = relative(base, path);
  return (
    child === "" ||
    (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`))
  );
}

export function validatePrivateOutput(value, profile = "tokens") {
  if (
    !Object.hasOwn(outputRoots, profile) ||
    typeof value !== "string" ||
    value.length === 0 ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) < 32 ||
        character.charCodeAt(0) === 127 ||
        "'\"\\$`".includes(character),
    )
  )
    throw new Error("output_invalid");
  const path = resolve(value);
  if (
    path.split(sep).includes(".cache") ||
    !outputRoots[profile].some((base) => within(resolve(root, base), path))
  )
    throw new Error("output_invalid");
  if (optionalStat(path)) throw new Error("output_exists");
  for (let ancestor = dirname(path); ; ancestor = dirname(ancestor)) {
    const row = optionalStat(ancestor);
    if (row && (!row.isDirectory() || row.isSymbolicLink()))
      throw new Error("output_invalid");
    if (dirname(ancestor) === ancestor) break;
  }
  return path;
}

export function createPrivateDirectory(path) {
  mkdirSync(path, { mode: 0o700 });
  chmodSync(path, 0o700);
}

export function createPrivateParents(path) {
  const missing = [];
  for (
    let ancestor = path;
    !optionalStat(ancestor);
    ancestor = dirname(ancestor)
  )
    missing.push(ancestor);
  for (const ancestor of missing.reverse()) createPrivateDirectory(ancestor);
}

export function writePrivateFile(path, contents) {
  writeFileSync(path, contents, { flag: "wx", mode: 0o600 });
  chmodSync(path, 0o600);
}
