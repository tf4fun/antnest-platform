import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const SHARED_MANIFEST = "tests/support/shared-versions.json";
const REQUIRED_PIN = "@agentclientprotocol/sdk";
const REQUIRED_PACKAGES = new Set([
  "services/agent-acp-service",
  "services/agent-ui/web",
]);
const GENERATED_TREES = new Set([
  "node_modules",
  ".git",
  ".cache",
  "artifacts",
  "dist",
  "target",
  "coverage",
]);
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const EXACT_PIN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

function enumeratePackages(root) {
  const manifests = [];
  const locks = [];
  const visit = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!GENERATED_TREES.has(entry.name))
          visit(join(directory, entry.name), name);
      } else if (entry.name === "package.json") manifests.push(name);
      else if (entry.name === "package-lock.json") locks.push(name);
    }
  };
  visit(root, "");
  manifests.sort();
  locks.sort();
  return { manifests, locks };
}

function readJSON(root, relativePath, problems) {
  let text;
  try {
    text = readFileSync(join(root, relativePath), "utf8");
  } catch {
    problems.push(`${relativePath}: file is missing or unreadable`);
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    problems.push(
      `${relativePath}: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
    return undefined;
  }
}

function sharedManifest(root, problems) {
  const document = readJSON(root, SHARED_MANIFEST, problems);
  if (document === undefined) return undefined;
  if (
    typeof document !== "object" ||
    document === null ||
    Array.isArray(document)
  ) {
    problems.push(
      `${SHARED_MANIFEST}: expected an object of exact version pins`,
    );
    return undefined;
  }
  const shared = {};
  let valid = true;
  for (const [name, pin] of Object.entries(document)) {
    if (typeof pin === "string" && EXACT_PIN.test(pin)) {
      shared[name] = pin;
      continue;
    }
    valid = false;
    problems.push(
      `${SHARED_MANIFEST}: ${name} must be an exact version pin, found ${JSON.stringify(pin)}`,
    );
  }
  if (valid && !Object.hasOwn(document, REQUIRED_PIN)) {
    valid = false;
    problems.push(
      `${SHARED_MANIFEST}: ${REQUIRED_PIN} must be pinned to an exact version`,
    );
  }
  return valid ? shared : undefined;
}

function sharedDeclarations(block, shared) {
  const declared = [];
  if (typeof block !== "object" || block === null) return declared;
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = block[field];
    if (typeof dependencies !== "object" || dependencies === null) continue;
    for (const name of Object.keys(shared))
      if (Object.hasOwn(dependencies, name))
        declared.push({ field, name, spec: dependencies[name] });
  }
  return declared;
}

function checkManifest(relativePath, document, shared, required, problems) {
  const declared = sharedDeclarations(document, shared);
  for (const { field, name, spec } of declared)
    if (spec !== shared[name])
      problems.push(
        `${relativePath}: ${field} ${name} is declared at ${JSON.stringify(spec)} but ${SHARED_MANIFEST} requires exactly ${shared[name]}`,
      );
  const present = new Set(declared.map(({ name }) => name));
  if (required && !present.has(REQUIRED_PIN))
    problems.push(
      `${relativePath}: ${REQUIRED_PIN} must be declared at exactly ${shared[REQUIRED_PIN]}`,
    );
}

function checkLock(relativePath, document, shared, required, problems) {
  if (
    typeof document !== "object" ||
    document === null ||
    document.lockfileVersion !== 3 ||
    typeof document.packages !== "object" ||
    document.packages === null
  ) {
    problems.push(
      `${relativePath}: expected an npm lockfileVersion 3 packages index`,
    );
    return;
  }
  const packages = document.packages;
  const declared = sharedDeclarations(packages[""], shared);
  for (const { field, name, spec } of declared)
    if (spec !== shared[name])
      problems.push(
        `${relativePath}: ${field} ${name} is declared at ${JSON.stringify(spec)} but ${SHARED_MANIFEST} requires exactly ${shared[name]}`,
      );
  const installed = new Set();
  for (const [path, entry] of Object.entries(packages))
    for (const name of Object.keys(shared)) {
      const suffix = `node_modules/${name}`;
      if (path !== suffix && !path.endsWith(`/${suffix}`)) continue;
      if (path === suffix) installed.add(name);
      const version =
        typeof entry === "object" && entry !== null ? entry.version : undefined;
      if (version !== shared[name])
        problems.push(
          `${relativePath}: ${path} resolves ${name} at ${JSON.stringify(version)} but ${SHARED_MANIFEST} requires exactly ${shared[name]}`,
        );
    }
  if (required) {
    const present = new Set(declared.map(({ name }) => name));
    if (!present.has(REQUIRED_PIN))
      problems.push(
        `${relativePath}: ${REQUIRED_PIN} must be declared at exactly ${shared[REQUIRED_PIN]}`,
      );
    if (!installed.has(REQUIRED_PIN))
      problems.push(
        `${relativePath}: node_modules/${REQUIRED_PIN} must resolve at exactly ${shared[REQUIRED_PIN]}`,
      );
  }
}

export function checkSharedVersions(root) {
  const problems = [];
  const shared = sharedManifest(root, problems);
  if (shared === undefined) return problems;
  const { manifests, locks } = enumeratePackages(root);
  for (const directory of REQUIRED_PACKAGES)
    for (const file of ["package.json", "package-lock.json"]) {
      const relativePath = `${directory}/${file}`;
      if (!existsSync(join(root, relativePath)))
        problems.push(`${relativePath}: required file is missing`);
    }
  for (const relativePath of manifests) {
    const document = readJSON(root, relativePath, problems);
    if (document === undefined) continue;
    checkManifest(
      relativePath,
      document,
      shared,
      REQUIRED_PACKAGES.has(relativePath.slice(0, -"/package.json".length)),
      problems,
    );
  }
  for (const relativePath of locks) {
    const document = readJSON(root, relativePath, problems);
    if (document === undefined) continue;
    checkLock(
      relativePath,
      document,
      shared,
      REQUIRED_PACKAGES.has(
        relativePath.slice(0, -"/package-lock.json".length),
      ),
      problems,
    );
  }
  return problems;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const problems = checkSharedVersions(root);
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) process.exitCode = 1;
}
