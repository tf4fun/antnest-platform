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

function readRegistry() {
  try {
    return readFileSync(
      new URL("../../dist/contracts/common/errors.json", import.meta.url),
      "utf8",
    );
  } catch (error) {
    if (!(error instanceof Error) || error.code !== "ENOENT") throw error;
  }
  return readFileSync(
    new URL("../../contracts/common/errors.json", import.meta.url),
    "utf8",
  );
}

const registry = new Map(
  JSON.parse(readRegistry()).errors.map((entry) => [entry.code, entry]),
);
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const COMMON_METADATA_KEYS = ["category", "message", "request_id"];

export function commonErrorEntry(code) {
  const entry = registry.get(code);
  assert(entry !== undefined, `Common error code is not registered: ${code}`);
  return entry;
}

export { SAFE_REQUEST_ID };

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

export function assertAdmissionErrorData(data, expectedCode, message) {
  const expected = admissionErrorReceipt(expectedCode);
  assert(isRecord(data), "ACP admission error data is required");
  const expectedData = { ...expected.data };
  const allowed = new Set([
    ...Object.keys(expectedData),
    ...COMMON_METADATA_KEYS,
    "details",
  ]);
  assert(
    Reflect.ownKeys(data).every(
      (key) => typeof key === "string" && allowed.has(key),
    ),
    "ACP error data contains an unapproved field",
  );
  const hasMetadata = COMMON_METADATA_KEYS.some((key) =>
    Object.hasOwn(data, key),
  );
  if (hasMetadata) {
    for (const key of COMMON_METADATA_KEYS)
      assert(
        Object.hasOwn(data, key),
        `ACP common error metadata requires ${key}`,
      );
    const entry = registry.get(expectedCode);
    assert(entry !== undefined, "Expected ACP error code is not registered");
    assert.equal(
      data.category,
      entry.category,
      "ACP common error category does not match registry metadata",
    );
    assert.equal(
      data.message,
      message ?? expected.message,
      "ACP common error data message must equal the public message",
    );
    assert(
      typeof data.request_id === "string" &&
        SAFE_REQUEST_ID.test(data.request_id),
      "ACP common error request_id is unsafe",
    );
  }
  if (Object.hasOwn(data, "details")) {
    assert(isRecord(data.details), "ACP error details must be an empty object");
    assert.equal(
      Reflect.ownKeys(data.details).length,
      0,
      "ACP error details must be an empty object",
    );
    expectedData.details = {};
  }
  for (const key of ["code", "retryable", "retry_after_ms"]) {
    if (Object.hasOwn(expectedData, key) || Object.hasOwn(data, key))
      assert.deepEqual(
        data[key],
        expectedData[key],
        `Unexpected ACP admission error data ${key}`,
      );
  }
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
  assertAdmissionErrorData(actual.data, expectedCode, actual.message);
}
