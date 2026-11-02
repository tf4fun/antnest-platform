import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = "@agentclientprotocol/sdk";
const SCHEMAS = {
  v1: `${PACKAGE}/schema/v1/schema.unstable.json`,
  v2: `${PACKAGE}/schema/v2/schema.unstable.json`,
};
const ENTRYPOINTS = {
  root: PACKAGE,
  "v1-unstable": `${PACKAGE}/unstable`,
  v2: `${PACKAGE}/experimental/v2`,
  "v2-unstable": `${PACKAGE}/experimental/v2/unstable`,
  "http-client": `${PACKAGE}/experimental/http-client`,
  "ws-client": `${PACKAGE}/experimental/ws-client`,
  server: `${PACKAGE}/experimental/server`,
  node: `${PACKAGE}/experimental/node`,
};
const FIELDS = ["sdkVersion", "exports", "runtimeExports", "schemaSha256"];
const BASELINE = new URL("../docs/acp-sdk-surface.json", import.meta.url);

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

export async function collectSdkSurface() {
  const schemaPaths = {};
  for (const [name, specifier] of Object.entries(SCHEMAS))
    schemaPaths[name] = fileURLToPath(import.meta.resolve(specifier));
  const packageRoot = dirname(dirname(dirname(schemaPaths.v1)));
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const runtimeExports = {};
  for (const [name, specifier] of Object.entries(ENTRYPOINTS))
    runtimeExports[name] = Object.keys(await import(specifier)).sort();
  return {
    sdkVersion: manifest.version,
    exports: manifest.exports,
    runtimeExports,
    schemaSha256: {
      v1: sha256(schemaPaths.v1),
      v2: sha256(schemaPaths.v2),
    },
  };
}

export function checkSdkSurface(actual, expected) {
  const problems = [];
  for (const field of FIELDS)
    if (JSON.stringify(canonical(actual?.[field])) !== JSON.stringify(canonical(expected?.[field])))
      problems.push(`SDK surface drift in ${field}`);
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    const actual = await collectSdkSurface();
    let expected;
    try {
      expected = JSON.parse(readFileSync(BASELINE, "utf8"));
    } catch {
      expected = undefined;
    }
    const problems =
      expected === undefined
        ? ["docs/acp-sdk-surface.json is missing or unreadable; regenerate it after review"]
        : checkSdkSurface(actual, expected);
    for (const problem of problems) console.error(problem);
    if (problems.length > 0) {
      console.error(
        "Review the @agentclientprotocol/sdk upgrade, then regenerate the baseline with node scripts/audit-sdk.mjs --write",
      );
      process.exitCode = 1;
    }
  } else if (args.length === 1 && args[0] === "--write") {
    writeFileSync(BASELINE, JSON.stringify(await collectSdkSurface(), null, 2) + "\n");
  } else {
    console.error(`unknown arguments: ${args.join(" ")}`);
    process.exitCode = 1;
  }
}
