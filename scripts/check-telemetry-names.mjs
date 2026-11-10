import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  entrySymbol,
  pascalSymbol,
  restrictedMetricAttribute,
  validateRegistry,
} from "./lib/telemetry-registry.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const REGISTRY_PATH = "contracts/observability/attributes.yaml";
const GENERATED_PATHS = new Set([
  "libs/go/telemetry/semconv_gen.go",
  "services/agent-acp-service/src/telemetry/semconv.gen.ts",
  "services/agent-ui/web/server/src/semconv.gen.ts",
  "services/runtime-egress/src/semconv.rs",
  "runtimes/antnest-runtime/src/semconv.rs",
]);
const TEST_SEGMENTS = new Set(["test", "tests"]);
const RUST_TEST_MARKER = "#[cfg(test)]";
const SERVICE_SOURCES = {
  "admin-console": "services/admin-console",
  "agent-acp-service": "services/agent-acp-service",
  "agent-controller": "services/agent-controller",
  "agent-ui": "services/agent-ui",
  "antnest-runtime": "runtimes/antnest-runtime",
  "edge-gateway": "services/edge-gateway",
  "identity-service": "services/identity-service",
  "runtime-controller": "services/runtime-controller",
  "runtime-egress": "services/runtime-egress",
  "skill-registry": "services/skill-registry",
};
const SOURCE_EXTENSIONS = new Set([".go", ".ts", ".rs"]);
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".cache",
  "build",
  "dist",
  "node_modules",
  "target",
]);

const LEXERS = {
  go: {
    quotes: new Set(['"', "'", "`"]),
    escapes: new Set(['"', "'"]),
    rawStrings: false,
    nestedBlocks: false,
    charLiteral: false,
  },
  typescript: {
    quotes: new Set(['"', "'", "`"]),
    escapes: new Set(['"', "'", "`"]),
    rawStrings: false,
    nestedBlocks: false,
    charLiteral: false,
  },
  rust: {
    quotes: new Set(['"']),
    escapes: new Set(['"']),
    rawStrings: true,
    nestedBlocks: true,
    charLiteral: true,
  },
};

const LANGUAGE = (path) =>
  extname(path) === ".go"
    ? "go"
    : extname(path) === ".rs"
      ? "rust"
      : "typescript";

const GO_LABEL_CALL = /\bmetric\.WithAttributes\s*\(/g;
const TS_LABEL_CALL = /\.(?:add|record|observe)\s*\(/g;
const RUST_LABEL_CALL = /\.(?:add|record)\s*\(/g;
const GO_SYMBOL = /\bsemconv\.([A-Z][A-Za-z0-9]*)\b/g;
const TS_SYMBOL = /\bSEMCONV\.([A-Z][A-Z0-9_]*)\b/g;
const RUST_SYMBOL = /\bsemconv::([A-Z][A-Z0-9_]*)\b/g;

function lexSource(source, config) {
  const code = source.split("");
  const strings = [];
  const blank = (from, to) => {
    for (let index = from; index < to; index++)
      if (code[index] !== "\n") code[index] = " ";
  };
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === "/" && source[index + 1] === "/") {
      const start = index;
      while (index < source.length && source[index] !== "\n") index++;
      blank(start, index);
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const start = index;
      index += 2;
      let depth = 1;
      while (index < source.length && depth > 0) {
        if (
          config.nestedBlocks &&
          source[index] === "/" &&
          source[index + 1] === "*"
        ) {
          depth++;
          index += 2;
          continue;
        }
        if (source[index] === "*" && source[index + 1] === "/") {
          depth--;
          index += 2;
          continue;
        }
        index++;
      }
      blank(start, index);
      continue;
    }
    if (config.rawStrings && char === "r") {
      let cursor = index + 1;
      while (source[cursor] === "#") cursor++;
      if (
        source[cursor] === '"' &&
        (cursor > index + 1 || source[index + 1] === '"')
      ) {
        const hashes = cursor - (index + 1);
        const closer = '"' + "#".repeat(hashes);
        const contentStart = cursor + 1;
        let end = contentStart;
        while (end < source.length && !source.startsWith(closer, end)) end++;
        const tokenEnd = Math.min(end + closer.length, source.length);
        strings.push({
          start: index,
          inner: source.slice(contentStart, end),
        });
        blank(index, tokenEnd);
        index = tokenEnd;
        continue;
      }
      index++;
      continue;
    }
    if (config.charLiteral && char === "'") {
      const rest = source.slice(index + 1, index + 13);
      const literal = /^([^'\n\\]|\\(?:u\{[0-9a-fA-F]+\}|.))'/.exec(rest);
      if (literal !== null) {
        blank(index, index + 1 + literal[0].length);
        index += 1 + literal[0].length;
        continue;
      }
      index++;
      continue;
    }
    if (config.quotes.has(char)) {
      const start = index;
      const escaped = config.escapes.has(char);
      index++;
      while (index < source.length && source[index] !== char) {
        if (escaped && source[index] === "\\") index++;
        index++;
      }
      const contentEnd = Math.min(index, source.length);
      const tokenEnd = Math.min(index + 1, source.length);
      strings.push({
        start,
        inner: source.slice(start + 1, contentEnd),
      });
      blank(start, tokenEnd);
      index = tokenEnd;
      continue;
    }
    index++;
  }
  return { code: code.join(""), strings };
}

function lineLocator(source) {
  const starts = [0];
  for (let index = 0; index < source.length; index++)
    if (source[index] === "\n") starts.push(index + 1);
  return (position) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (starts[middle] <= position) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
}

function matchParen(code, open) {
  let depth = 0;
  for (let index = open; index < code.length; index++) {
    if (code[index] === "(") depth++;
    else if (code[index] === ")") {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function splitArguments(code, start, end) {
  const ranges = [];
  let depth = 0;
  let argument = start;
  for (let index = start; index < end; index++) {
    const char = code[index];
    if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") depth--;
    else if (char === "," && depth === 0) {
      ranges.push([argument, index]);
      argument = index + 1;
    }
  }
  ranges.push([argument, end]);
  return ranges;
}

function symbolMaps(registry) {
  const byUpper = new Map();
  const byPascal = new Map();
  for (const entry of registry.attributes ?? []) {
    byUpper.set(entrySymbol(entry), entry);
    byPascal.set(pascalSymbol(entrySymbol(entry)), entry);
  }
  return { byUpper, byPascal };
}

function labelProblems(code, lineAt, path, registry, language) {
  const problems = [];
  const restricted = new Set(
    (registry.attributes ?? [])
      .filter(restrictedMetricAttribute)
      .map((entry) => entry.name),
  );
  const { byUpper, byPascal } = symbolMaps(registry);
  const report = (position, entry) =>
    problems.push(
      `${path}:${lineAt(position)} restricted attribute ${entry.name} must not be a metric label`,
    );
  if (language === "go") {
    for (const call of code.matchAll(GO_LABEL_CALL)) {
      const open = call.index + call[0].length - 1;
      const close = matchParen(code, open);
      const region = code.slice(open, close === -1 ? undefined : close);
      for (const use of region.matchAll(GO_SYMBOL)) {
        const entry = byPascal.get(use[1]);
        if (entry !== undefined && restricted.has(entry.name))
          report(open + use.index, entry);
      }
    }
  } else if (language === "typescript") {
    for (const call of code.matchAll(TS_LABEL_CALL)) {
      const open = call.index + call[0].length - 1;
      const close = matchParen(code, open);
      if (close === -1) continue;
      const args = splitArguments(code, open + 1, close);
      if (args.length < 2) continue;
      const [start, end] = args[1];
      if (!/^\s*\{/.test(code.slice(start, end))) continue;
      const region = code.slice(start, end);
      for (const use of region.matchAll(TS_SYMBOL)) {
        const entry = byUpper.get(use[1]);
        if (entry !== undefined && restricted.has(entry.name))
          report(start + use.index, entry);
      }
    }
  } else {
    for (const call of code.matchAll(RUST_LABEL_CALL)) {
      const open = call.index + call[0].length - 1;
      const close = matchParen(code, open);
      if (close === -1) continue;
      const args = splitArguments(code, open + 1, close);
      for (const [start, end] of args.slice(1)) {
        const region = code.slice(start, end);
        for (const use of region.matchAll(RUST_SYMBOL)) {
          const entry = byUpper.get(use[1]);
          if (entry !== undefined && restricted.has(entry.name))
            report(start + use.index, entry);
        }
      }
    }
  }
  return problems;
}

const generatedPath = (path) =>
  GENERATED_PATHS.has(path.split(/[\\/]/).join("/"));

const testPath = (path) =>
  basename(path).includes(".test.") ||
  basename(path).endsWith("_test.go") ||
  path.split(/[\\/]/).some((segment) => TEST_SEGMENTS.has(segment));

export function checkTelemetrySource(source, path, registry) {
  const problems = [];
  if (generatedPath(path)) return problems;
  if (testPath(path)) return problems;
  const language = LANGUAGE(path);
  let working = source;
  if (language === "rust") {
    const marker = working.indexOf(RUST_TEST_MARKER);
    if (marker !== -1) working = working.slice(0, marker);
  }
  const { code, strings } = lexSource(working, LEXERS[language]);
  const lineAt = lineLocator(working);
  const exempt = new Set(Object.keys(registry.namespace_literals ?? {}));
  for (const token of strings) {
    if (!token.inner.startsWith("antnest.")) continue;
    if (exempt.has(token.inner)) continue;
    problems.push(
      `${path}:${lineAt(token.start)} literal ${JSON.stringify(token.inner)} must come from generated semconv constants`,
    );
  }
  problems.push(...labelProblems(code, lineAt, path, registry, language));
  return problems;
}

function collectSources(directory, base) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIPPED_DIRECTORIES.has(entry.name))
      continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectSources(path, base));
    else if (SOURCE_EXTENSIONS.has(extname(entry.name)))
      files.push(relative(base, path).split(sep).join("/"));
  }
  return files.sort();
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  const problems = [];
  let service;
  let serviceFlag = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--service") {
      serviceFlag = true;
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith("--")) {
        service = value;
        index++;
      }
      continue;
    }
    problems.push(`unknown argument ${JSON.stringify(args[index])}`);
  }
  if (serviceFlag && service === undefined)
    problems.push("--service needs a service name");
  else if (service !== undefined && SERVICE_SOURCES[service] === undefined)
    problems.push(`unknown service ${JSON.stringify(service)}`);
  let registry;
  try {
    registry = JSON.parse(readFileSync(join(root, REGISTRY_PATH), "utf8"));
  } catch (error) {
    problems.push(`${REGISTRY_PATH}: ${error.message}`);
  }
  if (problems.length === 0) {
    problems.push(...validateRegistry(registry));
    const services =
      service === undefined ? Object.keys(SERVICE_SOURCES) : [service];
    for (const name of services) {
      const directory = join(root, SERVICE_SOURCES[name]);
      if (!existsSync(directory)) continue;
      for (const path of collectSources(directory, root)) {
        const source = readFileSync(join(root, path), "utf8");
        problems.push(...checkTelemetrySource(source, path, registry));
      }
    }
  }
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) process.exitCode = 1;
  else console.log("telemetry name sources are clean");
}
