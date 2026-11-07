import { execFileSync } from "node:child_process";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const annotations = new Set([
  "$comment",
  "title",
  "description",
  "examples",
  "default",
  "deprecated",
  "readOnly",
  "writeOnly",
]);
const schemaChildren = new Set([
  "items",
  "contains",
  "additionalProperties",
  "unevaluatedProperties",
  "unevaluatedItems",
  "propertyNames",
  "if",
  "then",
  "else",
  "not",
]);
const schemaArrays = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const pointer = (key) => key.replace(/~/g, "~0").replace(/\//g, "~1");

export function compatibilityProblems(before, after, label = "schema") {
  const problems = [];
  const reject = (path) =>
    problems.push(
      `${label}${path}: preserve N-1; publish a new version instead`,
    );
  function compare(old, next, path) {
    if (isDeepStrictEqual(old, next)) return;
    if (!object(old) || !object(next)) {
      reject(path);
      return;
    }
    for (const key of new Set([...Object.keys(old), ...Object.keys(next)])) {
      if (annotations.has(key)) continue;
      const at = `${path}/${pointer(key)}`;
      const a = old[key];
      const b = next[key];
      if (key === "properties" || key === "$defs") {
        if (!object(b) || (a !== undefined && !object(a))) {
          reject(at);
          continue;
        }
        for (const name of Object.keys(a ?? {})) {
          if (!Object.hasOwn(b, name)) reject(`${at}/${pointer(name)}`);
          else compare(a[name], b[name], `${at}/${pointer(name)}`);
        }
        if (key === "properties")
          for (const name of Object.keys(b))
            if (
              !Object.hasOwn(a ?? {}, name) &&
              (next.required ?? []).includes(name)
            )
              reject(`${at}/${pointer(name)}`);
        continue;
      }
      if (!Object.hasOwn(old, key) || !Object.hasOwn(next, key)) {
        reject(at);
        continue;
      }
      if (key === "required" && Array.isArray(a) && Array.isArray(b)) {
        if (!isDeepStrictEqual([...a].sort(), [...b].sort())) reject(at);
      } else if (schemaChildren.has(key)) {
        compare(a, b, at);
      } else if (
        schemaArrays.has(key) &&
        Array.isArray(a) &&
        Array.isArray(b) &&
        a.length === b.length
      ) {
        a.forEach((entry, index) => compare(entry, b[index], `${at}/${index}`));
      } else if (key === "patternProperties" || key === "dependentSchemas") {
        if (
          !object(a) ||
          !object(b) ||
          !isDeepStrictEqual(Object.keys(a).sort(), Object.keys(b).sort())
        )
          reject(at);
        else
          for (const name of Object.keys(a))
            compare(a[name], b[name], `${at}/${pointer(name)}`);
      } else if (!isDeepStrictEqual(a, b)) {
        reject(at);
      }
    }
  }
  compare(before, after, "");
  return problems;
}

const root = fileURLToPath(new URL("../", import.meta.url));
const git = (...args) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
const RC_LEGACY_PREFIX = "services/runtime-controller/api/";
const RC_CANONICAL_PREFIX = "contracts/runtime-controller/";

const schemaPath = (path) =>
  path.endsWith(".schema.json") &&
  (path.startsWith("contracts/") || path.startsWith(RC_LEGACY_PREFIX));

export function schemaRevisionProblems(before, after) {
  const problems = [];
  for (const path of [...before.keys()].sort()) {
    const oldDoc = before.get(path);
    let target = path;
    if (!after.has(target) && path.startsWith(RC_LEGACY_PREFIX)) {
      const moved = RC_CANONICAL_PREFIX + path.slice(RC_LEGACY_PREFIX.length);
      const newDoc = after.get(moved);
      if (
        newDoc !== undefined &&
        typeof oldDoc?.$id === "string" &&
        oldDoc.$id.length > 0 &&
        oldDoc.$id === newDoc.$id
      ) {
        target = moved;
      }
    }
    if (!after.has(target)) {
      problems.push(`${path}: N-1 schema removed`);
      continue;
    }
    problems.push(...compatibilityProblems(oldDoc, after.get(target), path));
  }
  return problems;
}

export function checkRevisions(base, head) {
  const collect = (tree) =>
    new Map(
      git("ls-tree", "-r", "--name-only", tree)
        .split("\n")
        .filter(schemaPath)
        .map((path) => [path, JSON.parse(git("show", `${tree}:${path}`))]),
    );
  return schemaRevisionProblems(collect(base), collect(head));
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values } = parseArgs({
    options: { base: { type: "string" }, head: { type: "string" } },
  });
  if (!values.base || !values.head) {
    console.error(
      "usage: check-contract-compatibility.mjs --base REV --head REV",
    );
    process.exitCode = 2;
  } else {
    const base = git("rev-parse", "--verify", `${values.base}^{commit}`).trim();
    const head = git("rev-parse", "--verify", `${values.head}^{commit}`).trim();
    const problems = checkRevisions(base, head);
    for (const problem of problems) console.error(problem);
    console.log(`contract N-1 compatibility: ${problems.length} violation(s)`);
    if (problems.length > 0) process.exitCode = 1;
  }
}
