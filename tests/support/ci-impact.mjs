// Contract ownership registration and static impact analysis for the CI
// selector. tests/support/ci-ownership.json lists, per contracts/ directory,
// the producing service first and every declared consumer after it.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

export function ownership(base = root) {
  return JSON.parse(
    readFileSync(join(base, "tests/support/ci-ownership.json"), "utf8"),
  );
}

function contractDirectories(base) {
  return readdirSync(join(base, "contracts"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function knownServices(base) {
  const services = new Set(readdirSync(join(base, "services")));
  if (existsSync(join(base, "runtimes/antnest-runtime")))
    services.add("antnest-runtime");
  return services;
}

// Every contracts/ directory must be registered: producer first, nonempty
// known service list, callers.json producer and internal callers covered.
export function validateOwnership(base = root) {
  let map;
  try {
    map = ownership(base);
  } catch (error) {
    return [`tests/support/ci-ownership.json: ${error.message}`];
  }
  const problems = [];
  const known = knownServices(base);
  for (const dir of contractDirectories(base)) {
    const services = map[dir];
    if (!Array.isArray(services)) {
      problems.push(
        `contracts/${dir} is not registered in tests/support/ci-ownership.json`,
      );
      continue;
    }
    if (services.length === 0) {
      problems.push(`contracts/${dir} has no owning service`);
      continue;
    }
    for (const service of services)
      if (!known.has(service))
        problems.push(`contracts/${dir} names unknown service ${service}`);
    const callersPath = join(base, "contracts", dir, "callers.json");
    if (!existsSync(callersPath)) continue;
    const callers = JSON.parse(readFileSync(callersPath, "utf8"));
    if (callers.service && callers.service !== services[0])
      problems.push(
        `contracts/${dir} producer ${services[0]} does not match callers.json service ${callers.service}`,
      );
    for (const [route, meta] of Object.entries(callers.routes ?? {}))
      for (const caller of meta.callers ?? [])
        if (known.has(caller) && !services.includes(caller))
          problems.push(
            `contracts/${dir} caller ${caller} (${route}) is not a declared consumer`,
          );
  }
  return problems;
}

// A change under a registered contract expands to the repository paths its
// owning services cover, so selection follows declared consumers instead of
// every suite. Files directly under contracts/ keep the global selection.
export function contractMarkers(file, map = ownership()) {
  const rest = file.slice("contracts/".length);
  if (!rest.includes("/")) return null;
  const dir = rest.split("/")[0];
  if (!Object.hasOwn(map, dir)) throw new Error(`unknown contract ${dir}`);
  return map[dir].map((service) =>
    service === "antnest-runtime"
      ? "runtimes/antnest-runtime/"
      : `services/${service}/`,
  );
}

// Literal references a changed helper relies on: JS/TS imports, require(),
// new URL(relative, import.meta.url), and repository paths written into
// JS, shell or Makefile commands.
const repositoryPath =
  /(?<![\w./-])((?:contracts|deploy|modules|runtimes|scripts|services|tests)\/[\w./@%+-]*[\w@%+-])/gu;

export function extractReferences(text, fromPath) {
  const found = new Set();
  const fromDir = posix.dirname(fromPath);
  const add = (specifier) => {
    if (typeof specifier !== "string") return;
    let path = specifier;
    if (path.startsWith("./") || path.startsWith("../"))
      path = posix.normalize(posix.join(fromDir, path));
    else if (
      !/^(?:contracts|deploy|modules|runtimes|scripts|services|tests)\//u.test(
        path,
      )
    )
      return;
    path = path.replace(/\.+$/u, "");
    if (path === "" || path.startsWith("../") || posix.isAbsolute(path)) return;
    found.add(path);
  };
  for (const match of text.matchAll(
    /(?:from|import|require)\s*\(?\s*["']([^"']+)["']/gu,
  ))
    add(match[1]);
  for (const match of text.matchAll(
    /new URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url/gu,
  ))
    add(match[1]);
  for (const match of text.matchAll(repositoryPath)) add(match[1]);
  return found;
}

// Reverse index: referenced repository path -> files that name it. Targets
// need not exist, so references to removed helpers still resolve.
export function buildDependents(listFiles, readFile) {
  const dependents = new Map();
  for (const path of listFiles) {
    let text;
    try {
      text = readFile(path);
    } catch {
      continue;
    }
    if (typeof text !== "string") continue;
    for (const reference of extractReferences(text, path)) {
      if (reference === path) continue;
      if (!dependents.has(reference)) dependents.set(reference, new Set());
      dependents.get(reference).add(path);
    }
  }
  return dependents;
}

// Every file transitively referencing the start file. Terminal paths are
// recorded but never expanded, and cycles terminate on the visited set.
export function impactedPaths(start, dependents, terminal = () => false) {
  const result = new Set();
  const visited = new Set([start]);
  const queue = [...(dependents.get(start) ?? [])];
  while (queue.length > 0) {
    const path = queue.shift();
    if (visited.has(path)) continue;
    visited.add(path);
    result.add(path);
    if (terminal(path)) continue;
    queue.push(...(dependents.get(path) ?? []));
  }
  return result;
}

// Known components are the deployable services plus the Runtime; unit jobs
// in integration.yml are named unit-<component>.
export function components(base = root) {
  return [...knownServices(base)].sort();
}

const serviceTestDir = /^tests\/integration\/(?:go\/)?([\w-]+)\//u;

const componentPath = (file) =>
  /^services\/([\w-]+)\//u.exec(file)?.[1] ??
  serviceTestDir.exec(file)?.[1] ??
  (file.startsWith("runtimes/antnest-runtime/")
    ? "antnest-runtime"
    : undefined);

let sourceDependents;
function referenceGraph(sources) {
  if (sources) return buildDependents(sources.list(), sources.read);
  sourceDependents ??= buildDependents(
    execFileSync("git", ["ls-files", "-z"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\0")
      .filter(Boolean),
    (path) => readFileSync(join(root, path), "utf8"),
  );
  return sourceDependents;
}

// The component names a change set exercises, sorted. Service code and its
// tests select only their own component; contracts expand through declared
// ownership; shared modules and repository-wide inputs stay conservative.
export function selectComponents(files, { all = false, sources } = {}) {
  const known = new Set(components());
  if (all) return [...known].sort();
  const selected = new Set();
  const allNow = () => {
    for (const name of known) selected.add(name);
  };
  const helperTest =
    /(?:^|\/)(?:test_[^/]*\.py|[^/]*_test\.go|[^/]*\.test\.[^./]+)$/iu;
  const workflowService = /^\.github\/workflows\/([\w-]+)\.yml$/u;
  for (const file of files) {
    if (file === "services/agent-acp-service/package-lock.json")
      selected.add("agent-ui");
    if (file === "tests/integration/skill-registry/package-rules-v1.json")
      selected.add("antnest-runtime");
    if (file.startsWith("contracts/")) {
      const markers = contractMarkers(file);
      if (markers === null) allNow();
      else
        for (const marker of markers) {
          const owner = componentPath(marker);
          if (known.has(owner)) selected.add(owner);
        }
      continue;
    }
    if (/\.md$/iu.test(file) && !file.startsWith("tests/")) continue;
    const direct = componentPath(file);
    if (known.has(direct)) {
      selected.add(direct);
      continue;
    }
    // Service workflows never run the root Makefile; its suites narrow by
    // target in ci-changes.mjs.
    if (helperTest.test(file) || file === "LICENSE" || file === "Makefile")
      continue;
    const owned = workflowService.exec(file)?.[1];
    if (owned) {
      const service = owned === "runtime" ? "antnest-runtime" : owned;
      if (known.has(service)) selected.add(service);
      else allNow();
      continue;
    }
    if (
      file === ".nvmrc" ||
      file === ".dockerignore" ||
      file === "go.work" ||
      file === "go.work.sum" ||
      file === ".golangci.yml" ||
      file === "tests/support/ci-ownership.json" ||
      file.startsWith(".github/")
    ) {
      allNow();
      continue;
    }
    if (
      file.startsWith("modules/runtime-tunnel/") ||
      file === "rust-toolchain.toml"
    ) {
      selected.add("runtime-egress");
      selected.add("antnest-runtime");
      continue;
    }
    if (file.startsWith("modules/")) {
      allNow();
      continue;
    }
    if (
      /^(?:services|runtimes|tests|scripts)\//u.test(file) &&
      /\.(?:mjs|cjs|js|ts|mts|cts|jsx|tsx|sh|go|rs|py|json|ya?ml)$/iu.test(file)
    ) {
      const deps = referenceGraph(sources);
      const reached = impactedPaths(file, deps);
      const owners = new Set();
      for (const path of reached) {
        const service = componentPath(path);
        if (service && known.has(service)) owners.add(service);
      }
      if (owners.size > 0) {
        for (const owner of owners) selected.add(owner);
        continue;
      }
      allNow();
      continue;
    }
    if (!file.startsWith("docs/")) allNow();
  }
  return [...selected].sort();
}

const targetLine = /^([A-Za-z0-9][\w.-]*)\s*:(?!\s*=)/u;
const targetName = /^[A-Za-z0-9][\w.-]*$/u;
const recursiveMake =
  /(?:^|[\s;&|(])(?:make|\$\(MAKE\))\s+([A-Za-z0-9][\w.-]*)/gu;
// Blank lines, comments and .PHONY declarations change no recipe.
const inert = (line) =>
  line === undefined ||
  line.trim() === "" ||
  line.trimStart().startsWith("#") ||
  /^\.PHONY\s*:/u.test(line);

// The targets each Makefile target reaches directly: its prerequisites and
// the targets its recipe runs through make or $(MAKE).
export function makefileGraph(text) {
  const graph = new Map();
  let current = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("\t")) {
      if (current)
        for (const [, target] of line.matchAll(recursiveMake))
          graph.get(current).add(target);
      continue;
    }
    const header = /^([A-Za-z0-9][\w.-]*)\s*:(?!\s*=)(.*)$/u.exec(line);
    if (header) {
      current = header[1];
      if (!graph.has(current)) graph.set(current, new Set());
      for (const prerequisite of header[2].split(/\s+/u))
        if (targetName.test(prerequisite)) graph.get(current).add(prerequisite);
      continue;
    }
    // Any other top-level line, .PHONY included, ends the recipe.
    if (line.trim() !== "" && !line.trimStart().startsWith("#")) current = null;
  }
  return graph;
}

// The make targets a command runs, followed through every graph.
export function makeTargetsRun(commands, graphs) {
  const reached = new Set();
  const pending = commands.flatMap((command) =>
    [...command.matchAll(recursiveMake)].map(([, target]) => target),
  );
  while (pending.length > 0) {
    const target = pending.pop();
    if (reached.has(target)) continue;
    reached.add(target);
    for (const graph of graphs) pending.push(...(graph.get(target) ?? []));
  }
  return reached;
}

// The Makefile targets whose recipe lines a diff touched, or null when a
// change cannot be attributed to named targets and callers must stay
// conservative. Blank, comment and .PHONY lines are attributed to none.
export function makefileTargets(base, head, git = execFileSync) {
  const diff = git(
    "git",
    ["diff", "--unified=0", `${base}...${head}`, "--", "Makefile"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const blobs = new Map();
  const blob = (revision) => {
    if (!blobs.has(revision))
      blobs.set(
        revision,
        git("git", ["show", `${revision}:Makefile`], {
          encoding: "utf8",
        }).split("\n"),
      );
    return blobs.get(revision);
  };
  const owner = (revision, line) => {
    const lines = blob(revision);
    for (let index = Math.min(line, lines.length) - 1; index >= 0; index--) {
      const match = targetLine.exec(lines[index]);
      if (match) return match[1];
      if (!lines[index].startsWith("\t") && lines[index].trim() !== "")
        return null;
    }
    return null;
  };
  const changed = new Set();
  for (const match of diff.matchAll(
    /@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gu,
  )) {
    const [, baseStart, baseCount = "1", headStart, headCount = "1"] = match;
    if (Number(baseCount) > 0)
      for (
        let line = Number(baseStart);
        line < Number(baseStart) + Number(baseCount);
        line++
      ) {
        if (inert(blob(base)[line - 1])) continue;
        const target = owner(base, line);
        if (target === null) return null;
        changed.add(target);
      }
    if (Number(headCount) > 0)
      for (
        let line = Number(headStart);
        line < Number(headStart) + Number(headCount);
        line++
      ) {
        if (inert(blob(head)[line - 1])) continue;
        const target = owner(head, line);
        if (target === null) return null;
        changed.add(target);
      }
  }
  return changed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--check") {
    const problems = validateOwnership();
    for (const problem of problems) console.error(problem);
    if (problems.length > 0) process.exit(1);
    console.log("contract ownership registered");
  } else {
    console.error("usage: ci-impact.mjs --check");
    process.exit(2);
  }
}
