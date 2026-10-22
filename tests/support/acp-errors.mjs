import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function readCatalog() {
  try {
    return readFileSync(
      new URL("../../dist/contracts/agent-acp/errors.json", import.meta.url),
      "utf8",
    );
  } catch (error) {
    if (!(error instanceof Error) || error.code !== "ENOENT") throw error;
  }
  return readFileSync(
    new URL("../../contracts/agent-acp/errors.json", import.meta.url),
    "utf8",
  );
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The shared contract gate owns complete schema validation.
function isCatalog(value) {
  return (
    isRecord(value) &&
    value.schema_version === 1 &&
    isRecord(value.capability) &&
    value.capability.name === "antnest.dev/errors" &&
    value.capability.version === 1 &&
    isRecord(value.errors) &&
    Object.keys(value.errors).length > 0 &&
    isRecord(value.fallback)
  );
}

const catalog = JSON.parse(readCatalog());
if (!isCatalog(catalog)) throw new Error("Unsupported ACP error catalog");

export function assertErrorCapability(initializeResult) {
  assert(isRecord(initializeResult), "ACP initialize result is required");
  const meta = initializeResult._meta;
  assert(
    isRecord(meta),
    "ACP initialize result must declare errors capability",
  );
  assert(
    Object.hasOwn(meta, catalog.capability.name),
    "ACP initialize result must declare errors capability",
  );
  const capability = meta[catalog.capability.name];
  assert(isRecord(capability), "ACP errors capability must be an object");
  assert.equal(
    capability.version,
    catalog.capability.version,
    "Unsupported ACP errors capability version",
  );
}

export function admissionErrorReceipt(expectedCode) {
  assert.equal(
    typeof expectedCode,
    "string",
    "Expected ACP error code is required",
  );
  assert(
    Object.hasOwn(catalog.errors, expectedCode),
    "Expected ACP error code is not registered",
  );
  const entry = catalog.errors[expectedCode];
  assert(isRecord(entry), "Invalid ACP error catalog entry");
  assert(
    Array.isArray(entry.surfaces) && entry.surfaces.includes("admission"),
    "Expected ACP error code is not an admission error",
  );
  assert(
    Number.isInteger(entry.json_rpc_code),
    "Admission errors require a numeric JSON-RPC code",
  );
  assert.equal(typeof entry.message, "string", "Invalid ACP error message");
  assert.equal(
    typeof entry.retryable,
    "boolean",
    "Invalid ACP retryable value",
  );
  return {
    code: entry.json_rpc_code,
    message: entry.message,
    data: {
      code: expectedCode,
      retryable: entry.retryable,
      ...(Object.hasOwn(entry, "retry_after_ms")
        ? { retry_after_ms: entry.retry_after_ms }
        : {}),
    },
  };
}

export function assertAdmissionError(actual, expectedCode) {
  const expected = admissionErrorReceipt(expectedCode);
  assert(isRecord(actual), "ACP admission error receipt is required");
  assert.equal(
    actual.code,
    expected.code,
    "Unexpected ACP JSON-RPC error code",
  );
  assert.equal(
    actual.message,
    expected.message,
    "Unexpected ACP public error message",
  );
  assert(isRecord(actual.data), "ACP admission error data is required");
  const expectedData = { ...expected.data };
  if (Object.hasOwn(actual.data, "details")) {
    assert(
      isRecord(actual.data.details),
      "ACP error details must be an empty object",
    );
    assert.equal(
      Reflect.ownKeys(actual.data.details).length,
      0,
      "ACP error details must be an empty object",
    );
    expectedData.details = {};
  }
  assert(
    Reflect.ownKeys(actual.data).every(
      (key) => typeof key === "string" && Object.hasOwn(expectedData, key),
    ),
    "ACP error data contains an unapproved field",
  );
  assert.deepEqual(
    actual.data,
    expectedData,
    "Unexpected ACP admission error data",
  );
}
