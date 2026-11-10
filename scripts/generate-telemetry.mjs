import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  renderAliases,
  renderGo,
  renderMarkdown,
  renderRust,
  renderTypeScript,
  validateRegistry,
} from "./lib/telemetry-registry.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const REGISTRY_PATH = "contracts/observability/attributes.yaml";
const DOCUMENT_PATH = "docs/observability-contract.md";
const DOCUMENT_START = "<!-- observability-registry:start -->";
const DOCUMENT_END = "<!-- observability-registry:end -->";

const RENDERERS = {
  go: renderGo,
  typescript: renderTypeScript,
  rust: renderRust,
  aliases: renderAliases,
};

const SERVICE_OUTPUTS = {
  shared: [
    {
      language: "go",
      path: "libs/go/telemetry/semconv_gen.go",
    },
    {
      language: "aliases",
      path: "tests/e2e/observability/aliases.gen.json",
    },
  ],
  "agent-acp-service": [
    {
      language: "typescript",
      path: "services/agent-acp-service/src/telemetry/semconv.gen.ts",
    },
  ],
  "agent-ui": [
    {
      language: "typescript",
      path: "services/agent-ui/web/server/src/semconv.gen.ts",
    },
  ],
  "runtime-egress": [
    {
      language: "rust",
      path: "services/runtime-egress/src/semconv.rs",
    },
  ],
  "antnest-runtime": [
    {
      language: "rust",
      path: "runtimes/antnest-runtime/src/semconv.rs",
    },
  ],
};

function serviceNames() {
  return Object.keys(SERVICE_OUTPUTS).filter((name) => name !== "shared");
}

function renderDocument(document, registry) {
  const start = document.indexOf(DOCUMENT_START);
  const end = document.indexOf(DOCUMENT_END);
  if (start === -1 || end === -1 || end < start + DOCUMENT_START.length)
    throw new Error(`${DOCUMENT_PATH} is missing registry markers`);
  return `${document.slice(0, start + DOCUMENT_START.length)}\n${renderMarkdown(registry)}${document.slice(end)}`;
}

function checkShared(registry) {
  const problems = checkServices(registry, ["shared"], true);
  const documentPath = join(root, DOCUMENT_PATH);
  if (!existsSync(documentPath)) {
    problems.push(`${DOCUMENT_PATH} is missing`);
  } else {
    try {
      const document = readFileSync(documentPath, "utf8");
      if (document !== renderDocument(document, registry))
        problems.push(
          `${DOCUMENT_PATH} registry table is stale; run scripts/generate-telemetry.mjs --service shared`,
        );
    } catch (error) {
      problems.push(error.message);
    }
  }
  return problems;
}

function checkServices(registry, names, required) {
  const problems = [];
  for (const name of names) {
    for (const output of SERVICE_OUTPUTS[name]) {
      const path = join(root, output.path);
      if (!existsSync(path)) {
        if (required)
          problems.push(
            `${output.path} is missing; run scripts/generate-telemetry.mjs --service ${name}`,
          );
        continue;
      }
      if (readFileSync(path, "utf8") !== RENDERERS[output.language](registry))
        problems.push(
          `${output.path} is stale; run scripts/generate-telemetry.mjs --service ${name}`,
        );
    }
  }
  return problems;
}

function writeOutput(output, registry) {
  const path = join(root, output.path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, RENDERERS[output.language](registry));
  console.log(`wrote ${output.path}`);
}

function generateShared(registry) {
  for (const output of SERVICE_OUTPUTS.shared) writeOutput(output, registry);
  const documentPath = join(root, DOCUMENT_PATH);
  writeFileSync(
    documentPath,
    renderDocument(readFileSync(documentPath, "utf8"), registry),
  );
  console.log(`wrote ${DOCUMENT_PATH}`);
}

function generateService(name, registry, onlyExisting) {
  for (const output of SERVICE_OUTPUTS[name]) {
    if (onlyExisting && !existsSync(join(root, output.path))) continue;
    writeOutput(output, registry);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const all = args.includes("--all");
  let service;
  let serviceFlag = false;
  const problems = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--check" || args[index] === "--all") continue;
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
  if (!check && !all && !serviceFlag)
    problems.push(
      "usage: generate-telemetry.mjs --check [--service <name>] | --service <name> | --all",
    );
  else if (serviceFlag && service === undefined)
    problems.push("--service needs a service name");
  else if (service !== undefined && SERVICE_OUTPUTS[service] === undefined)
    problems.push(`unknown service ${JSON.stringify(service)}`);
  else if (all && (serviceFlag || check))
    problems.push("--all cannot be combined with --service or --check");
  let registry;
  try {
    registry = JSON.parse(readFileSync(join(root, REGISTRY_PATH), "utf8"));
  } catch (error) {
    problems.push(`${REGISTRY_PATH}: ${error.message}`);
  }
  if (problems.length === 0) problems.push(...validateRegistry(registry));
  if (problems.length === 0) {
    try {
      if (check) {
        problems.push(...checkShared(registry));
        const checked =
          service === undefined
            ? serviceNames()
            : service === "shared"
              ? []
              : [service];
        problems.push(
          ...checkServices(registry, checked, service !== undefined),
        );
      } else if (all) {
        generateShared(registry);
        for (const name of serviceNames())
          generateService(name, registry, true);
      } else if (service === "shared") {
        generateShared(registry);
      } else {
        generateService(service, registry, false);
      }
    } catch (error) {
      problems.push(error.message);
    }
  }
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) process.exitCode = 1;
  else if (check) console.log("telemetry registry outputs are consistent");
}
