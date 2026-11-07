import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadContracts } from "../../../scripts/check-contract-conventions.mjs";

const require = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { Ajv2020 } = require("ajv/dist/2020.js");

const CANONICAL_BASE = "https://schemas.antnest.dev/";
const contractsRoot = new URL("../../../contracts/", import.meta.url);
const contractsDir = fileURLToPath(contractsRoot);
const manifestFile = fileURLToPath(
  new URL("../../../contracts/golden-manifest.json", import.meta.url),
);

const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function withFutureFields(value) {
  if (Array.isArray(value)) return value.map(withFutureFields);
  if (isObject(value)) {
    const enriched = {};
    for (const [key, entry] of Object.entries(value))
      enriched[key] = withFutureFields(entry);
    enriched.x_future_field = 1;
    return enriched;
  }
  return value;
}

function safeSegment(value, kind) {
  if (
    typeof value !== "string" ||
    value === "" ||
    value === "." ||
    value.includes("..") ||
    value.includes("/") ||
    value.includes("\\")
  )
    throw new Error(`unsafe golden ${kind}: ${JSON.stringify(value)}`);
  return value;
}

export function loadGolden(area, filename) {
  const dir = resolve(contractsDir, safeSegment(area, "area"), "examples");
  const file = resolve(dir, safeSegment(filename, "filename"));
  if (!file.startsWith(dir + sep))
    throw new Error(
      `golden filename escapes ${dir}: ${JSON.stringify(filename)}`,
    );
  return JSON.parse(readFileSync(file, "utf8"));
}

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (isObject(value))
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, entry]) => [key, sorted(entry)])
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  return value;
}

function jsonEqual(a, b) {
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((entry, index) => jsonEqual(entry, b[index]))
    );
  if (isObject(a) || isObject(b)) {
    if (!isObject(a) || !isObject(b)) return false;
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    return (
      aKeys.length === bKeys.length &&
      aKeys.every((key) => key in b && jsonEqual(a[key], b[key]))
    );
  }
  return Object.is(a, b);
}

export function assertGolden(pathOrURL, actual, { update = false } = {}) {
  const file = pathOrURL instanceof URL ? fileURLToPath(pathOrURL) : pathOrURL;
  let expected;
  let readable = false;
  try {
    expected = JSON.parse(readFileSync(file, "utf8"));
    readable = true;
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  if (readable && jsonEqual(expected, actual)) return;
  if (!update) {
    if (!readable)
      assert.fail(`golden document missing or unreadable: ${file}`);
    assert.deepEqual(sorted(actual), sorted(expected));
  }
  writeFileSync(file, `${JSON.stringify(sorted(actual), null, 2)}\n`);
}

let registryPromise;

function registry() {
  registryPromise ??= (async () => {
    const ajv = new Ajv2020({
      strict: false,
      allErrors: true,
      validateFormats: false,
    });
    const documents = await loadContracts(contractsRoot);
    const apiDir = fileURLToPath(
      new URL("../../../services/runtime-controller/api/", import.meta.url),
    );
    if (existsSync(apiDir))
      for (const name of readdirSync(apiDir)) {
        if (!name.endsWith(".schema.json")) continue;
        documents.set(
          `runtime-controller/${name}`,
          JSON.parse(readFileSync(resolve(apiDir, name), "utf8")),
        );
      }
    for (const [key, document] of documents) {
      const schemaLike =
        key.endsWith(".schema.json") ||
        (isObject(document) && "$schema" in document);
      if (
        !schemaLike ||
        !isObject(document) ||
        typeof document.$id !== "string"
      )
        continue;
      ajv.addSchema(document);
    }
    return ajv;
  })();
  return registryPromise;
}

export async function validateGolden(schemaRef, value) {
  const ajv = await registry();
  const validate =
    ajv.getSchema(schemaRef) ?? ajv.getSchema(`${CANONICAL_BASE}${schemaRef}`);
  if (validate === undefined)
    throw new Error(`unregistered golden schema ${JSON.stringify(schemaRef)}`);
  if (validate(value)) return true;
  throw new Error(
    `golden document violates ${schemaRef}: ${ajv.errorsText(validate.errors)}`,
  );
}

export function readManifest() {
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  if (!Array.isArray(manifest))
    throw new Error(`golden manifest is not an array: ${manifestFile}`);
  return manifest;
}
